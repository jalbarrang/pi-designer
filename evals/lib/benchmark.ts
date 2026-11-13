/**
 * Aggregate graded runs into a benchmark.
 *
 * Two numbers per case and config:
 *   pass@1 — share of trials that passed (the fraction of the time it works)
 *   pass^k — 1 only when every trial passed (the share of cases that are
 *            reliable). Anthropic calls this the bar that matches user
 *            expectations; a 75% per-trial case passes k=3 only ~42% of the
 *            time.
 *
 * The assertion table exists for pruning: assertions that pass in every config
 * measure nothing, and assertions that fail in every config are usually broken
 * checks rather than broken behavior.
 */

import type { Benchmark, EvalCase, EvalConfig, GradedRun } from './types';

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

const ratio = (passed: number, total: number): number =>
  total === 0 ? 0 : Number((passed / total).toFixed(3));

export function buildBenchmark(input: {
  iteration: number;
  model: string;
  trials: number;
  runs: GradedRun[];
  cases: EvalCase[];
  configs: EvalConfig[];
}): Benchmark {
  const { iteration, model, trials, runs, cases, configs } = input;

  const perConfig = Object.fromEntries(
    configs.map((config) => {
      const caseRows = cases
        .filter((evalCase) => runs.some((run) => run.caseId === evalCase.id && run.config === config.name))
        .map((evalCase) => {
          const caseRuns = runs.filter(
            (run) => run.caseId === evalCase.id && run.config === config.name,
          );
          const passed = caseRuns.filter((run) => run.outcome === 'PASS').length;
          return {
            caseId: evalCase.id,
            trials: caseRuns.length,
            passed,
            pass1: ratio(passed, caseRuns.length),
            passK: caseRuns.length > 0 && passed === caseRuns.length ? 1 : 0,
            medianMs: median(caseRuns.map((run) => run.durationMs)),
            medianTokens: median(caseRuns.map((run) => run.tokens)),
          };
        });

      return [
        config.name,
        {
          cases: caseRows,
          summary: {
            meanPass1: ratio(
              caseRows.reduce((sum, row) => sum + row.pass1, 0),
              caseRows.length,
            ),
            casesAtPassK: caseRows.filter((row) => row.passK === 1).length,
            cases: caseRows.length,
          },
        },
      ];
    }),
  );

  const withName = withConfigName(perConfig);
  const withoutName = withoutConfigName(perConfig);
  const withConfig = perConfig[withName];
  const withoutConfig = perConfig[withoutName];

  const withRuns = runs.filter((run) => run.config === withName);
  const withoutRuns = runs.filter((run) => run.config === withoutName);

  const comparable =
    withName !== '' &&
    withoutName !== '' &&
    withName !== withoutName &&
    withRuns.length > 0 &&
    withoutRuns.length > 0;

  return {
    iteration,
    generatedAt: new Date().toISOString(),
    model: model || '(session default)',
    trials,
    configs: perConfig,
    delta: comparable
      ? {
          comparable: true,
          pass1: Number(
            ((withConfig?.summary.meanPass1 ?? 0) - (withoutConfig?.summary.meanPass1 ?? 0)).toFixed(
              3,
            ),
          ),
          // Cost delta is with-extension minus without; positive means it costs more.
          medianMs:
            median(withRuns.map((run) => run.durationMs)) -
            median(withoutRuns.map((run) => run.durationMs)),
          medianTokens:
            median(withRuns.map((run) => run.tokens)) -
            median(withoutRuns.map((run) => run.tokens)),
        }
      : { comparable: false, pass1: 0, medianMs: 0, medianTokens: 0 },
  };
}

function withConfigName(perConfig: Record<string, unknown>): string {
  if ('with_extension' in perConfig) return 'with_extension';
  return Object.keys(perConfig)[0] ?? '';
}

function withoutConfigName(perConfig: Record<string, unknown>): string {
  if ('without_extension' in perConfig) return 'without_extension';
  return Object.keys(perConfig)[1] ?? '';
}

export function renderBenchmarkMarkdown(benchmark: Benchmark, runs: GradedRun[]): string {
  const configNames = Object.keys(benchmark.configs);
  const caseIds = [...new Set(runs.map((run) => run.caseId))].sort();

  const header = [
    '| case | ' + configNames.map((name) => `${name} pass@1 / pass^k`).join(' | ') + ' |',
    '| --- | ' + configNames.map(() => '---').join(' | ') + ' |',
  ];

  const rows = caseIds.map((caseId) => {
    const cells = configNames.map((name) => {
      const row = benchmark.configs[name]?.cases.find((entry) => entry.caseId === caseId);
      return row ? `${row.passed}/${row.trials} · k=${row.passK}` : '—';
    });
    return `| ${caseId} | ${cells.join(' | ')} |`;
  });

  const summary = configNames.map((name) => {
    const summaryRow = benchmark.configs[name]?.summary;
    return summaryRow
      ? `${(summaryRow.meanPass1 * 100).toFixed(0)}% mean pass@1 · ${summaryRow.casesAtPassK}/${summaryRow.cases} reliable`
      : '—';
  });

  const assertionStats = new Map<
    string,
    { config: string; id: string; pass: number; fail: number; skip: number }
  >();
  for (const run of runs) {
    for (const assertion of run.assertions) {
      const key = `${run.config}::${assertion.id}`;
      const entry = assertionStats.get(key) ?? {
        config: run.config,
        id: assertion.id,
        pass: 0,
        fail: 0,
        skip: 0,
      };
      if (assertion.status === 'PASS') entry.pass += 1;
      if (assertion.status === 'FAIL') entry.fail += 1;
      if (assertion.status === 'SKIP') entry.skip += 1;
      assertionStats.set(key, entry);
    }
  }

  const assertionRows = [...assertionStats.values()]
    .sort((a, b) => a.id.localeCompare(b.id) || a.config.localeCompare(b.config))
    .map(
      (entry) => `| ${entry.id} | ${entry.config} | ${entry.pass} | ${entry.fail} | ${entry.skip} |`,
    );

  return [
    `# Evals — iteration ${benchmark.iteration}`,
    '',
    `Model: \`${benchmark.model}\` · trials per case: ${benchmark.trials} · generated ${benchmark.generatedAt}`,
    '',
    '## Cases',
    '',
    ...header,
    ...rows,
    `| **summary** | ${summary.join(' | ')} |`,
    '',
    `Delta (with − without): ${
      benchmark.delta.comparable
        ? `pass@1 ${benchmark.delta.pass1 >= 0 ? '+' : ''}${benchmark.delta.pass1}, ` +
          `${benchmark.delta.medianMs >= 0 ? '+' : ''}${benchmark.delta.medianMs} ms, ` +
          `${benchmark.delta.medianTokens >= 0 ? '+' : ''}${benchmark.delta.medianTokens} tokens per case (median).`
        : 'n/a — both configs must run for a delta.'
    }`,
    '',
    '## Assertions',
    '',
    'Prune with this table: PASS everywhere in both configs → the assertion measures nothing.',
    'FAIL everywhere in both → the assertion is probably broken. PASS with the extension and',
    'FAIL without → that is the signal you are buying.',
    '',
    '| assertion | config | pass | fail | skip |',
    '| --- | --- | --- | --- | --- |',
    ...assertionRows,
    '',
  ].join('\n');
}
