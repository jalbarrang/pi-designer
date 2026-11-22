# pi-designer

A [pi](https://pi.dev) extension that owns the project's `DESIGN.md` and carries the
[Impeccable](https://impeccable.style) design guidance.

Design review is manual, like running a linter: nothing fires on an edit. You ask for it.

## Install

```bash
git clone https://github.com/jalbarrang/pi-designer
pi install ./pi-designer
```

The npm package (`@jalbarran/pi-designer`) is not published yet; the clone is the supported path today.

Then check for an older copy at `~/.pi/agent/extensions/designer` and remove it: two copies mean two
`design_context` sections and a duplicated `/designer` command.

Nothing else to install: the engine is TypeScript in this package and runs inside pi. No launcher, no
downloaded binary, no separate runtime.

## First run

```bash
/designer                   # which file is in play, its sections, tokens, spec verdict, engine version
/designer document          # no DESIGN.md yet: generate one from the code
/designer audit src/routes  # run a playbook against a target
```

## What it does

**Owns the design file.** `DESIGN.md` is [Google's format](https://github.com/google-labs-code/design.md) for
describing a design system to AI agents: YAML frontmatter carrying design tokens, then prose sections in a
fixed order.

- **Advertises** the resolved file in the system prompt as a `design_context` section: path, `name`, and a
  one-line summary. The contents never sit in context; the agent reads the file when a task needs it.
- **Validates on demand** against the spec, with errors, warnings, and notes drawn from what the spec actually
  mandates. The agent is told the check is yours to run: it may report an error it can see, but it must not
  claim the file conforms.
- **Reports spec errors once per session**, to you and never to the model. A broken design file is not the
  agent's task to fix.

**Runs nothing on edits.** No tool hooks are registered: editing a file never spawns the detector, never blocks
a write, and never pushes findings into a turn.

**Gives the model the engine.** One tool, `design_check`, answers four questions in process: `guide` returns
Impeccable's guidance by name, `context` says which design records the project has, `detect` returns the
detector's real findings over files, and `validate` returns the spec report for `DESIGN.md`. Without it an audit
could only describe what a linter might say, or ask you to run a command and paste the output back.

**Routes design review to the guidance.** A fixed `design_workflow` prompt section tells the agent to load the
router before answering a review, critique, audit, polish, or data-encoding question. A skill entry alone was not enough: 1 of 3
audit runs loaded it and the other two improvised a review from the design file and screenshots; with the
section it is 3 of 3 (see `evals/`). Audits in projects without a design file take the same route — the section
is independent of `design_context`.

**Carries Impeccable.** The text is a snapshot of Impeccable's Pi build
([pbakaus/impeccable](https://github.com/pbakaus/impeccable)) imported at the commit in `guidance/UPSTREAM.json`
and edited here since. It ships as data the tool serves, not as a skill: a playbook arrives as the router plus
its body, a cross-reference is a key rather than a path, and `/designer <playbook>` delivers one in a single
message.

## Commands

| Command | Behavior |
|---|---|
| `/designer` | Status: resolved file, `name`, sections, token references, spec verdict, engine version |
| `/designer validate [path]` | Full spec report, for the file in effect or any other `DESIGN.md` |
| `/designer detect [flags] [paths]` | Run the detector here, in process. `--json`, `--scope type`, `--scope layout` |
| `/designer doctor [--json] [--fix]` | Report drift in this project's Impeccable artifacts; `--fix` applies only the migrations that carry no decision |
| `/designer context` | What the project has: product and design records, visual implementation, platform, surface briefs |
| `/designer palette [--id S \| --from KEY]` | A brand seed and the composition guidance that goes with it |
| `/designer concept-seed [--scope …] [--from KEY]` | Deal a direction or surface round |
| `/designer surface-brief <path\|list\|read\|write>` | The surface brief for a target: read it, or write one from a body file |
| `/designer critique-storage <slug\|latest\|write\|trend\|close>` | Read and record critique snapshots; `write` takes `--meta` as JSON |
| `/designer build-phase <start\|status\|advance\|record\|scaffold\|note\|finish>` | The comp-led build's phase machine: its gates, its state, and what to do next |
| `/designer comp-spec --comp <png> …` | The comp's grid, measured spec, crops and plate prompts |
| `/designer font-match --measure\|--rank <region>` | Read a text region's type, and rank the faces that fit it |
| `/designer comp-diff --comp <png> --build <png>` | Score a capture against its comp, per region, and write the artifacts |
| `/designer <playbook> [target]` | Route to an Impeccable playbook, described next |

## Playbooks

About two dozen playbooks sit behind `/designer`. The ones used most:

| Playbook | What you get |
|---|---|
| `document` | Generate `DESIGN.md` from existing project code |
| `critique` | UX design review with heuristic scoring |
| `audit` | Technical quality checks: accessibility, performance, responsive. Add `--brief` for top findings only |
| `encode` | Data encoding: chart vs table, the right mark, honest axes, zero-value bars |
| `polish` | Final quality pass before shipping |
| `init` | Capture durable product context in `PRODUCT.md` |
| `live` | Pick elements in the browser and iterate on alternatives |

Everything else — `shape`, `extract`, `craft`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`,
`colorize`, `typeset`, `layout`, `delight`, `clarify`, `adapt`, `optimize`, `generate`, `overdrive` — is in the
router's command table, one line each, or in tab completion after `/designer`.

## Running the detector

`/designer detect [paths]` runs the engine inside pi. The engine is TypeScript in this package, so there is
no binary to find and no child process: it reads `.impeccable/config.json` and `DESIGN.md` for the project,
scans, and reports. Flags: `--json`, `--scope type`, `--scope layout`.

```
/designer detect                        # the working directory
/designer detect src/App.tsx            # one file
/designer detect --scope type src/      # one domain
/designer detect --json .               # machine-readable
```

Upstream's launcher is gone from this tree: it shelled out to a downloaded platform binary, and every
verb it ran is either a `/designer` command now or one pi does not offer (`live-*`, `component-review`,
`hooks`, `pin` — the reference pages for those say so at the top).

The same scan is available to the model as the `design_check` tool, so an audit calls it directly instead of
telling you which command to run. The command stays the human's path: it notifies, the tool returns text.

The report counts mechanical HTML/CSS patterns only. A clean scan is not a verdict on data encoding, copy,
or visual judgment; a chart can pass every rule and still mislead. `/designer encode` covers that question.

Findings are suppressed upstream's way: `impeccable ignores add-rule`, `add-file`, `add-value`, or an inline
comment in the file itself (`/* impeccable-disable-line side-tab */`).

## Discovery

Walks from the working directory up to the repository root (the first directory containing `.git`) and stops
there, so a monorepo package can carry its own design file without inheriting one from above the repo. The
closest file wins. Names checked in order: `DESIGN.md`, `DESIGN.MD`, `design.md`.

## Spec severities

| Severity | Meaning | Examples |
|---|---|---|
| `✗ error` | The spec mandates a rejection | malformed YAML, missing `name`, duplicate section headings |
| `! warning` | The spec says something SHOULD hold | section order, required sections unless listed in `omitted`, missing `colors.primary`, unresolved `{token.reference}` |
| `· note` | The spec says accept it and carry on | unknown section heading, unknown token name, absent optional fields |

`validate` marks a finding `[pre-existing]` when it was already there the first time this session read that
file. Unmarked findings appeared after that first read. The marker is a session baseline, not a git diff.

## Maintainers

### The guidance

`extensions/designer/guidance/` is ours. It started as a snapshot of Impeccable's Pi build (skill `4.5.0`,
engine `0.1.11`) at the commit in `guidance/UPSTREAM.json`, and it is edited in place from here — no re-sync in
the maintenance loop.

It is data, not a skill tree. `corpus.ts` holds the bodies by key, `router.ts` holds what used to be `SKILL.md`,
and `index.ts` resolves names to text. Nothing is discovered, nothing is read from disk at runtime, and a
cross-reference is a key (`reference/craft-floor.md`) the tool serves rather than a path the agent resolves —
so a monorepo, a portable install, or a moved package all behave the same. `test/extension/guidance.test.ts`
holds the invariant a file tree gave for free: every key mentioned inside the guidance resolves, and no
markdown link into a directory survives.

That manifest is provenance, not wiring: it says which commit the text started from, nothing reads it at
runtime, and it stays as the record of where the divergence began.

The text is pi-only, and that is the point of owning it. Divergence from upstream is the design decision, not
accident:

- **One front door.** Upstream names its commands `/impeccable <verb>` in prose and in the "Suggested command"
  lists its reports emit. pi has no such command, so every reference here says `/designer <verb>`, and the
  router tells the agent to translate the engine's own `/impeccable` strings on sight.
- **No other harnesses.** Upstream's guidance branches on Claude Code, Codex, Cursor, Copilot, Grok Build, and
  Gemini: their sub-agent tools, their background terminals, their browser panes. All of it is gone, replaced
  with pi's own surfaces (`subagent`, the process tool, the browser tools). The "shipped agents" upstream spawns
  (`impeccable-asset-producer` and friends) were never vendored; their `reference/degraded/` bodies are now the
  subagent prompts outright.
- **No hook surface.** Upstream's `hooks.md` installed a per-edit detector into other tools' manifests. pi
  registers no tool hooks — review is manual, like a linter — so that file became `detector-config.md`, which
  covers only what the detector reads when a command runs it (`impeccable ignores`, inline markers).
- **No runtime file paths.** Upstream's guidance points at sibling files. Here every cross-reference is a
  guidance key served by `design_check`, which is why the corpus is TypeScript and why `import-guidance.mjs`
  rewrites links instead of copying a tree.

Importing a newer upstream reintroduces the first three; redo the rewrite when you do.

`import-guidance.mjs` replaces the corpus wholesale, so running it again discards local edits; use it only to
import a newer upstream version on purpose, and read the diff first:

```bash
bun extensions/designer/scripts/import-guidance.mjs --source <path-to-impeccable>/.pi/skills/impeccable
bun extensions/designer/scripts/import-guidance.mjs --source <path>/... --dry-run
```

`--source` points at a skill directory (the one holding `SKILL.md` and `reference/`). Pull and rebuild the
source first (`git pull && bun run build:skills`). The script writes `guidance/corpus.ts` and refreshes the
provenance record; it refuses to write when a cross-reference points outside the corpus, rather than leaving
instructions that name something the tool cannot serve. `--commit` and `--version` record the upstream
revision. The router is hand-maintained, so an import never touches it.

The guidance text is Apache-2.0, not MIT: attribution and license text live in `NOTICE` and
`THIRD_PARTY_LICENSES/`, and stay accurate as the text changes.

### Layout

- `extensions/designer/index.ts` — factory: prompt sections, the `design_check` tool, `/designer` command,
  error notification
- `extensions/designer/spec.ts` — spec reading, summary extraction, and validation
- `extensions/designer/design-file.ts` — `DESIGN.md` discovery
- `extensions/designer/engine/` — the TypeScript port of Impeccable's engine, so pi commands call the rule logic in process instead of spawning a binary. Covers the rule catalog and checks, the detect engines, and the build/comp/font/image helpers; the JavaScript it was ported from is no longer in the repo.
- `extensions/designer/guidance/` — the guidance corpus (`corpus.ts`), the router (`router.ts`), and the name-to-text lookup; no skill tree, no file paths
- `extensions/designer/engine/data/` — the font fingerprint index the comp and font verbs rank against
- `extensions/designer/scripts/import-guidance.mjs` — imported the corpus once, and can replace it from a newer upstream
- `test/` — vitest suite, one folder per domain, each file mirroring the module it covers:
  - `test/core/` — rule catalog, findings, checks, color, config, context, doctor, critique storage
  - `test/detect/` — the HTML, CSS, text, URL, and visual detection engines
  - `test/lib/` — the command and workflow helpers (build phase, comps, fonts, images, staleness)
  - `test/extension/` — the surfaces pi calls: `/designer` routing, the guidance corpus, the engine facade
  - `test/helpers/check.ts` — one vitest case per comparison
- `evals/` — behavioral evals: does an agent use these surfaces correctly? See `evals/README.md`

### Development

```bash
bun install
bun run typecheck        # tsc --noEmit, tests included
bun run test             # vitest run: behavior and contract checks
bun run eval:test        # assertion grading, no model calls
bun run eval             # behavioral evals (model calls); see evals/README.md
```
