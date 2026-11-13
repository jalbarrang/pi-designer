/**
 * Assertion grading.
 *
 * Every result carries evidence quoting the actual output, because a bare
 * PASS/FAIL tells you nothing when you come back to a transcript a week later.
 * These checks are code, not an LLM judge: deterministic and free.
 */

import { join } from 'node:path';

import type { Assertion, AssertionResult, RunTrace, ToolCall, ToolSelector } from './types';

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined;

const quote = (value: string, max = 180): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const show = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
};

const valueAt = (root: unknown, path: string): unknown =>
  path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, key) => asObj(acc)?.[key], root);

const matchesSubset = (actual: Obj, expected: Obj): boolean =>
  Object.entries(expected).every(([key, value]) => show(actual[key]) === show(value));

/** A flag counts as not passed when it is missing, false, or an empty value. */
const isAbsent = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value as Obj).length === 0;
};

const findCall = (trace: RunTrace, tool: string): ToolCall | undefined =>
  [...trace.calls].reverse().find((call) => call.name === tool);

const includesAll = (haystack: string, needles: string[]): string[] => {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => !lower.includes(needle.toLowerCase()));
};

/** Text a selector may look at: `read`/`edit`/`write` carry `path`, `bash` a `command`. */
const selectorText = (call: ToolCall, cwd: string): string => {
  const command = String(call.args.command ?? '');
  return `${resolveArg(call, 'path', cwd)} ${command} ${resolveCommandPaths(command, cwd)}`;
};

/**
 * Resolve the path-like tokens of a shell command against the run cwd.
 *
 * `cat DESIGN.md` from `apps/console` is a read of the package file, but the
 * command text never says so. Without this, a monorepo selector can only match
 * agents that happen to use the `read` tool or absolute paths.
 */
function resolveCommandPaths(command: string, cwd: string): string {
  if (cwd === '' || command === '') return '';
  return command
    .split(/[\s;&|()<>"']+/)
    .filter((token) => token.includes('/') || /\.[a-z]{2,4}$/i.test(token))
    .map((token) => (token.startsWith('/') ? token : join(cwd, token)))
    .join(' ');
}

/**
 * Resolve a `path` argument against the run's cwd. Agents use relative paths
 * (`DESIGN.md`), while cases name files by their position in the repo
 * (`apps/console/DESIGN.md`); without this, a monorepo case cannot tell the two
 * files apart.
 */
function resolveArg(call: ToolCall, arg: string, cwd: string): string {
  const value = String(call.args[arg] ?? '');
  if (arg !== 'path' || value === '' || value.startsWith('/') || cwd === '') return value;
  return join(cwd, value);
}

const selectorIndex = (trace: RunTrace, selector: ToolSelector, cwd: string): number =>
  trace.calls.findIndex(
    (call) =>
      selector.tools.includes(call.name) &&
      (selector.pathIncludes === undefined || selectorText(call, cwd).includes(selector.pathIncludes)),
  );

const selectorLabel = (selector: ToolSelector): string =>
  selector.pathIncludes
    ? `${selector.tools.join('|')} matching "${selector.pathIncludes}"`
    : selector.tools.join('|');

export type GradeContext = {
  trace: RunTrace;
  /** Whether the extension (and therefore its prompt section) was loaded. */
  extension: boolean;
  /** The run's working directory, used to resolve relative `path` arguments. */
  cwd: string;
};

export function gradeAssertions(assertions: Assertion[], ctx: GradeContext): AssertionResult[] {
  return assertions.map((assertion) => gradeOne(assertion, ctx));
}

function gradeOne(assertion: Assertion, ctx: GradeContext): AssertionResult {
  const { trace, extension, cwd } = ctx;
  const base = { id: assertion.id, kind: assertion.kind };

  // A section that only the extension can inject is unanswerable in the
  // baseline. Skipping (not failing) keeps the without-extension run honest:
  // there the signal is what the agent does with no advertisement at all.
  if (
    assertion.kind === 'system_prompt_section' &&
    !assertion.absent &&
    !extension
  ) {
    return {
      ...base,
      status: 'SKIP',
      evidence: 'extension not loaded in this config — section cannot be present',
    };
  }

  switch (assertion.kind) {
    case 'tool_called': {
      const call = findCall(trace, assertion.tool);
      return call
        ? { ...base, status: 'PASS', evidence: `${assertion.tool} called with ${show(call.args)}` }
        : {
            ...base,
            status: 'FAIL',
            evidence: `no ${assertion.tool} call; tools used: ${usedTools(trace)}`,
          };
    }

    case 'tool_not_called': {
      const call = findCall(trace, assertion.tool);
      return call
        ? { ...base, status: 'FAIL', evidence: `${assertion.tool} was called with ${show(call.args)}` }
        : { ...base, status: 'PASS', evidence: `${assertion.tool} not called` };
    }

    case 'tool_args': {
      const call = findCall(trace, assertion.tool);
      if (!call) {
        return { ...base, status: 'FAIL', evidence: `${assertion.tool} was not called` };
      }
      const problems: string[] = [];

      if (assertion.args) {
        for (const [key, expected] of Object.entries(assertion.args)) {
          if (show(call.args[key]) !== show(expected)) {
            problems.push(`arg.${key} = ${show(call.args[key])}, expected ${show(expected)}`);
          }
        }
      }
      for (const key of assertion.absent ?? []) {
        if (!isAbsent(call.args[key])) {
          problems.push(`arg.${key} should be omitted, got ${show(call.args[key])}`);
        }
      }
      if (assertion.anyOf && !assertion.anyOf.some((variant) => matchesSubset(call.args, variant))) {
        problems.push(`args matched none of ${assertion.anyOf.map(show).join(' | ')}`);
      }

      return problems.length === 0
        ? { ...base, status: 'PASS', evidence: `${assertion.tool} args ${show(call.args)}` }
        : { ...base, status: 'FAIL', evidence: problems.join('; ') };
    }

    case 'tool_args_contains': {
      const calls = trace.calls.filter((call) => call.name === assertion.tool);
      if (calls.length === 0) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `no ${assertion.tool} call; tools used: ${usedTools(trace)}`,
        };
      }
      const hit = calls.find(
        (call) =>
          includesAll(resolveArg(call, assertion.arg, cwd), assertion.includes).length === 0 &&
          includesAll(call.resultText ?? '', assertion.resultIncludes ?? []).length === 0,
      );
      if (hit) {
        return {
          ...base,
          status: 'PASS',
          evidence: `${assertion.tool}.${assertion.arg}: "${quote(resolveArg(hit, assertion.arg, cwd))}"`,
        };
      }
      const named = calls.filter(
        (call) => includesAll(resolveArg(call, assertion.arg, cwd), assertion.includes).length === 0,
      );
      return {
        ...base,
        status: 'FAIL',
        evidence:
          named.length > 0
            ? `${assertion.tool}.${assertion.arg} matched, but the output lacked ${(assertion.resultIncludes ?? []).join(', ')}: "${quote(named.map((call) => call.resultText ?? '').join(' '))}"`
            : `no ${assertion.tool}.${assertion.arg} contained ${assertion.includes.join(', ')}; saw ${calls
                .map((call) => `"${quote(resolveArg(call, assertion.arg, cwd), 90)}"`)
                .join(', ')}`,
      };
    }

    case 'tool_order': {
      const beforeIndex = selectorIndex(trace, assertion.before, cwd);
      const afterIndex = selectorIndex(trace, assertion.after, cwd);
      if (beforeIndex === -1) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `never called ${selectorLabel(assertion.before)}; tools used: ${usedTools(trace)}`,
        };
      }
      if (assertion.before.first && beforeIndex !== 0) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `${selectorLabel(assertion.before)} was call #${beforeIndex}, not the first (call #0: ${trace.calls[0]?.name ?? '(none)'})`,
        };
      }
      if (afterIndex === -1) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `${selectorLabel(assertion.before)} ran, but ${selectorLabel(assertion.after)} never did`,
        };
      }
      return beforeIndex < afterIndex
        ? {
            ...base,
            status: 'PASS',
            evidence: `#${beforeIndex} ${selectorLabel(assertion.before)} before #${afterIndex} ${selectorLabel(assertion.after)}`,
          }
        : {
            ...base,
            status: 'FAIL',
            evidence: `#${afterIndex} ${selectorLabel(assertion.after)} came before #${beforeIndex} ${selectorLabel(assertion.before)}`,
          };
    }

    case 'tool_not_called_matching': {
      const hit = trace.calls.find(
        (call) =>
          call.name === assertion.tool &&
          includesAll(resolveArg(call, assertion.arg, cwd), assertion.includes).length === 0,
      );
      return hit
        ? {
            ...base,
            status: 'FAIL',
            evidence: `${assertion.tool} reached ${assertion.includes.join(', ')}: "${quote(resolveArg(hit, assertion.arg, cwd))}"`,
          }
        : {
            ...base,
            status: 'PASS',
            evidence: `no ${assertion.tool} call touched ${assertion.includes.join(', ')}`,
          };
    }

    case 'tool_result_text': {
      const call = [...trace.calls]
        .reverse()
        .find((entry) => entry.name === assertion.tool && entry.resultText !== undefined);
      if (!call) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `${assertion.tool} returned no text result; tools used: ${usedTools(trace)}`,
        };
      }
      const text = call.resultText ?? '';
      const missing = includesAll(text, assertion.includes ?? []);
      const present = (assertion.excludes ?? []).filter((needle) =>
        text.toLowerCase().includes(needle.toLowerCase()),
      );
      const problems = [
        ...missing.map((needle) => `missing "${needle}"`),
        ...present.map((needle) => `unexpected "${needle}"`),
      ];
      return problems.length === 0
        ? { ...base, status: 'PASS', evidence: `result: "${quote(text)}"` }
        : { ...base, status: 'FAIL', evidence: `${problems.join('; ')} — result: "${quote(text)}"` };
    }

    case 'assistant_text': {
      const text = trace.assistantText;
      const problems: string[] = [
        ...includesAll(text, assertion.includes ?? []).map((needle) => `missing "${needle}"`),
        ...(assertion.excludes ?? [])
          .filter((needle) => text.toLowerCase().includes(needle.toLowerCase()))
          .map((needle) => `unexpected "${needle}"`),
      ];
      if (assertion.matches) {
        try {
          if (!new RegExp(assertion.matches, 'i').test(text)) {
            problems.push(`no match for /${assertion.matches}/i`);
          }
        } catch (cause) {
          problems.push(
            `invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      if (assertion.notMatches) {
        try {
          const hit = text.match(new RegExp(assertion.notMatches, 'i'));
          if (hit) problems.push(`unexpected /${assertion.notMatches}/i: "${quote(hit[0])}"`);
        } catch (cause) {
          problems.push(
            `invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      return problems.length === 0
        ? { ...base, status: 'PASS', evidence: `final answer: "${quote(text)}"` }
        : {
            ...base,
            status: 'FAIL',
            evidence: `${problems.join('; ')} — final answer: "${quote(text)}"`,
          };
    }

    case 'system_prompt_section': {
      const section = trace.systemSections[assertion.name];
      const known = Object.keys(trace.systemSections);

      if (assertion.absent) {
        return section === undefined
          ? {
              ...base,
              status: 'PASS',
              evidence: `no "${assertion.name}" section (sections: ${known.join(', ') || '(none)'})`,
            }
          : {
              ...base,
              status: 'FAIL',
              evidence: `"${assertion.name}" is still in the prompt: "${quote(section)}"`,
            };
      }

      if (section === undefined) {
        return {
          ...base,
          status: 'FAIL',
          evidence: `no "${assertion.name}" section; sections: ${known.join(', ') || '(none)'}`,
        };
      }

      const problems = [
        ...includesAll(section, assertion.includes ?? []).map((needle) => `missing "${needle}"`),
        ...(assertion.excludes ?? [])
          .filter((needle) => section.toLowerCase().includes(needle.toLowerCase()))
          .map((needle) => `unexpected "${needle}"`),
      ];
      return problems.length === 0
        ? { ...base, status: 'PASS', evidence: `"${assertion.name}": "${quote(section)}"` }
        : {
            ...base,
            status: 'FAIL',
            evidence: `${problems.join('; ')} — "${assertion.name}": "${quote(section)}"`,
          };
    }
  }
}

function usedTools(trace: RunTrace): string {
  const names = [...new Set(trace.calls.map((call) => call.name))];
  return names.length > 0 ? names.join(', ') : '(none)';
}
