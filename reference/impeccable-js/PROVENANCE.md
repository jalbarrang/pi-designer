# Recovered Impeccable engine (pre-Rust JavaScript)

This tree is a verbatim copy of Impeccable's JavaScript engine as it stood *before*
the project rewrote it in Rust. It is here as the source for the TypeScript port in
`extensions/designer/engine/`, so a port is a diff against real code instead of a
fetch from git history.

## Provenance

- Upstream: [pbakaus/impeccable](https://github.com/pbakaus/impeccable), Apache-2.0
  (see `NOTICE` and `THIRD_PARTY_LICENSES/Apache-2.0.txt`).
- Commit: `b6aab36ef^` (`f7ddaa71b`), the last tree carrying the JS engine. Its child
  commit `b6aab36ef` regenerated every provider directory from the Rust crates and
  deleted these files.
- Path: `.agent/skills/impeccable/scripts/` upstream, copied with:

  ```bash
  git worktree add --detach /tmp/impeccable-pre-rust b6aab36ef^
  rsync -a --include='*/' --include='*.mjs' --include='*.js' --exclude='*' \
    /tmp/impeccable-pre-rust/.agent/skills/impeccable/scripts/ \
    reference/impeccable-js/scripts/
  ```

The files are unmodified. Do not edit them: they are the reference, and the port is
where change happens. Nothing here is published (`package.json` `files` excludes
`reference/`) and nothing imports it.

## What is in here

`scripts/detector/` is the detector (rules, engines, registry, design-system
awareness) and the reason this tree exists. The rest is the engine's CLI surface:
`context.mjs` (the boot directives `/designer` leans on), `build-phase.mjs`,
`comp-*.mjs`, the `live/*` helper, `hook*.mjs`, and `lib/*` shared modules.

`detector/detect-antipatterns-browser.js` and `live-browser.js` are built browser
bundles, not authored sources; read them for behavior, not structure.

## Port order

See `PORTING.md` for the file-by-file map and what is already ported.
