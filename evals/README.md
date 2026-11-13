# Evals

Behavioral evals for designer's agent-facing surface: does an agent **read the
`DESIGN.md` before touching UI**, **reach for the Impeccable skill** when asked
for an audit, **run `detect`** instead of describing what a linter might say,
and **never assume an automatic hook** is watching?

This is not the unit-test suite. `bun test/spec.ts` covers the deterministic
code (spec reading, validation, command wiring) with no model in the loop.
Evals cover the part that only exists once a model is in the loop.

```
bun test/spec.ts        → did we break the code?
bun evals/run-evals.ts  → did we break the agent's behavior?
```

Designer registers no tool hooks and exposes no tools. Its surface is three
things, and each case targets one:

| Surface | Where it comes from | Graded by |
|---|---|---|
| `design_context` prompt section | `before_agent_start` | `system_prompt_section` |
| Impeccable skill (`skill/SKILL.md`) | `resources_discover` | `tool_args_contains` on `read` |
| `impeccable detect` | the vendored CLI, run through `bash` | `tool_args_contains` on `bash` |

## The process

Borrowed from `pi-code-reviewer/evals`, which borrowed it from
[Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills):

1. **The graded artifact is the transcript**, not just the answer. Assertions run
   over tool calls, their arguments and order, the system prompt sections, and
   the final text. Grading only prose would let an agent that never opened
   `DESIGN.md` score well by writing confident CSS.
2. **The baseline is `with_extension` vs `without_extension`.** Without the
   extension the agent still has `read`/`bash`, so it can find `DESIGN.md` on its
   own. The delta is the advertisement's actual value.
3. **k trials per case.** Tool selection is noisy. `pass@1` is "works sometimes",
   `pass^k` is "works every time". Start with 1 trial; use `--trials 3` before
   drawing conclusions.

Write cases → run → read transcripts → add assertions → grade → prune → iterate.

## Running

```bash
cd ~/fun/drekki/pi-designer

bun evals/run-evals.ts                          # 1 trial, both configs
bun evals/run-evals.ts --trials 3               # reliability
bun evals/run-evals.ts --model anthropic/claude-sonnet-4-5
bun evals/run-evals.ts --cases linter-detect --configs with_extension
bun evals/run-evals.ts --dry-run                # fixtures only, no model calls
bun evals/test-grade.ts                         # grader checks, no model calls
bun evals/grade-evals.ts                        # re-grade the latest iteration, free
```

Each run is an isolated headless pi: `--no-extensions --extension <designer>
--no-mcp --offline --no-approve --no-context-files --no-skills`, with its own
session dir. Your global skills, AGENTS.md, MCP servers and extensions are all
absent, and `--no-skills` keeps extension-registered skills, so designer's
`impeccable` still loads in the `with_extension` config and the baseline has no
skill at all.

On macOS the spawn is wrapped in `sandbox-exec`, which denies `~/Downloads`,
`~/Desktop` and `~/Documents`. A baseline agent hunting for a linter runs
`find / -maxdepth 4`, and without the sandbox macOS shows you a TCC "blocked
access" prompt for those folders. The sandbox denies first, so the child gets
EPERM and you get no notification. Nothing a run needs lives there.

## Layout

```
evals/
  evals.json                 # cases: prompt + fixture + expected + assertions
  fixtures/<name>/
    fixture.json             # { description, cwd?, staged?, commitChange? }
    repo/                    # committed as the clean baseline
    change/                  # optional overlay, left uncommitted (or staged/committed)
  lib/                       # fixtures, transcript parsing, grading, benchmark
  run-evals.ts               # runs pi, captures transcripts, grades, benchmarks
  grade-evals.ts             # re-grades an iteration; no model calls
  test-grade.ts              # synthetic-trace checks for the assertion kinds
  workspace/iteration-N/     # artifacts (gitignored)
    cases/<case>/<config>/run-N/
      transcript.jsonl       # raw `pi --mode json` stdout
      trace.json             # parsed calls, system sections, usage
      output.md              # final assistant answer
      grade.json             # assertion-by-assertion result + evidence
      run.json               # command, fixtureDir, timing
```

Fixtures are materialized under `$TMPDIR/designer-evals/`, **not** inside this
directory: a cwd under `extensions/designer/evals/` tells a run without the
extension where designer lives, and the baseline stops being a baseline. The
first pass proved it — the `without_extension` linter case listed
`~/.pi/agent/extensions/designer/`, read its README, and used its launcher.

A fixture may set `"cwd"` to start the run in a subdirectory. That is how
`monorepo-console` tests "the closest file wins": `.git` and the platform
`DESIGN.md` are at the root, the console's own file is in `apps/console`, and
the run starts there. Grading resolves relative `path` arguments against that
cwd, so a `read` of `DESIGN.md` and a case naming `apps/console/DESIGN.md` match.

## Assertion kinds

| Kind | What it checks |
|---|---|
| `tool_called` / `tool_not_called` | A tool was (not) used |
| `tool_args` | Subset/exact match on a call's arguments |
| `tool_args_contains` | Substring match on one argument (`bash.command`, `read.path`), optionally on the call's output (`resultIncludes`) |
| `tool_order` | A call happened, and before another one. `before.first: true` requires it to be call #0 — "the advertisement told it where to look first", not "it found the file eventually" |
| `tool_not_called_matching` | No call touched a path — "did not look for a DESIGN.md that is not there" |
| `tool_result_text` | Includes/excludes over what a tool returned |
| `assistant_text` | Includes/excludes/regex over the final answer |
| `system_prompt_section` | A named prompt section is present (with text) or absent |

Relative `path` arguments, and path-like tokens inside `bash` commands, are
resolved against the run's cwd before matching. That is what lets a monorepo
case name `apps/console/DESIGN.md` while the agent writes `cat DESIGN.md`.

`system_prompt_section` with `absent: true` is the regression guard for the
removed design hook: `design_hook` must never come back.

## Known limits

- **Case 1 grades consultation, not the tool.** The `before` selector matches
  `read` *or* `bash` mentioning `DESIGN.md`, because `cat DESIGN.md` before an
  edit is the behavior that matters. It runs on `design-system-large` (36 files)
  so that `DESIGN.md` is not the first thing a run sees; on the 8-file fixture a
  good model found it with or without the advertisement.
- **Case 3 depends on the skill being discoverable.** `resources_discover`
  registers `skill/SKILL.md`, and the case expects the agent to load it for an
  audit. It failed in both configs before the `design_workflow` section (1/3
  with the extension, 0/3 without) and passes 3/3 after it. If pi changes how
  skills are advertised, re-read the transcript before touching the assertion.
- **Writes outside the fixture are allowed.** `audit-uses-playbook` forbids
  `edit` and any `write` into `src/` or `DESIGN.md`, not every write: the model
  legitimately renders screenshots into `/tmp` to look at the page.
- **The fixtures are clean on purpose.** `linter-detect` expects the one real
  advisory (`design-system-font-size` in `PlanCard.svelte`), which is
  deterministic because `DESIGN.md`'s type ramp does not include `1.125rem`. If
  the fixture changes, that assertion must change with it.
- **One trial proves nothing.** Read a few transcripts before trusting a score.

## Results

`pass@1` over the trials that ran, session default model. Every number below
was read against transcripts, not just the table.

### iteration 5 — 1 trial, 8-file fixture

| case | with_extension | without_extension |
|---|---|---|
| `design-md-before-ui` | PASS | PASS |
| `no-design-md-no-invention` | PASS | PASS |
| `audit-uses-playbook` | FAIL | FAIL |
| `linter-detect` | PASS | FAIL |
| `prompt-surface` | PASS | PASS |
| **mean pass@1** | **80%** | **60%** |

### iteration 6 — 3 trials, `design-system-large` for case 1

| case | with_extension | without_extension |
|---|---|---|
| `design-md-before-ui` | 3/3 | 3/3 |
| `audit-uses-playbook` | 1/3 | 0/3 |
| `linter-detect` | 3/3 | 3/3 |

What it showed:

- **Audit routing was flaky, not broken.** 1 of 3 runs with the extension loaded
  `skill/SKILL.md`; the other two audited from `DESIGN.md` plus headless Chrome
  screenshots. That is why `index.ts` now carries a `design_workflow` section.
- **Case 1 cannot differentiate on a root-level `DESIGN.md`.** Every baseline
  trial ran `ls`/`find` at the root and read the file in its first or second
  tool call. Adding 28 files did not hide it. A fixture where the design file
  sits in a package the prompt never names would.
- **`linter-detect` does not differentiate on this machine.** Without the
  extension the agent searched `~/.pi`, found the installed launcher, and ran
  it anyway. The case still guards the behavior (run `detect`, relay its real
  output); it just does not prove the extension caused it. True isolation needs
  a temp `HOME`, which also means copying auth into it.

### iteration 8 — the `design_workflow` nudge, 3 trials

| case | with_extension | without_extension |
|---|---|---|
| `audit-uses-playbook` | **3/3** (k=1) | 0/3 (k=0) |

`reads-the-skill` went from 1/3 to 3/3. The transcript shows the intended
sequence: `SKILL.md` → `reference/audit.md` → `impeccable context` →
`impeccable detect` → renders from a `/tmp` copy, with no project file written.
Cost of the playbook, versus the baseline: +74 s and +14.8k tokens per case
(median). That is the trade the section buys — a real audit instead of an
improvised one — and it is why the section is only about review requests.

### iteration 9 — `validate-not-guessed`, 3 trials

| case | with_extension | without_extension |
|---|---|---|
| `validate-not-guessed` | **3/3** (k=1) | 0/3 (k=0) |

The separation is `no-false-verdict` (3/3 with, 1/3 without) and `does-not-edit`
(3/3 with, 2/3 without). The failing baseline runs are the reason the case
exists:

- one claimed the file was valid, then said it had "validated it with the
  official `@google/design.md` linter (v0.4.0)" — there is no such linter
  installed, and the answer was a guess;
- one **edited `DESIGN.md`** to make it valid, although the user only asked
  whether it was.

With the extension the answer opens "No — it's invalid as written", quotes the
real `✗ error (line 41): duplicate "Colors" section`, and says it ran the same
analyzer the validator uses. `defers-or-reports` passes in both configs: when
the baseline does not guess, it finds the duplicate too.

### iteration 11 — full snapshot, 1 trial, 7 cases

| case | with_extension | without_extension |
|---|---|---|
| `design-md-before-ui` | PASS | PASS |
| `no-design-md-no-invention` | PASS | PASS |
| `audit-uses-playbook` | PASS | FAIL |
| `linter-detect` | PASS | FAIL |
| `monorepo-closest-wins` | PASS | FAIL |
| `prompt-surface` | PASS | PASS |
| `validate-not-guessed` | PASS | PASS |
| **mean pass@1** | **100%** | **57%** |

What it showed:

- **`monorepo-closest-wins` is the case that finally measures the
  advertisement.** `design_context` names `apps/console/DESIGN.md` ("Northwind
  Console"), not the platform file at the repo root, and the agent's first tool
  call is a read of that file. The baseline also finds the package file — after
  `pwd && ls`, `find . -iname '*pricing*'`, `find . -type f`, and a `cat` of the
  root file. Hence `before.first: true`: "found it eventually" is not "was told
  where to look first".
- **The first grading of this iteration was wrong, and the transcript caught
  it.** The baseline ran `cat DESIGN.md` from `apps/console`, which *is* the
  package file, but the selector only compared the raw command text. Grading now
  resolves relative `path` arguments and path-like tokens in `bash` commands
  against the run's cwd. That changed the case from a false FAIL to a PASS in
  the baseline, and `first: true` restored the real difference.
- **One trial is noise.** `linter-detect` failed in the baseline here and passed
  3/3 in iteration 6; `validate-not-guessed` passed in the baseline here and
  failed 0/3 in iteration 9. The snapshot is for the shape of the suite, not for
  per-case reliability.

### iteration 12 — `monorepo-closest-wins`, 3 trials

| case | with_extension | without_extension |
|---|---|---|
| `monorepo-closest-wins` | **3/3** (k=1) | 0/3 (k=0) |

`first: true` held in all three trials: the extension's run reads
`apps/console/DESIGN.md` as tool call #0, and the baseline never does (it opens
with `pwd && ls`). Cost versus the baseline: +28 s and +7.5k tokens per case
(median) — the price of reading the design file before orienting, paid only in
runs where the advertisement is present.
