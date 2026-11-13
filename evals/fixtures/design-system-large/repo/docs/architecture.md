# Architecture

Routes are thin: they load data through `src/lib/server/queries.ts` and render
it with components from `src/lib/components`.

- `src/lib/server/db.ts` — the in-memory store, seeded by `scripts/seed.ts`.
- `src/lib/server/queries.ts` — every read the UI does.
- `src/lib/utils/` — pure formatting helpers, unit-tested.

No client-side data fetching: pages are server-rendered and hydrate with the
same props.
