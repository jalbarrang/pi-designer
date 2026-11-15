/**
 * CSS length resolution for checks that read computed values. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */
import type { CssStyle, DomElement } from "../../dom.ts";

/** A style reader for one element. */
export type StyleLookup = (el: DomElement) => CssStyle;

/**
 * The element's font size in pixels, resolved through the ancestor chain so an
 * `em` or `%` value inherits from its real parent context rather than from a
 * guess. Starts at the 16px root default.
 */
function resolveFontSizePx(el: DomElement | null, getStyle: StyleLookup): number {
	const chain: string[] = []; // raw font-size strings, leaf to root
	for (let cur: DomElement | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
		chain.push(getStyle(cur).fontSize || "");
	}

	let px = 16;
	for (let i = chain.length - 1; i >= 0; i--) {
		const v = chain[i];
		if (!v || v === "inherit") continue;
		const value = Number.parseFloat(v);
		if (Number.isNaN(value)) continue;
		if (v.endsWith("px")) px = value;
		else if (v.endsWith("rem")) px = value * 16;
		else if (v.endsWith("em")) px = value * px;
		else if (v.endsWith("%")) px = (value / 100) * px;
		else px = value; // unitless: already resolved
	}
	return px;
}

/**
 * A CSS length value (line-height, letter-spacing, and so on) in pixels, given the
 * font-size context. Returns null for `normal`, `auto`, `inherit`, and anything
 * unparseable, so callers can tell "no value" from "zero". A unitless number is
 * treated as a multiplier of the font size, which is what it means for
 * line-height and letter-spacing alike.
 */
function resolveLengthPx(value: string | null | undefined, fontSizePx: number): number | null {
	if (!value || value === "normal" || value === "auto" || value === "inherit") return null;
	const num = Number.parseFloat(value);
	if (Number.isNaN(num)) return null;
	if (value.endsWith("px")) return num;
	if (value.endsWith("rem")) return num * 16;
	if (value.endsWith("em")) return num * fontSizePx;
	if (value.endsWith("%")) return (num / 100) * fontSizePx;
	return num * fontSizePx;
}

export { resolveFontSizePx, resolveLengthPx };
