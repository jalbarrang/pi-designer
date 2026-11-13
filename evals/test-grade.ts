#!/usr/bin/env bun
/**
 * Focused checks for the grader itself: the assertion kinds this package adds
 * (ordering, substring args, prompt sections) are the ones most likely to be
 * subtly wrong, and a broken grader reads as a broken agent.
 *
 *   bun evals/test-grade.ts
 *
 * No model calls and no pi: synthetic traces only.
 */

import { gradeAssertions } from './lib/grade';
import type { Assertion, RunTrace, ToolCall } from './lib/types';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, args };
}

function trace(calls: ToolCall[], sections: Record<string, string> = {}): RunTrace {
  return {
    calls,
    assistantText: 'Headings use Fraunces.',
    allAssistantText: 'Headings use Fraunces.',
    systemSections: sections,
    usage: { input: 0, output: 0, nested: 0 },
    events: 1,
    parseErrors: 0,
  };
}

const grade = (assertion: Assertion, t: RunTrace, extension = true, cwd = '/repo') =>
  gradeAssertions([assertion], { trace: t, extension, cwd })[0];

// --- tool_order -------------------------------------------------------------

const readFirst = trace([
  call('bash', { command: 'ls -la' }),
  call('read', { path: '/tmp/fixture/DESIGN.md' }),
  call('edit', { path: '/tmp/fixture/src/routes/pricing/+page.svelte' }),
]);

const orderAssertion: Assertion = {
  id: 'reads-design-md-first',
  kind: 'tool_order',
  before: { tools: ['read'], pathIncludes: 'DESIGN.md' },
  after: { tools: ['edit', 'write'] },
};

check('order: read before edit passes', grade(orderAssertion, readFirst).status, 'PASS');

const editFirst = trace([
  call('edit', { path: '/tmp/fixture/src/routes/pricing/+page.svelte' }),
  call('read', { path: '/tmp/fixture/DESIGN.md' }),
]);
check('order: edit before read fails', grade(orderAssertion, editFirst).status, 'FAIL');

check(
  'order: a read of another file does not count',
  grade(orderAssertion, trace([call('read', { path: '/tmp/fixture/src/app.css' }), call('edit', { path: 'x' })]))
    .status,
  'FAIL',
);

check(
  'order: no edit at all fails',
  grade(orderAssertion, trace([call('read', { path: '/tmp/fixture/DESIGN.md' })])).status,
  'FAIL',
);

// Monorepo case: the agent reads `DESIGN.md` relative to a package cwd, while
// the case names the file by its repo position. Both must match.
const packageCwd = '/repo/apps/console';
const monorepoOrder: Assertion = {
  id: 'reads-the-package-system',
  kind: 'tool_order',
  before: { tools: ['read', 'bash'], pathIncludes: 'apps/console/DESIGN.md', first: true },
  after: { tools: ['edit', 'write'] },
};
check(
  'order: a relative path resolves against the run cwd',
  grade(
    monorepoOrder,
    trace([call('read', { path: 'DESIGN.md' }), call('edit', { path: 'src/routes/pricing/+page.svelte' })]),
    true,
    packageCwd,
  ).status,
  'PASS',
);
check(
  'order: reading the root file does not satisfy the package selector',
  grade(
    monorepoOrder,
    trace([
      call('read', { path: '../../DESIGN.md' }),
      call('edit', { path: 'src/routes/pricing/+page.svelte' }),
    ]),
    true,
    packageCwd,
  ).status,
  'FAIL',
);
check(
  'order: a relative path inside a bash command resolves too',
  grade(
    monorepoOrder,
    trace([
      call('bash', { command: 'find . -type f | sort && cat DESIGN.md' }),
      call('edit', { path: 'src/routes/pricing/+page.svelte' }),
    ]),
    true,
    packageCwd,
  ).status,
  'PASS',
);
check(
  'order: first=true fails when another call comes before',
  grade(
    monorepoOrder,
    trace([
      call('bash', { command: 'ls -la' }),
      call('read', { path: 'DESIGN.md' }),
      call('edit', { path: 'src/routes/pricing/+page.svelte' }),
    ]),
    true,
    packageCwd,
  ).status,
  'FAIL',
);

// --- tool_args_contains / tool_not_called_matching --------------------------

const detectAssertion: Assertion = {
  id: 'runs-detect',
  kind: 'tool_args_contains',
  tool: 'bash',
  arg: 'command',
  includes: ['detect'],
};

check(
  'args_contains: launcher path passes',
  grade(detectAssertion, trace([call('bash', { command: 'IMP=~/.pi/agent/extensions/designer/skill/scripts/impeccable; $IMP detect src/' })]))
    .status,
  'PASS',
);
check(
  'args_contains: a command that only names the tool fails without its output',
  grade(
    { ...detectAssertion, resultIncludes: ['anti-pattern'] },
    trace([{ ...call('bash', { command: 'grep -r "detect" .' }), resultText: 'no matches' }]),
  ).status,
  'FAIL',
);
check(
  'args_contains: output from the real tool passes',
  grade(
    { ...detectAssertion, resultIncludes: ['anti-pattern'] },
    trace([{ ...call('bash', { command: '$IMP detect src/' }), resultText: '0 anti-patterns found.' }]),
  ).status,
  'PASS',
);
check(
  'args_contains: an unrelated command fails',
  grade(detectAssertion, trace([call('bash', { command: 'cat package.json' })])).status,
  'FAIL',
);
check('args_contains: no bash call fails', grade(detectAssertion, trace([])).status, 'FAIL');

const noDesignRead: Assertion = {
  id: 'no-design-md-read',
  kind: 'tool_not_called_matching',
  tool: 'read',
  arg: 'path',
  includes: ['DESIGN.md'],
};
check(
  'not_called_matching: reading DESIGN.md fails',
  grade(noDesignRead, trace([call('read', { path: '/tmp/fixture/DESIGN.md' })])).status,
  'FAIL',
);
check(
  'not_called_matching: reading something else passes',
  grade(noDesignRead, trace([call('read', { path: '/tmp/fixture/src/app.css' })])).status,
  'PASS',
);

// --- system_prompt_section --------------------------------------------------

const present: Assertion = {
  id: 'prompt-has-design-context',
  kind: 'system_prompt_section',
  name: 'design_context',
  includes: ['DESIGN.md', 'Northwind Console'],
};
check(
  'section: present with its text passes',
  grade(present, trace([], { design_context: 'This project documents its design in /tmp/x/DESIGN.md\nDesign system: Northwind Console' }))
    .status,
  'PASS',
);
check('section: missing fails', grade(present, trace([], {})).status, 'FAIL');
check(
  'section: present but empty text fails',
  grade(present, trace([], { design_context: '' })).status,
  'FAIL',
);
check(
  'section: presence is SKIP in the baseline',
  grade(present, trace([], {}), false).status,
  'SKIP',
);

const absent: Assertion = {
  id: 'prompt-has-no-hook-section',
  kind: 'system_prompt_section',
  name: 'design_hook',
  absent: true,
};
check('section: absent passes when gone', grade(absent, trace([], { design_context: 'x' })).status, 'PASS');
check(
  'section: absent fails when the hook section returns',
  grade(absent, trace([], { design_hook: 'The Impeccable design hook is active' })).status,
  'FAIL',
);

// --- assistant_text ---------------------------------------------------------

check(
  'text: notMatches catches a claim about a DESIGN.md that is not there',
  grade(
    {
      id: 'no-invented-design-system',
      kind: 'assistant_text',
      notMatches: '(according to|following|per) (the )?design\\.md',
    },
    { ...trace([]), assistantText: 'Following the DESIGN.md, I used the primary color.' },
  ).status,
  'FAIL',
);

if (failures > 0) {
  console.error(`\n${failures} grading check(s) failed`);
  process.exit(1);
}
console.log('\nall grading checks passed');
