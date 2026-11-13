# pi-designer

A pi extension that owns the project's `DESIGN.md` and carries the [Impeccable](https://impeccable.style)
design guidance. Design review is manual, like running a linter.

## Install

```bash
pi install npm:@jalbarran/pi-designer   # published package
pi install ~/fun/drekki/pi-designer     # local checkout
```

Remove any older copy from `~/.pi/agent/extensions/designer` first: two copies mean two
`design_context` sections and a duplicated `/designer` command.

## What it does

**Owns the design file.** `DESIGN.md` is [Google's format](https://github.com/google-labs-code/design.md) for
describing a design system to AI agents: YAML frontmatter carrying design tokens, then prose sections in a
fixed order.

- **Advertises** the resolved `DESIGN.md` in the system prompt as a `design_context` section — path,
  `name`, and a one-line summary — and lets the agent read the file only when the task needs it. The
  contents never sit in context by default.
- **Validates** the file against the `design.md` spec on demand, with errors, warnings, and notes chosen
  from what the spec actually mandates. The agent is told to leave that judgement to the command: it may report an
  error it can see, but it must not claim the file conforms (`/designer validate` is the check, and it is yours to run).
- **Reports spec errors once per session** to the human, never to the model: a broken design file is not
  the agent's task to fix.

**Runs nothing on edits.** No tool hooks are registered: editing a file never spawns the detector, never blocks a
write, and never pushes findings into a turn.

**Routes design review to the skill.** A fixed `design_workflow` prompt section tells the agent to read
`skill/SKILL.md` before answering a review, critique, audit, or polish request. The skill's own description was not
enough: with only that, 1 of 3 audit runs loaded it and the other two improvised a review from `DESIGN.md` and
screenshots; with the section it is 3 of 3 (see `evals/`). The section is independent of `design_context` — audits
happen in projects without a design file too.

**Carries Impeccable.** `skill/` is a vendored copy of upstream's Pi build
([github.com/pbakaus/impeccable](https://github.com/pbakaus/impeccable), mirrored at
`~/fun/drekki/impeccable`). It is registered as a normal Pi skill, so the agent loads its
routing, references, and playbooks on demand, and `/designer <playbook>` forces one.

The engine binary is not vendored: the bundled `extensions/designer/skill/scripts/impeccable` launcher
downloads the version-pinned release into `~/.impeccable/bin/<version>/` and verifies its sha256 sidecar on
first use.

## Manual audits

Design review runs when you ask for it, the way you run a linter. Two ways in:

| Path | Use |
|---|---|
| `/designer <playbook> [target]` | Route the agent to an Impeccable playbook (`audit`, `critique`, `polish`, `document`, …) |
| `impeccable detect <paths>` | Run the detector from a shell, linter-style |

`impeccable detect` reads `.impeccable/config.json` and `DESIGN.md` unless told otherwise, and its exit status is
the verdict: `0` clean, `2` findings, `1` a target could not be scanned. Useful flags: `--json`, `--quiet`,
`--scope type,layout`, `--no-config`, and `--no-design-system` to ignore the project design system.

The engine ships as `skill/scripts/impeccable` and is not on `PATH`. Symlink it as `impeccable` if you want the
bare command; otherwise call the launcher directly.

```bash
IMP=~/fun/drekki/pi-designer/extensions/designer/skill/scripts/impeccable
$IMP detect src/                       # scan a tree
$IMP detect --scope type src/App.tsx   # one domain, one file
$IMP detect --json . | jq '.findings'  # machine-readable
```

Findings are suppressed the upstream way: `impeccable ignores add-rule`, `add-file`, `add-value`, or inline
comments in the file itself (`/* impeccable-disable-line side-tab */`).

## Commands

| Command | Behavior |
|---|---|
| `/designer` | Status: resolved file, `name`, sections, token references, spec verdict, Impeccable version |
| `/designer validate` | Full spec report for the file in effect for this working directory |
| `/designer validate <path>` | Same, for any other DESIGN.md |
| `/designer <playbook> [target]` | Route to an Impeccable playbook (`polish`, `critique`, `audit`, `document`, …) |

## Discovery

Walks from the working directory up to the repository root (the first directory containing `.git`)
and stops there, so a monorepo package can carry its own design file without inheriting one from
above the repo. The closest file wins. Names checked in order: `DESIGN.md`, `DESIGN.MD`, `design.md`.

## Spec severities

| Severity | Meaning | Examples |
|---|---|---|
| `✗ error` | The spec mandates a rejection | malformed YAML, missing `name`, duplicate section headings |
| `! warning` | The spec says something SHOULD hold | section order, required sections unless listed in `omitted`, missing `colors.primary`, unresolved `{token.reference}` |
| `· note` | The spec says accept it and carry on | unknown section heading, unknown token name, absent optional fields |

## Refreshing the Impeccable half

```bash
cd ~/fun/drekki/pi-designer
bun extensions/designer/scripts/sync-upstream.mjs                  # from ~/fun/drekki/impeccable
bun extensions/designer/scripts/sync-upstream.mjs --source <repo>  # from another checkout
bun extensions/designer/scripts/sync-upstream.mjs --dry-run
```

Pull and rebuild upstream first (`git pull && bun run build:skills`); the script copies the generated
`.pi/skills/impeccable` tree, rewrites the project-relative paths upstream bakes into its guidance
(`.pi/skills/impeccable/scripts` → this extension's own `skill/scripts`, 75 references across 16 files),
and records the source commit, skill version, and engine version in `skill/UPSTREAM.json`. It fails loudly
if upstream changes its path shape, rather than leaving instructions that point at a missing directory.

`extensions/designer/skill/` is generated. Do not hand-edit it; fixes belong upstream.

## Files

- `extensions/designer/index.ts` — factory: prompt sections, `/designer` command, error notification
- `extensions/designer/spec.ts` — spec reading, summary extraction, and validation
- `extensions/designer/design-file.ts` — DESIGN.md discovery
- `extensions/designer/scripts/sync-upstream.mjs` — vendors and rewrites the upstream Pi build
- `extensions/designer/skill/` — vendored Impeccable (generated; see `skill/UPSTREAM.json` for provenance)
- `test/spec.ts` — spec reading, validation, and command wiring
- `evals/` — behavioral evals: does an agent use these surfaces correctly? See `evals/README.md`

## Development

```bash
cd ~/fun/drekki/pi-designer
bun install
bun test/spec.ts         # design.md spec reading, validation, command wiring
bun evals/test-grade.ts  # assertion grading, no model calls
bun evals/run-evals.ts   # behavioral evals (model calls); see evals/README.md
```
