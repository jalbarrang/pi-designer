#!/usr/bin/env bun
/**
 * Re-grade a finished iteration without making a single model call.
 *
 * Use this after tightening assertions: the transcripts and traces are already
 * on disk, so grading is free. New runs are a separate iteration, so a score
 * change is never confused with a grading change.
 *
 *   bun evals/grade-evals.ts                 # latest iteration
 *   bun evals/grade-evals.ts --iteration 2
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildBenchmark, renderBenchmarkMarkdown } from './lib/benchmark';
import { EVALS_FILE, WORKSPACE_DIR } from './lib/fixtures';
import { gradeAssertions } from './lib/grade';
import type { EvalCase, EvalConfig, EvalsFile, GradedRun, RunOutcome, RunTrace } from './lib/types';

type RunMeta = {
  caseId: string;
  config: string;
  trial: number;
  status: string;
  outcome?: RunOutcome;
  durationMs?: number;
  /** The run's working directory; relative `path` arguments resolve against it. */
  cwd?: string;
  model?: string;
};

function flag(name: string): string | undefined {
  const prefix = `--${name}`;
  const index = process.argv.indexOf(prefix);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function latestIteration(): Promise<number> {
  const entries = await directories(WORKSPACE_DIR);
  const numbers = entries
    .map((entry) => /^iteration-(\d+)$/.exec(entry))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  if (numbers.length === 0) throw new Error('no iterations yet — run `bun evals/run-evals.ts` first');
  return Math.max(...numbers);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  const evals = await readJson<EvalsFile>(EVALS_FILE);
  const iteration = Number(flag('iteration') ?? (await latestIteration()));
  const iterationDir = join(WORKSPACE_DIR, `iteration-${iteration}`);
  const meta = await readJson<{
    model: string;
    trials: number;
    configs: string[];
    cases: string[];
  }>(join(iterationDir, 'iteration.json'));

  const casesById = new Map(evals.cases.map((entry) => [entry.id, entry]));
  const configs: EvalConfig[] = evals.configs.filter((config) => meta.configs.includes(config.name));
  const runs: GradedRun[] = [];
  const seenCases = new Set<string>();

  for (const caseId of await directories(join(iterationDir, 'cases'))) {
    const evalCase = casesById.get(caseId);
    if (!evalCase) {
      console.warn(`skip ${caseId}: not in evals.json`);
      continue;
    }
    seenCases.add(caseId);

    for (const configName of await directories(join(iterationDir, 'cases', caseId))) {
      const config = configs.find((entry) => entry.name === configName);
      if (!config) {
        console.warn(`skip ${caseId}/${configName}: config not in this iteration`);
        continue;
      }

      for (const runName of await directories(join(iterationDir, 'cases', caseId, configName))) {
        if (!/^run-\d+$/.test(runName)) continue;
        const runDir = join(iterationDir, 'cases', caseId, configName, runName);
        const run = await readJson<RunMeta>(join(runDir, 'run.json'));
        if (run.status === 'dry') continue;

        const trace = await readJson<RunTrace>(join(runDir, 'trace.json'));
        const assertions = gradeAssertions(evalCase.assertions, {
          trace,
          extension: config.extension,
          cwd: run.cwd ?? '',
        });

        const outcome: RunOutcome =
          run.status === 'timeout'
            ? 'TIMEOUT'
            : run.status !== 'ok' || trace.events === 0
              ? 'ERROR'
              : assertions.some((assertion) => assertion.status === 'FAIL')
                ? 'FAIL'
                : 'PASS';

        await writeFile(
          join(runDir, 'grade.json'),
          `${JSON.stringify(
            { caseId, config: configName, trial: run.trial, outcome, assertions },
            null,
            2,
          )}\n`,
        );

        runs.push({
          caseId,
          config: configName,
          trial: run.trial,
          outcome,
          assertions,
          durationMs: run.durationMs ?? 0,
          tokens: trace.usage.input + trace.usage.output + trace.usage.nested,
        });
      }
    }
  }

  if (runs.length === 0) throw new Error(`no runs found under ${iterationDir}`);

  const cases: EvalCase[] = evals.cases.filter((entry) => seenCases.has(entry.id));
  const benchmark = buildBenchmark({
    iteration,
    model: meta.model,
    trials: meta.trials,
    runs,
    cases,
    configs,
  });
  await mkdir(iterationDir, { recursive: true });
  await writeFile(join(iterationDir, 'benchmark.json'), `${JSON.stringify(benchmark, null, 2)}\n`);
  await writeFile(
    join(iterationDir, 'benchmark.md'),
    `${renderBenchmarkMarkdown(benchmark, runs)}\n`,
  );

  console.log(renderBenchmarkMarkdown(benchmark, runs));
  console.log(`\nRe-graded ${runs.length} runs in ${iterationDir}`);
}

await main();
