# Port map

Every file in `scripts/` and where its TypeScript port lives, or where it will.
`reference/impeccable-js/` is never edited; the port is where behavior changes.

Status: **done** means ported, typed, and covered by `test/engine.ts`. **next** means
this leg is in flight. **later** means untouched and honest about it.

## Leg 1 — core spine (done)

| Reference | Port |
|---|---|
| `detector/registry/antipatterns.mjs` | `engine/core/registry/antipatterns.ts` |
| `detector/findings.mjs` | `engine/core/findings.ts` |
| `detector/shared/constants.mjs` | `engine/core/shared/constants.ts` |
| `detector/shared/fonts.mjs` | `engine/core/shared/fonts.ts` |
| `detector/shared/page.mjs` | `engine/core/shared/page.ts` |
| `detector/shared/inline-ignores.mjs` | `engine/core/shared/inline-ignores.ts` |

## Leg 2 — core checks (done)

| Reference | Bytes | Port | Status |
|---|---|---|---|
| `detector/shared/color.mjs` | 23.6K | `engine/core/shared/color.ts` | done, 74 parity comparisons |
| `detector/rules/checks.mjs` (all 5744 lines) | 265.8K | `engine/core/checks/` — 22 domain modules plus `engine/dom.ts` | done, parity-covered |

One deliberate deviation from upstream: the zero-argument `*DOM` entry points
(`checkTextOcclusionDOM`, `checkEdgeFlushCardsDOM`, `checkHeadingRhythmDOM`, and so on)
read ambient `document`/`window`/`getComputedStyle`. pi has no ambient document — a scan
runs against a live page through its browser tooling or against a parsed file — so every
one of those was ported as a function that takes the document and a `DomAdapter`. The
behavior is identical; only the wiring moved to an argument.

`checks.mjs` is one file upstream and stays one file in the reference. Split it in the
port: it is a flat list of `checkElement*` functions with no cross-calls, so the split
is mechanical and makes a review of any single rule possible.

Reference functions that are not exported upstream have no direct oracle; they are
covered through the exported scan or check that calls them, and `test/parity-checks.mjs`
says which in a comment at that spot.

## Leg 3 — detect engines (done)

| Reference | Bytes | Port | Status |
|---|---|---|---|
| `detector/engines/regex/detect-text.mjs` — comment stripping, style blocks, CSS-in-JS extraction | 55K | `engine/detect/strip-comments.ts` | done, 43 behavior checks in `test/detect.ts` |
| `detector/engines/regex/detect-text.mjs` — matcher table, analyzers, `detectText` | 46K | `engine/detect/text.ts` | done, 44 engine parity comparisons in `test/parity-text.mjs` |
| `detector/profile/profiler.mjs` | 4.6K | `engine/detect/profile.ts` | done |
| `detector/node/file-system.mjs` | 7.7K | `engine/detect/files.ts` | done |
| `detector/design-system.mjs` (all 1311 lines) | 49.8K | `engine/detect/design-system.ts` | done, 100 parity comparisons in `test/parity-design-system.mjs` |
| `detector/engines/static-html/css-cascade.mjs` — value layer (tokenizing, color and length normalization, shorthand expansion, `@layer` unwrapping) | 22K | `engine/detect/static-html/css-values.ts` | done, 91 parity comparisons in `test/parity-css-values.mjs` |
| `detector/engines/static-html/css-cascade.mjs` — rule engine (specificity, declaration expansion and application, `StaticDocument`/`StaticElement`, `buildStaticStyleMap`, linked-stylesheet resolution) | 24K | `engine/detect/static-html/css-cascade.ts` | done, parity-covered (144 comparisons total for both halves) |

Two deliberate deviations in this file, both recorded here:

- **The parser is injected.** Upstream imports a third-party HTML parser and css-tree; this port takes them as `DomModules` (`selectAll`, `selectOne`, `compile`, `domutils`, `csstree`). pi's static scan should not pick a parser on its own, and the rest of the module — specificity, expansion, inheritance, custom properties, the hover pass, the two pseudo shapes — is ours.
- **`buildBorderOverrideMap` is not ported.** It exists to rescue `var()` borders that jsdom drops from the CSSOM. pi's static engine computes styles with this cascade, which resolves `var()` itself through `collectCssCustomProps`/`resolveVarRefs`, so the rescue pass has no job here. Porting it would add a jsdom-shaped workaround to a path that never runs jsdom.
| `detector/engines/static-html/detect-html.mjs` | 12.7K | `engine/detect/static-html/html.ts` | done, 10 end-to-end comparisons in `test/parity-html.mjs` |
| `detector/engines/browser/detect-url.mjs` | 16.2K | `engine/detect/browser/url.ts` | done, 19 comparisons in `test/parity-url.mjs` |
| `detector/engines/visual/screenshot-contrast.mjs` | 6.5K | `engine/detect/visual/contrast.ts` | done, 33 comparisons in `test/parity-visual.mjs` |
| `detector/cli/main.mjs` | 18.9K | `engine/detect/scan.ts` — the in-process entry point, with the process boundary removed (formatting, advisory partition, exit code, directory walk, import annotation, per-file design system) | done, 10 comparisons in `test/parity-scan.mjs` |
| `detector/detect-antipatterns.mjs` | 1.9K | `engine/detect/index.ts` (barrel) | done — the facade stops at the exports; pi has no executable entry |

Verification: `detectText` parity is the end-to-end oracle for this engine and, because the
stripper decides which bytes the matchers see, for the stripper too. The engine takes the
design-system checker as a dependency (`options.checkDesignSystem`) instead of importing it,
so this module and the design-file reader never form an import cycle; `design-system.ts`
plugs in there when it lands.

`detector/detect-antipatterns-browser.js` (410K) is the bundled browser build of the
rules already covered by `checks.mjs` plus the browser engine. It is a build artifact:
it confirms behavior, and nothing ports from it directly.

## Leg 4 — the rest of the engine (in flight)

| Reference | Bytes | Port | Status |
|---|---|---|---|
| `lib/impeccable-config.mjs` — read/write the detector filters, glob and value matching, finding filters | 21K | `engine/config.ts` | done, 46 parity comparisons in `test/parity-config.mjs` |
| `lib/provider.mjs`, `lib/target-args.mjs`, `lib/target-slug.mjs`, `lib/artifact-schema.mjs` | 6.5K | `engine/lib/{provider,target-args,target-slug,artifact-schema}.ts` | done, 78 parity comparisons in `test/parity-libs.mjs` (provider is the one deliberate divergence: the command string says `/designer`) |
| `lib/surface-briefs.mjs` — per-surface strategy records, target normalization, resolution reasons | 6.1K | `engine/lib/surface-briefs.ts` | done, covered in `test/parity-libs.mjs` (112 comparisons across the lib layer) |
| `lib/staleness.mjs` — the boot drift checks (product schema, native evidence, sidecar, config keys, build path, orphaned briefs, projectRoots) | 23K | `engine/lib/staleness.ts` | done, 22 parity comparisons in `test/parity-staleness.mjs` |
| `lib/staleness-notice.mjs` — notice throttling (one directive, weekly renotify, `auto` never stamped) and the `CONTEXT_STALE` rendering | 6.7K | `engine/lib/staleness-notice.ts` | done, covered in `test/parity-libs.mjs` (123 comparisons) |
| `context.mjs` — the boot loader: project/target/workspace resolution, product and design discovery, surface brief resolution, visual-implementation evidence, platform and section reads | 62K | `engine/context.ts` + `engine/lib/platform.ts` | done, 151 parity comparisons in `test/parity-context.mjs` over real directory trees |
| `lib/impeccable-paths.mjs` — every artifact path, resolved per project, retired locations still readable | 5.0K | `engine/lib/impeccable-paths.ts` | done, covered in `test/parity-libs.mjs` |
| `critique-storage.mjs` — snapshot writing, the `latest`/`close`/`trend` reads, target identity and byte fingerprints | 18.7K | `engine/critique-storage.ts` | done, 29 checks in `test/critique-storage.ts` |
| `lib/design-parser.mjs` — DESIGN.md into a structured model (frontmatter, eight canonical sections, named rules, coverage report) | 27K | `engine/lib/design-parser.ts` | done, 20 parity comparisons in `test/parity-design-parser.mjs` over whole design records |
| `lib/staleness-deep.mjs` — the expensive checks: DESIGN.md drift over git history, coverage gaps, ignore-list validation, retired live state, workspace sweep | 21K | `engine/lib/staleness-deep.ts` | done, 15 parity comparisons in `test/parity-staleness-deep.mjs` (including a real git repository with 30 commits) |
| `lib/staleness-deep.mjs` — hook installation verification | 2K | not ported | pi registers no hooks, so there is no manifest to verify and no "installed but disabled" contradiction to catch |
| `doctor.mjs` — the deep report (`collect`, `renderText`, `renderJson`) and the narrow `--fix` that applies only `auto` migrations | 11.5K | `engine/doctor.ts` | done, 13 parity comparisons in `test/parity-doctor.mjs` (findings, workspaces, rendered report, and a `--fix` run on identical copies) |
| `context-signals.mjs` — the cheap deterministic signals (setup, critique, git scope hint, dev server, scan targets) | 14K | `engine/context-signals.ts` | done, 11 parity comparisons in `test/parity-signals.mjs` over three real git repositories |
| `lib/template-extensions.mjs`, `lib/is-generated.mjs` | 8K | `engine/lib/template-extensions.ts`, `engine/lib/is-generated.ts` | done, covered in `test/parity-libs.mjs` (172 comparisons) |
| `lib/roll-selection.mjs` — the world roll: tier ranking, rating tickets, breadth and mode gates, re-roll chains, composition deals with grain and platform match reporting | 17.8K | `engine/lib/roll-selection.ts` | done, 134 parity comparisons in `test/parity-roll.mjs` (both scopes, three re-roll rounds, mode/min-rating/grain/platform combinations, sync and async drivers) |
| `lib/concept-catalog.mjs`, `lib/composition-catalog.mjs` | 30K | `engine/lib/concept-catalog.ts`, `engine/lib/composition-catalog.ts` | done, 76 parity comparisons in `test/parity-concepts.mjs` and 49 more in `test/parity-libs.mjs` (every validator error string, both hashes, both catalog readers) |
| `detect-csp.mjs` — how a project writes its Content-Security-Policy, by shape and by file | 8K | `engine/lib/detect-csp.ts` | done, 12 parity comparisons in `test/parity-csp.mjs` (every shape, the precedence between them, and the skipped directories) |
| `lib/raster.mjs` — crop, resize (area-averaged down, bilinear up), alpha compositing, fills, and the bitmap label font | 6.5K | `engine/lib/raster.ts` | done, 35 parity comparisons in `test/parity-raster.mjs` (every operation, all alpha paths, every glyph rendered and hashed) |
| `lib/image-metrics.mjs` — structure (SSIM with a translation search), colour (histogram intersection, dominant palette in Lab), detail per cell, pixel diff, horizontal bands | 11K | `engine/lib/image-metrics.ts` | done, 62 parity comparisons in `test/parity-metrics.mjs` (four image pairs: identical, shifted, recoloured, detail removed) |
| `lib/font-fingerprint.mjs` — line finding, per-line metrics, glyph segmentation, the 33-feature vector, dominance isolation, and the fitted distance | 20K | `engine/lib/font-fingerprint.ts` | done, 65 parity comparisons in `test/parity-fingerprint.mjs` (ten crops including a two-line headline with body copy, an upsample, and three non-lettering cases; every feature and the distance) |
| `lib/font-index.mjs` — the packed catalog index, size routing, and the candidate generator | 7K | `engine/lib/font-index.ts` | done, 51 parity comparisons in `test/parity-font-index.mjs` (packing round-trip, routing, and every candidate filter against a synthetic index) |
| `font-match.mjs` — the width and weight classes, the shortlist, candidate selection, the choice stamp, and the measure report | 18K | `engine/lib/font-match.ts` | done, 83 parity comparisons in `test/parity-font-match.mjs`. Browser rendering is a host surface upstream too; `matchRegion` takes pixels and `rankCandidates` takes already-rendered fingerprints instead of discovering a renderer |
| `lib/png.mjs` — decode (every colour type, bit depth 1–16, Adam7) and the trivial encoder, plus the any-raster loader | 9K | `engine/lib/png.ts` | done, 42 parity comparisons in `test/parity-png.mjs` (byte-identical encoding, eleven hand-built formats, all five filter types, and the converter seam) |
| `comp-spec.mjs` — the measured region spec: the grid, ink snapping, and every refusal (a painted note filed as chrome, a column passed off as one region, a plate boxed through its artwork, unclaimed ink) | 16K | `engine/lib/comp-spec.ts` | done, 55 parity comparisons in `test/parity-comp-spec.mjs` aimed at the refusals and at the escape hatches being recorded rather than swallowed |
| `comp-diff.mjs` — build alignment, per-region scoring, the four verdicts, and the side-by-side, heatmap and region-pair renders | 14K | `engine/lib/comp-diff.ts` | done, 128 parity comparisons in `test/parity-comp-diff.mjs`, twelve of them verdict boundaries × seven region kinds |
| `lib/hero-checks.mjs` — cap height, line count, leading, tracking, weight, ink colour, placement, strip rules, invented ink, plate clipping, and code-drawn illustrations | 11K | `engine/lib/hero-checks.ts` | done, 65 parity comparisons in `test/parity-hero-checks.mjs` (eight text cases with their tolerances, four strip cases per kind, five SVG shapes) |
| `build-phase.mjs` — the eight-phase machine: comps, spec, plates, hero and responsive gates, the force rule, the scaffold, the hero attempt loop, and the ship refusal | 34K | `engine/lib/build-phase.ts` | done, 99 parity comparisons in `test/parity-build-phase.mjs`. The comp comparison is injected (`DiffIo`) instead of spawning a script, and gate messages name pi's commands rather than upstream's script paths |
| `embed-prompt.mjs` — a prompt in the PNG `tEXt` chunk or the JPEG `COM` segment, a sidecar for everything else, and the missing-prompt scan | 6K | `engine/lib/embed-prompt.ts` | done, 26 parity comparisons in `test/parity-embed-prompt.mjs` (byte-identical embedding, idempotent re-embedding, the sidecar fallback, and the scan against the reference CLI) |
| `generate-image.mjs` — the deterministic stand-in, the chroma key, the plate plan (size, prompt, key colour), the plate score, and the mocks gate | 18K | `engine/lib/generate-image.ts` | done, 64 parity comparisons in `test/parity-generate-image.mjs` (byte-identical fake SVG and PNG against the reference CLI, the key, four plate shapes, and the gate). The provider call is a host seam: pi already has an image tool |
| `palette.mjs` — the 128-seed brand library, inverse-frequency weighted by hue zone, and the handover text | 57K | `engine/lib/palette.ts` + `engine/lib/palette-seeds.ts` | done, 82 parity comparisons in `test/parity-palette.mjs` (the ids and colours extracted mechanically from the reference, the draw reproduced from a key, and the whole handover text compared against the reference CLI) |
| `concept-seed.mjs` — the assigned index, the dealt hand, the register swap, and the whole seed text | 32K | `engine/lib/concept-seed.ts` | done, 78 parity comparisons in `test/parity-concept-seed.mjs` (every scope, mode, register and re-roll compared as whole text; the deal and its restatement; the eleven refusals). Catalog resolution, the roll fetch and the choice ping are host seams |

Not ported from that file, on purpose: the `.git/info/exclude` helpers and hook consent. pi registers no hooks, so there is nothing to consent to and no local file it must hide from git.

The rest of leg 4 is below.

Everything below is still reference-only. Each is a real port target once the
detector calls run in process; none of it is needed for `/designer audit` to work.

| Group | Files | Bytes |
|---|---|---|
| Boot and context | `context.mjs`, `context-signals.mjs`, `detect-csp.mjs`, `surface-brief.mjs` | 89.7K |
| Build and comp | `build-phase.mjs`, `comp-diff.mjs`, `comp-spec.mjs`, `concept-seed.mjs`, `serve-question.mjs`, `palette.mjs`, `embed-prompt.mjs`, `generate-image.mjs` | 446.5K |
| Live | `live.mjs`, `live-*.mjs`, `live/*.mjs`, `live-browser*.js` | 1.2M |
| Hooks | `hook.mjs`, `hook-*.mjs` | 158.0K |
| Shared libs | `lib/*.mjs` | 245.0K |
| Other CLI verbs | `doctor.mjs`, `critique-storage.mjs`, `font-match.mjs`, `pin.mjs`, `detect.mjs` | 68.9K |

The hook and live groups are the least valuable ports: pi registers no tool hooks, and
its own browser and process tools already cover the live helper's job.

## Where the port stands

Everything in `scripts/` and `scripts/lib/` is either ported and compared against the reference, or
excluded for a stated reason. The exclusions are all cases where the reference's surface is one pi
already owns, so porting it would put a second one in the same session.

### Ported and compared

The detector (core checks, the regex, static-HTML, browser-URL and pixel-contrast engines, the scan
entry point), the config layer, DESIGN.md parsing, both staleness tiers, the boot context loader,
context signals, critique storage, the artifact paths, template extensions, generated-file detection,
the world roll, both catalogs, the doctor, the CSP shape check, the raster and metrics layers, PNG
decode/encode, prompt embedding, the font fingerprint, the font index, font matching, the comp spec,
the comp diff, the hero checks, the build-phase gates, image generation, the palette, the direction
seed, the decision round's payload contract, and the surface-brief commands.

`bun run test` runs all of it: 41 suites, every one comparing against the reference tree rather than
against a recorded snapshot of it.

### Excluded, with the reason

| Reference | What pi owns instead |
|---|---|
| `scripts/hook*.mjs`, `scripts/lib/impeccable-config.mjs`'s git-exclude and consent helpers | pi registers no tool hooks, so there is no manifest to install, no consent to record, and nothing to verify. |
| `scripts/live*.mjs`, `scripts/lib/{live-*,open-system-browser}.mjs` (1.2M) | pi drives the user's own browser through its browse tools, and its own process tool for servers. |
| `scripts/pin.mjs` | It writes shortcut skill files into 17 harness directories. pi has one command namespace, so there is nothing to pin. |
| `scripts/serve-question.mjs` — the HTTP server and the 1,100-line decision page | pi asks through its own prompt. The payload contract and the answer directives it feeds are ported as `engine/lib/decision-round.ts`. |

### Every reference file, accounted for

60 files under `scripts/` and `scripts/lib/`. Every one is either ported (and named in a row above) or
listed here. Nothing is unaccounted for, and this list is checked by counting rather than by reading:
`ls reference/impeccable-js/scripts/**/*.mjs | wc -l` against the rows.

The excluded families, file by file:

- `scripts/hook-admin.mjs` — a hook pi does not install
- `scripts/hook-before-edit.mjs` — a hook pi does not install
- `scripts/hook-lib.mjs` — a hook pi does not install
- `scripts/live-accept.mjs`
- `scripts/live-commit-manual-edits.mjs`
- `scripts/live-complete.mjs`
- `scripts/live-copy-edit-agent.mjs`
- `scripts/live-discard-manual-edits.mjs`
- `scripts/live-inject.mjs`
- `scripts/live-insert.mjs`
- `scripts/live-manual-edit-evidence.mjs`
- `scripts/live-path-globs.mjs`
- `scripts/live-poll.mjs`
- `scripts/live-resume.mjs`
- `scripts/live-server.mjs`
- `scripts/live-status.mjs`
- `scripts/live-target.mjs`
- `scripts/live-wrap.mjs`
- `scripts/open-system-browser.mjs`

### What pi runs in process today

Every verb whose module is ported is also a command, so the launcher's binary is no longer needed for any
of them. Nothing in this repository spawns it.

| Verb | Ported module | Command |
|---|---|---|
| `detect` | `detect/scan.ts`, `lib/scan-command.ts` | `/designer detect` |
| `doctor` | `doctor.ts` | `/designer doctor` |
| `context` | `context.ts`, `context-signals.ts` | `/designer context` |
| `palette` | `lib/palette.ts` | `/designer palette` |
| `concept-seed` | `lib/concept-seed.ts` | `/designer concept-seed` |
| `critique-storage` | `critique-storage.ts`, `lib/critique-store-command.ts` | `/designer critique-storage` |
| `surface-brief` | `lib/surface-brief-command.ts` | `/designer surface-brief` |
| `build-phase` | `lib/build-phase.ts`, `lib/build-phase-command.ts` | `/designer build-phase` |
| `comp-spec` | `lib/comp-spec.ts` | `/designer comp-spec` |
| `font-match` | `lib/font-match.ts`, `lib/font-index.ts` | `/designer font-match` |
| `comp-diff` | `lib/comp-diff.ts` | `/designer comp-diff` |
| `serve-question` | `lib/decision-round.ts` | not a command — pi asks through its own prompt |
| `live-*`, `component-review`, `hooks`, `pin` | not ported | no, by decision |

The launcher (`skill/scripts/impeccable`, `impeccable.cmd`) has been deleted: it shelled out to a downloaded
platform binary, and every verb it ran is a command above or one pi does not offer. So has the live-mode
browser bundle (`live-browser*.js`, `modern-screenshot.umd.js`, 590 KB) — pi drives the user's own browser
through its browse tools instead. What remains in `skill/scripts/` is `command-metadata.json`, the font
index, and `VERSION`. The four excluded families' reference pages open with a line saying they are
unavailable here, and name what to do instead.

### Not code, and therefore not ported

`skill/scripts/data/font-index.json` ships with the skill: 3,076 faces, packed as described in
`engine/lib/font-index.ts`. The port loads and interprets it (`loadFontIndex` takes a path), and
`test/parity-font-index.mjs` compares the decode and the candidate ranking against that real file as well
as against a synthetic fixture.

`scripts/{detect,surface-brief}.mjs` are CLI shims over behavior already ported. Their remainder — the
argument parsing and the report text — lives in `engine/lib/detect-command.ts` and
`engine/lib/surface-brief-command.ts`, which return results instead of writing to stdout so a caller
owns its own exit codes.

## Verification

`test/engine.ts` covers the spine by behavior, not by snapshot. For the checks and engines the oracle is
the reference's own source: every parity suite imports `reference/impeccable-js/...` directly and compares
outputs, so a divergence names the rule that broke instead of an opaque diff. `bun run test` runs all of
them; `bun run typecheck` must be clean.
