/**
 * Element-scoped ignore directives, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Any element carrying `data-impeccable-ignore="rule-a rule-b"` (or `*`, or an
 * empty value for every rule) suppresses matching findings from itself and its
 * whole subtree, in every engine that walks elements. This is the DOM twin of
 * the line-based `impeccable-disable` comments, which a live DOM cannot use
 * because it has no line numbers. The intended use is a curated exhibit: a page
 * documenting anti-patterns by example marks the container once and every engine
 * skips it while still scanning around it.
 */

/**
 * The slice of an Element this needs. pi gets a DOM from its browser tooling and
 * a parser from the static engine, so the check takes the shape rather than a
 * concrete class.
 */
export interface ScopedIgnoreElement {
	readonly nodeType: number;
	readonly parentElement: ScopedIgnoreElement | null;
	getAttribute(name: string): string | null;
}

const ATTRIBUTE = "data-impeccable-ignore";

/** True when `el` or an ancestor waives `ruleId` via a scoped ignore attribute. */
function scopedIgnoreActive(el: ScopedIgnoreElement | null | undefined, ruleId: string): boolean {
	const rule = String(ruleId || "").toLowerCase();
	let cur: ScopedIgnoreElement | null | undefined = el;
	while (cur && cur.nodeType === 1) {
		const attr = typeof cur.getAttribute === "function" ? cur.getAttribute(ATTRIBUTE) : null;
		if (attr != null) {
			const rules = String(attr).trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
			if (rules.length === 0 || rules.includes("*") || rules.includes(rule)) return true;
		}
		cur = cur.parentElement;
	}
	return false;
}

export { scopedIgnoreActive, ATTRIBUTE as SCOPED_IGNORE_ATTRIBUTE };
