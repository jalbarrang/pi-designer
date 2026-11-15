/**
 * Inline, in-file ignore directives: waivers that live at the point they apply
 * and travel with the artifact instead of the config. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A config ignore is the right default for repo-wide policy. This covers the
 * one case config cannot: a waiver that belongs to a single file and follows it
 * out of the repo — a generated standalone document, an emailed HTML file, a
 * snippet scanned out of context.
 *
 * Comment-syntax agnostic: the directive is a raw token matched anywhere on a
 * line, so one marker works in `//`, `/* *\/`, `<!-- -->`, `#`, `{/* *\/}`.
 *
 *   impeccable-disable <rule>[,...] [-- reason]   whole file
 *   impeccable-disable-line ...                   the same line
 *   impeccable-disable-next-line ...              the following line
 *   impeccable-disable                            bare or `*` = every rule
 *
 * The reason is optional and discarded at scan time; it exists for the reader.
 */
import type { Finding } from "../../types.ts";

interface InlineIgnores {
	/** Rules disabled for the whole file. `*` means every rule. */
	readonly file: Set<string>;
	/** 1-based target line to rules disabled on that exact line. */
	readonly line: Map<number, Set<string>>;
	/** 1-based target line to rules disabled there by a `disable-next-line` above it. */
	readonly nextLine: Map<number, Set<string>>;
}

const DIRECTIVE_RE = /impeccable-(disable-next-line|disable-line|disable)\b[ \t]*([^\n\r]*)/gi;

// Trailing comment closers, so `*/`, `-->`, `#}` and friends do not leak into
// the rule list. Anchored to end of line; `--+>` covers `-->` and longer runs.
const TRAILING_CLOSER_RE = /\s*(?:\*\/\}?|--+>|\*\}|#\}|%>|\}\})\s*$/;

function normalizeRule(token: string): string {
	return String(token || "").trim().toLowerCase();
}

// Rule ids only ever contain single hyphens, so `--` and `:` are unambiguous
// separators between the rule list and a human reason.
function parseRuleList(remainder: string): string[] {
	let text = String(remainder || "").replace(TRAILING_CLOSER_RE, "").trim();
	const reasonSep = text.match(/\s*(?:--+|:)\s*/);
	if (reasonSep?.index !== undefined) text = text.slice(0, reasonSep.index);
	const tokens = text.split(/[\s,]+/).map(normalizeRule).filter(Boolean);
	if (tokens.length === 0 || tokens.includes("*")) return ["*"];
	return tokens;
}

function addRules(set: Set<string>, rules: readonly string[]): void {
	for (const rule of rules) set.add(rule);
}

function getSet(map: Map<number, Set<string>>, key: number): Set<string> {
	const existing = map.get(key);
	if (existing) return existing;
	const created = new Set<string>();
	map.set(key, created);
	return created;
}

/**
 * Parse every inline ignore directive in a file's raw text, keyed by the 1-based
 * line the directive targets, so matching a finding is a direct lookup.
 */
function parseInlineIgnores(content: string | null | undefined): InlineIgnores {
	const result: InlineIgnores = { file: new Set(), line: new Map(), nextLine: new Map() };
	const text = typeof content === "string" ? content : "";
	if (!/impeccable-disable/i.test(text)) return result;

	// Split on `\n` only, exactly as the text engine numbers lines, so directive
	// keys line up with finding line numbers.
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		DIRECTIVE_RE.lastIndex = 0;
		for (let m = DIRECTIVE_RE.exec(lines[i]); m !== null; m = DIRECTIVE_RE.exec(lines[i])) {
			const variant = m[1].toLowerCase();
			const rules = parseRuleList(m[2]);
			if (variant === "disable") addRules(result.file, rules);
			else if (variant === "disable-line") addRules(getSet(result.line, i + 1), rules);
			// A `disable-next-line` on line i+1 targets line i+2.
			else addRules(getSet(result.nextLine, i + 2), rules);
		}
	}
	return result;
}

function setMatches(set: Set<string> | undefined, rule: string): boolean {
	if (!set) return false;
	return set.has("*") || set.has(rule);
}

function isInlineIgnored(finding: Pick<Finding, "antipattern" | "line">, directives: InlineIgnores): boolean {
	const rule = normalizeRule(finding.antipattern);
	if (!rule) return false;
	if (setMatches(directives.file, rule)) return true;
	const line = Number(finding.line) || 0;
	if (line > 0) {
		if (setMatches(directives.line.get(line), rule)) return true;
		if (setMatches(directives.nextLine.get(line), rule)) return true;
	}
	return false;
}

function hasDirectives(directives: InlineIgnores): boolean {
	return directives.file.size > 0 || directives.line.size > 0 || directives.nextLine.size > 0;
}

/**
 * Drop findings waived by an inline directive in the same file's source text.
 * Findings without a usable line number (page-level ones) only match a
 * whole-file directive, which is the standalone-document case this exists for.
 */
function applyInlineIgnores<T extends Pick<Finding, "antipattern" | "line">>(
	findings: readonly T[],
	content: string | null | undefined,
): readonly T[] {
	if (findings.length === 0) return findings;
	const directives = parseInlineIgnores(content);
	if (!hasDirectives(directives)) return findings;
	return findings.filter((finding) => !isInlineIgnored(finding, directives));
}

export { parseInlineIgnores, applyInlineIgnores, isInlineIgnored };
export type { InlineIgnores };
