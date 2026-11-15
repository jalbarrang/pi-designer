# Detector config

The engine's detector reads two project files: `.impeccable/config.json` (shared, committed) and `.impeccable/config.local.json` (gitignored, per developer, wins where both set a key). Everything in this file concerns what `/designer detect` reports.

pi-designer registers no tool hooks: no edit runs the detector, and no finding is pushed into a turn. Findings arrive when a command runs it — `/designer audit`, `/designer critique`, or `/designer detect <path>` — so `hook.*` keys in that config do nothing here.

## Triage a finding

Three outcomes, and only three:

- **Real design problem**: fix it. Never add an ignore to skip a fix.
- **Confident false positive or sanctioned exception**: persist the narrowest ignore yourself and disclose it in your reply. The bar is evidence you can name: an intentional demo or fixture, documentation of bad design, literal or domain-appropriate motion (a ball that bounces), or a choice the user already confirmed. Put that evidence in `--reason` as `"<who decided: evidence>"`; write "user confirmed" only when the user actually did.
- **Unsure**: leave the finding standing and ask the user in one line. Ask once, rather than guessing at a suppression that outlives the session.

Self-serve stops at `add-value`. `add-file` and `add-rule` silence too much to add on your own judgment; ask the user first.

## Suppressing, narrowest first

`impeccable ignores` is the write path: it validates and keeps the file shape consistent. Shared scope is the default; `--local` writes the gitignored file, for one developer's exception.

| Action | Effect |
|---|---|
| `add-value <rule> <value> --reason "<who: evidence>"` | One rule/value pair, project-wide |
| `add-value <rule> "*" --file <glob> --reason "..."` | One rule, in matching files only |
| `add-file <glob>` | Every rule for matching files, forever |
| `add-rule <rule> [--all-values]` | One rule, project-wide |
| `list` / `remove-value` / `remove-file` / `remove-rule` / `clear` | Inspect and undo; `--all` spans both scopes |

Prefer value-specific suppressions. A specific font is `add-value overused-font Inter`, never `add-rule overused-font`; a noisy rule on one file is `add-value <rule> "*" --file <path>`, never `add-file` for a file that still deserves review. `add-file` is for a file that is out of scope entirely: a fixture, a generated artifact, a deliberate slop demo. `add-rule` is for when the user asks to drop a rule across the project.

```bash
/designer detect --no-config add-value bounce-easing bounce-ball --reason "Agent: literal ball-bounce animation, bounce easing is the subject"
/designer detect --no-config add-value design-system-font-size "*" --file "src/overlay/widget.js" --reason "Injected widget builds its own type scale; DESIGN.md's ramp describes the site"
```

## Inline markers

Config ignores keep suppressions in one reviewable place; use them by default. Reach for an inline comment only when the waiver must travel with a single file that leaves the repo (a generated or exported standalone document, an emailed HTML file). The markers are `impeccable-disable <rule>` (whole file), `impeccable-disable-line`, and `impeccable-disable-next-line`, in any comment syntax, with an optional reason after `:` or `--`. The detector honors them unless run with `--no-inline-ignores` or `--no-config`.

## Constraints

- Never hand-edit `.impeccable/config.json` or `.impeccable/config.local.json`; go through `impeccable ignores`. One exception: `detector.extensions` has no admin action, so when the project uses Blade, Twig, ERB, or Handlebars templates, edit that one field directly and leave the rest untouched. One entry per extension, `{ "ext": ".blade.php", "engine": "html" }`, where `engine` picks the analyzer (`html` for markup, `text` for JS/TS/CSS-like) and defaults to `html`. It matches the end of the filename, so double extensions work. Config only adds extensions; the built-in list always applies.
- A malformed config file is ignored with the remaining valid values, and `impeccable ignores list` shows it as ignored. Report that rather than rewriting the file.
- `--no-config` on `/designer detect` gives a raw run: no ignore rules, no design-system context. Use it to see the unfiltered result, not to work around a suppression you disagree with.
