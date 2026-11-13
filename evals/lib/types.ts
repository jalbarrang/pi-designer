/**
 * Shapes for the designer eval harness.
 *
 * A case mirrors the Agent Skills eval format (prompt + expected outcome +
 * fixture) and adds assertions over the transcript, because designer's value is
 * behavior — reading `DESIGN.md` before touching UI, reaching for the Impeccable
 * skill, running `detect` instead of guessing — and prose alone cannot show it.
 *
 * Assertion kinds stay few on purpose: add one only when a case cannot be
 * expressed with what is here.
 */

/** A call matcher: any of `tools`, optionally filtered by a substring of `arg`. */
export type ToolSelector = {
  tools: string[];
  /** Substring the call's `path` (or the given `arg`) must contain. */
  pathIncludes?: string;
  /**
   * The call must be the first tool call of the run. That is the difference
   * between "consulted the file eventually" and "the advertisement told it
   * where to look first".
   */
  first?: boolean;
};

export type Assertion =
  | { id: string; kind: 'tool_called'; tool: string }
  | { id: string; kind: 'tool_not_called'; tool: string }
  | {
      id: string;
      kind: 'tool_args';
      tool: string;
      /** Subset match: every key here must equal the call's argument. */
      args?: Record<string, unknown>;
      /** Keys that must be omitted (or falsey) — the "no extra flags" check. */
      absent?: string[];
      /** Passes when any variant matches, e.g. `branch` vs its `base` alias. */
      anyOf?: Record<string, unknown>[];
    }
  | {
      /** Substring match on one string argument, e.g. `bash.command` contains `detect`. */
      id: string;
      kind: 'tool_args_contains';
      tool: string;
      arg: string;
      includes: string[];
      /**
       * Substrings the matching call's output must also contain. Without this a
       * command that *names* the tool passes even when the tool never ran —
       * `grep detect` is not `detect`.
       */
      resultIncludes?: string[];
    }
  | {
      /** Ordering: the `before` call must happen, and happen first. */
      id: string;
      kind: 'tool_order';
      before: ToolSelector;
      after: ToolSelector;
    }
  | {
      /** No call may match — the "did not go looking for a file that is absent" check. */
      id: string;
      kind: 'tool_not_called_matching';
      tool: string;
      arg: string;
      includes: string[];
    }
  | {
      id: string;
      kind: 'tool_result_text';
      tool: string;
      includes?: string[];
      excludes?: string[];
    }
  | {
      id: string;
      kind: 'assistant_text';
      includes?: string[];
      excludes?: string[];
      /** Regex source, case-insensitive. */
      matches?: string;
      /** Regex source that must NOT match. */
      notMatches?: string;
    }
  | {
      /**
       * A system prompt section, by name. `design_context` must be there when
       * the extension is loaded; `design_hook` must never be there again.
       */
      id: string;
      kind: 'system_prompt_section';
      name: string;
      /** PASS only when the section is absent. */
      absent?: boolean;
      includes?: string[];
      excludes?: string[];
    };

export type EvalCase = {
  id: string;
  /** A realistic user message. Vary phrasing across cases. */
  prompt: string;
  /** Directory under `evals/fixtures/`. */
  fixture: string;
  /** One sentence a second engineer would grade the same way. */
  expected: string;
  /** Config names this case runs in. Omit for all. */
  configs?: string[];
  assertions: Assertion[];
};

export type EvalConfig = {
  name: string;
  /** Load `extensions/designer` for this config. */
  extension: boolean;
  description?: string;
};

export type EvalsFile = {
  subject: string;
  description: string;
  configs: EvalConfig[];
  cases: EvalCase[];
};

/** `fixtures/<name>/fixture.json`. */
export type FixtureMeta = {
  description: string;
  /**
   * Run from this subdirectory of the fixture instead of its root. Monorepo
   * cases need it: discovery walks from cwd up to the repo root, so the package
   * is only "closest" when the run starts there.
   */
  cwd?: string;
  /** Copy `change/` and `git add` it, leaving it staged rather than applied. */
  staged?: boolean;
  /** Commit `change/` instead of leaving it uncommitted. */
  commitChange?: boolean;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Text the tool returned to the model. */
  resultText?: string;
  details?: unknown;
  isError?: boolean;
};

/** Parsed `pi --mode json` transcript. */
export type RunTrace = {
  calls: ToolCall[];
  /** Final assistant text — what the user sees. */
  assistantText: string;
  /** Every assistant text block, for debugging. */
  allAssistantText: string;
  /** System prompt sections, by name: the `design_context` surface. */
  systemSections: Record<string, string>;
  usage: { input: number; output: number; nested: number };
  events: number;
  parseErrors: number;
};

export type AssertionResult = {
  id: string;
  kind: Assertion['kind'];
  status: 'PASS' | 'FAIL' | 'SKIP';
  /** Quotes the actual output whenever possible. */
  evidence: string;
};

export type RunOutcome = 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT';

export type GradedRun = {
  caseId: string;
  config: string;
  trial: number;
  outcome: RunOutcome;
  assertions: AssertionResult[];
  durationMs: number;
  tokens: number;
  /** Set when the run itself did not complete. */
  error?: string;
};

export type Benchmark = {
  iteration: number;
  generatedAt: string;
  model: string;
  trials: number;
  configs: Record<
    string,
    {
      cases: {
        caseId: string;
        trials: number;
        passed: number;
        pass1: number;
        passK: number;
        medianMs: number;
        medianTokens: number;
      }[];
      summary: { meanPass1: number; casesAtPassK: number; cases: number };
    }
  >;
  delta: {
    /** False when only one config ran, so the delta is not meaningful. */
    comparable: boolean;
    pass1: number;
    medianMs: number;
    medianTokens: number;
  };
};
