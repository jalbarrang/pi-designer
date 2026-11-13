# Runbook

## A report is slow

1. Check `queries.ts` for an unbounded scan.
2. Reproduce with `bun run seed --events=100000`.
3. Profile before touching the query.
