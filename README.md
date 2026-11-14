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

Nothing else to install: the bundled launcher needs no Node runtime. On first use it downloads the
version-pinned engine into `~/.impeccable/bin/<version>/` and verifies its sha256 sidecar.

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

**Routes design review to the skill.** A fixed `design_workflow` prompt section tells the agent to read
`skill/SKILL.md` before answering a review, critique, audit, or polish request. The skill's own description was
not enough: with only that, 1 of 3 audit runs loaded it and the other two improvised a review from the design
file and screenshots; with the section it is 3 of 3 (see `evals/`). Audits in projects without a design file
take the same route — the section is independent of `design_context`.

**Carries Impeccable.** `skill/` is a vendored copy of upstream's Pi build
([pbakaus/impeccable](https://github.com/pbakaus/impeccable)). It registers as a normal pi skill, so the agent
loads its routing, references, and playbooks on demand, and `/designer <playbook>` forces one.
`skill/UPSTREAM.json` records the commit and versions it came from.

## Commands

| Command | Behavior |
|---|---|
| `/designer` | Status: resolved file, `name`, sections, token references, spec verdict, engine version |
| `/designer validate [path]` | Full spec report, for the file in effect or any other `DESIGN.md` |
| `/designer <playbook> [target]` | Route to an Impeccable playbook, described next |

## Playbooks

About two dozen playbooks sit behind `/designer`. The ones used most:

| Playbook | What you get |
|---|---|
| `document` | Generate `DESIGN.md` from existing project code |
| `critique` | UX design review with heuristic scoring |
| `audit` | Technical quality checks: accessibility, performance, responsive |
| `polish` | Final quality pass before shipping |
| `init` | Capture durable product context in `PRODUCT.md` |
| `live` | Pick elements in the browser and iterate on alternatives |

Everything else — `shape`, `extract`, `craft`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`,
`colorize`, `typeset`, `layout`, `delight`, `clarify`, `adapt`, `optimize`, `generate`, `overdrive` — is in the
Commands table of `extensions/designer/skill/SKILL.md`, one line each, or in tab completion after `/designer`.

## Detector from a shell

`impeccable detect <paths>` runs the engine without the agent, linter-style. It reads `.impeccable/config.json`
and `DESIGN.md` unless told otherwise, and its exit status is the verdict: `0` clean, `2` findings, `1` a target
could not be scanned. Flags: `--json`, `--quiet`, `--scope type,layout`, `--no-config`, `--no-design-system`.

```bash
cd pi-designer                                # where you cloned it in Install
IMP=extensions/designer/skill/scripts/impeccable
$IMP detect src/                              # scan a tree
$IMP detect --scope type src/App.tsx          # one domain, one file
$IMP detect --json . | jq '.findings'         # machine-readable
```

The launcher is not on `PATH`; symlink it as `impeccable` if you want the bare command. Findings are
suppressed upstream's way: `impeccable ignores add-rule`, `add-file`, `add-value`, or an inline comment in the
file itself (`/* impeccable-disable-line side-tab */`).

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

## Maintainers

### Refreshing the vendored skill

```bash
bun extensions/designer/scripts/sync-upstream.mjs --source <path-to-impeccable>
bun extensions/designer/scripts/sync-upstream.mjs --dry-run
```

`--source` is required, or set `IMPECCABLE_UPSTREAM`: there is no checkout to guess.

Pull and rebuild upstream first (`git pull && bun run build:skills`). The script copies the generated
`.pi/skills/impeccable` tree and rewrites the scripts path upstream bakes into its guidance
(`.pi/skills/impeccable/scripts`) to `<skill-base-dir>/scripts` — the placeholder `SKILL.md` already defines,
resolved by the runtime rather than frozen to one machine's home directory. It records the upstream repo URL,
commit, skill version, and engine version in `skill/UPSTREAM.json`, and fails loudly if upstream changes its
path shape rather than leaving instructions that point at a missing directory.

That manifest is provenance, not wiring: it says which upstream commit this tree started from, and nothing
reads it at runtime. Once the vendored guidance is edited in place instead of re-synced, it is the record of
the fork point.

`extensions/designer/skill/` is generated. Do not hand-edit it; fixes belong upstream.

### Layout

- `extensions/designer/index.ts` — factory: prompt sections, `/designer` command, error notification
- `extensions/designer/spec.ts` — spec reading, summary extraction, and validation
- `extensions/designer/design-file.ts` — `DESIGN.md` discovery
- `extensions/designer/scripts/sync-upstream.mjs` — vendors and rewrites the upstream Pi build
- `extensions/designer/skill/` — vendored Impeccable (generated; provenance in `skill/UPSTREAM.json`)
- `test/spec.ts` — spec reading, validation, and command wiring
- `evals/` — behavioral evals: does an agent use these surfaces correctly? See `evals/README.md`

### Development

```bash
bun install
bun run typecheck        # tsc --noEmit
bun run test             # spec reading, validation, command wiring
bun run eval:test        # assertion grading, no model calls
bun run eval             # behavioral evals (model calls); see evals/README.md
```
