/**
 * The engine's vocabulary, ported from Impeccable's Rust core
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Every type here exists in the engine on purpose: the rule catalog, the
 * findings the rules emit, and the surfaces a rule can run against. Splitting
 * them further would only add mapping code between shapes that are already
 * the same shape.
 */

/** Surface a rule evaluates. `regex` reads text, `static-html` a parsed file, `browser` a live DOM, `visual` rendered pixels. */
export type EngineName = "regex" | "static-html" | "browser" | "visual";

/** What a rule needs in front of it. The engines advertise the scopes they can serve. */
export type RuleScope = "source" | "page-analyzer" | "element" | "page" | "layout" | "visual-contrast";

/** Design domain a rule belongs to, for `--scope` narrowing. */
export type DesignScope = "type" | "layout";

/** What kind of problem a rule reports. `slop` is AI-tell, `quality` is craft. */
export type RuleCategory = "slop" | "quality";

/**
 * How loudly a finding speaks. `warning` is the default and is not declared on
 * a rule; `advisory` findings are reported but never counted as failures.
 */
export type Severity = "error" | "warning" | "advisory";

/** One rule in the catalog. The detector reports findings by `id`. */
export interface Antipattern {
	readonly id: string;
	readonly category: RuleCategory;
	readonly name: string;
	readonly description: string;
	/** Absent means `warning`. `advisory` never fails a run. */
	readonly severity?: Exclude<Severity, "warning">;
	/** Design domains this rule speaks to; absent means it belongs to none and survives `--scope` filtering. */
	readonly scopes?: readonly DesignScope[];
	readonly advisory?: boolean;
	readonly skillSection?: string;
	readonly skillGuideline?: string;
}

/**
 * One detected problem. Rules beyond the text engines add their own fields
 * (element selectors, measured values, evidence), so this base carries only
 * what every consumer needs: what, how bad, where, and the line to quote.
 */
export interface Finding {
	readonly antipattern: string;
	readonly name: string;
	readonly description: string;
	readonly severity: Severity;
	readonly category: RuleCategory | null;
	readonly file: string;
	readonly line: number;
	readonly snippet: string;
	/** Stamped only when true, so the common shape stays small. */
	readonly advisory?: boolean;
	/** The value a `hooks ignore-value` waiver can match, on rules that support waivers. */
	readonly ignoreValue?: string;
}
