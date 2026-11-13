#!/usr/bin/env bun
/**
 * Run the eval suite: one isolated pi session per case × config × trial.
 *
 *   bun evals/run-evals.ts                       # one trial, both configs (first pass)
 *   bun evals/run-evals.ts --trials 3 --model anthropic/claude-sonnet-4-5
 *   bun evals/run-evals.ts --cases audit-uses-playbook --configs with_extension
 *   bun evals/run-evals.ts --dry-run             # materialize fixtures, print commands
 *
 * Artifacts land in `evals/workspace/iteration-N/`; grade them again later with
 * `grade-evals.ts` (no model calls) after tightening assertions.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBenchmark, renderBenchmarkMarkdown } from './lib/benchmark';
import {
  EVALS_FILE,
  EXTENSION_PATH,
  WORKSPACE_DIR,
  materializeFixture,
} from './lib/fixtures';
import { gradeAssertions } from './lib/grade';
import { buildPiCommand, runPi } from './lib/run';
import { parseTranscript } from './lib/trace';
import type { EvalCase, EvalConfig, EvalsFile, GradedRun, RunOutcome } from './lib/types';

function flag(name: string): string | undefined {
  const prefix = `--${name}`;
  const index = process.argv.indexOf(prefix);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const list = (value: string | undefined): string[] | undefined =>
  value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined;

/** A typo in --cases must fail loudly: silently running fewer cases is worse. */
function assertKnown(name: string, wanted: string[] | undefined, known: string[]): void {
  const unknown = (wanted ?? []).filter((entry) => !known.includes(entry));
  if (unknown.length > 0) {
    throw new Error(`unknown ${name}: ${unknown.join(', ')} (known: ${known.join(', ')})`);
  }
}

async function nextIteration(): Promise<number> {
  try {
    const entries = await readdir(WORKSPACE_DIR);
    const numbers = entries
      .map((entry) => /^iteration-(\d+)$/.exec(entry))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  } catch {
    return 1;
  }
}

const FEEDBACK_TEMPLATE = {
  _instructions:
    'Per-case human review. Specific complaints only ("audited without reading the skill"), empty means the output looked fine. This file is never overwritten.',
};

async function main(): Promise<void> {
  const evals = JSON.parse(await readFile(EVALS_FILE, 'utf8')) as EvalsFile;
  const dryRun = hasFlag('dry-run');
  const trials = Math.max(1, Number(flag('trials') ?? 1));
  const timeoutMs = Number(flag('timeout') ?? 10 * 60 * 1000);
  const model = flag('model') ?? '';
  const iteration = Number(flag('iteration') ?? (await nextIteration()));
  const iterationDir = join(WORKSPACE_DIR, `iteration-${iteration}`);

  const wantedCases = list(flag('cases'));
  const wantedConfigs = list(flag('configs'));
  assertKnown('cases', wantedCases, evals.cases.map((entry) => entry.id));
  assertKnown('configs', wantedConfigs, evals.configs.map((entry) => entry.name));
  const cases = wantedCases
    ? evals.cases.filter((entry) => wantedCases.includes(entry.id))
    : evals.cases;
  const configs = wantedConfigs
    ? evals.configs.filter((entry) => wantedConfigs.includes(entry.name))
    : evals.configs;

  if (cases.length === 0) throw new Error('no cases matched --cases');
  if (configs.length === 0) throw new Error('no configs matched --configs');

  await mkdir(iterationDir, { recursive: true });
  await writeFile(
    join(iterationDir, 'iteration.json'),
    `${JSON.stringify(
      {
        iteration,
        createdAt: new Date().toISOString(),
        model: model || '(session default)',
        trials,
        configs: configs.map((config) => config.name),
        cases: cases.map((entry) => entry.id),
      },
      null,
      2,
    )}\n`,
  );

  const runs: GradedRun[] = [];
  const total = cases.reduce(
    (sum, entry) =>
      sum + configs.filter((c) => !entry.configs || entry.configs.includes(c.name)).length * trials,
    0,
  );
  let completed = 0;

  for (const evalCase of cases) {
    for (const config of configs) {
      if (evalCase.configs && !evalCase.configs.includes(config.name)) continue;

      for (let trial = 1; trial <= trials; trial++) {
        completed += 1;
        const run = await runOne({ evalCase, config, trial, iteration, iterationDir, model, timeoutMs, dryRun });
        if (run) runs.push(run);
        console.log(
          `[${completed}/${total}] ${evalCase.id} · ${config.name} · trial ${trial} → ${run?.outcome ?? 'dry'}`,
        );
      }
    }
  }

  if (dryRun) {
    console.log(`\nDry run — fixtures materialized under ${iterationDir}. No model calls made.`);
    return;
  }

  const benchmark = buildBenchmark({ iteration, model, trials, runs, cases, configs });
  await writeFile(join(iterationDir, 'benchmark.json'), `${JSON.stringify(benchmark, null, 2)}\n`);
  await writeFile(
    join(iterationDir, 'benchmark.md'),
    `${renderBenchmarkMarkdown(benchmark, runs)}\n`,
  );

  const feedbackPath = join(iterationDir, 'feedback.json');
  try {
    await readFile(feedbackPath);
  } catch {
    const feedback = { ...FEEDBACK_TEMPLATE } as Record<string, unknown>;
    for (const evalCase of cases) feedback[evalCase.id] = '';
    await writeFile(feedbackPath, `${JSON.stringify(feedback, null, 2)}\n`);
  }

  console.log(`\n${renderBenchmarkMarkdown(benchmark, runs)}`);
  console.log(`\nArtifacts: ${iterationDir}`);
  console.log(`Transcripts: ${join(iterationDir, 'cases')}/<case>/<config>/run-N/transcript.jsonl`);
  console.log('Read a few transcripts before trusting the numbers, then fill in feedback.json.');
}

type RunOneArgs = {
  evalCase: EvalCase;
  config: EvalConfig;
  trial: number;
  iteration: number;
  iterationDir: string;
  model: string;
  timeoutMs: number;
  dryRun: boolean;
};

async function runOne(args: RunOneArgs): Promise<GradedRun | undefined> {
  const { evalCase, config, trial, iteration, iterationDir, model, timeoutMs, dryRun } = args;
  const runDir = join(iterationDir, 'cases', evalCase.id, config.name, `run-${trial}`);
  await mkdir(runDir, { recursive: true });

  // The fixture lives outside the extension tree on purpose. A cwd under
  // `extensions/designer/evals/...` tells the agent where designer lives, so a
  // run without the extension can still find its launcher and read its README —
  // the baseline stops being a baseline. /tmp leaks nothing.
  const fixtureDir = join(
    tmpdir(),
    'designer-evals',
    `iteration-${iteration}`,
    evalCase.id,
    config.name,
    `run-${trial}`,
  );
  const fixture = await materializeFixture(evalCase.fixture, fixtureDir);
  await writeFile(join(runDir, 'prompt.txt'), `${evalCase.prompt}\n`);

  const command = buildPiCommand({
    extensionPath: config.extension ? EXTENSION_PATH : undefined,
    model: model || undefined,
    sessionDir: join(runDir, 'sessions'),
    prompt: evalCase.prompt,
  });

  if (dryRun) {
    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify({ caseId: evalCase.id, config: config.name, trial, status: 'dry', command, cwd: fixture.cwd }, null, 2)}\n`,
    );
    console.log(`\ncd ${fixture.cwd}\npi ${command.map((arg) => (arg.includes(' ') ? `'${arg}'` : arg)).join(' ')}\n`);
    return undefined;
  }

  const result = await runPi(command, fixture.cwd, timeoutMs);
  await writeFile(join(runDir, 'transcript.jsonl'), result.stdout);
  await writeFile(join(runDir, 'stderr.log'), result.stderr);

  const trace = parseTranscript(result.stdout);
  await writeFile(join(runDir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(join(runDir, 'output.md'), `${trace.assistantText}\n`);

  const assertions = gradeAssertions(evalCase.assertions, {
    trace,
    extension: config.extension,
    cwd: fixture.cwd,
  });

  const outcome: RunOutcome =
    result.status === 'timeout'
      ? 'TIMEOUT'
      : result.status !== 'ok'
        ? 'ERROR'
        : trace.events === 0
          ? 'ERROR'
          : assertions.some((assertion) => assertion.status === 'FAIL')
            ? 'FAIL'
            : 'PASS';

  const error =
    result.status === 'timeout'
      ? `timed out after ${timeoutMs} ms`
      : result.status !== 'ok'
        ? `pi exited ${result.exitCode ?? 'null'} — see stderr.log`
        : trace.events === 0
          ? 'no JSONL events parsed — see stderr.log'
          : undefined;

  const tokens = trace.usage.input + trace.usage.output + trace.usage.nested;

  await writeFile(
    join(runDir, 'run.json'),
    `${JSON.stringify(
      {
        caseId: evalCase.id,
        config: config.name,
        trial,
        status: result.status,
        outcome,
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        fixture: evalCase.fixture,
        fixtureDir: fixture.dir,
        cwd: fixture.cwd,
        model: model || '(session default)',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(runDir, 'timing.json'),
    `${JSON.stringify({ durationMs: result.durationMs, usage: trace.usage, tokens }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, 'grade.json'),
    `${JSON.stringify({ caseId: evalCase.id, config: config.name, trial, outcome, assertions }, null, 2)}\n`,
  );

  return {
    caseId: evalCase.id,
    config: config.name,
    trial,
    outcome,
    assertions,
    durationMs: result.durationMs,
    tokens,
    error,
  };
}

await main();
