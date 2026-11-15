/**
 * Text visibility: screen-reader idioms, text overflow, decorative blinking
 * cursors, and content that stays invisible at rest. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Each check here answers "is this text actually reaching the reader?", which is
 * why they are separate from the styling rules: a beautifully set paragraph at
 * opacity 0 is not a typography problem.
 */
import { parseAnyColor } from "../shared/color.ts";
import { resolveLengthPx } from "./lengths.ts";
import { classSelector, isRenderedForBrowserRule } from "./elements.ts";
import { clippedByInset, clippedByRect, firstMetricLengthPx, metricLengthPx } from "./overflow.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/**
 * True when a style is the "visually hidden" idiom: a 2px-or-smaller box that is
 * absolutely positioned with clipped overflow, or a collapsed `clip`/`inset()`.
 * Such text is never rendered, so tiny-text floors do not apply to it.
 */
function isScreenReaderOnlyTextStyle(
	style: CssStyle | null | undefined,
	metrics: { readonly width?: number | null; readonly height?: number | null; readonly clientWidth?: number | null; readonly clientHeight?: number | null } = {},
): boolean {
	if (!style) return false;

	const overflowValues = [style.overflow, style.overflowX, style.overflowY].map((value) => String(value || "").toLowerCase());
	const clipsOverflow = overflowValues.some((value) => value === "hidden" || value === "clip");

	const fontSize = metricLengthPx(style.fontSize, 16) || 16;
	const width = firstMetricLengthPx(fontSize, metrics.width, metrics.clientWidth, style.width, style.inlineSize);
	const height = firstMetricLengthPx(fontSize, metrics.height, metrics.clientHeight, style.height, style.blockSize);
	const isTiny = width !== null && height !== null && width <= 2 && height <= 2;
	const isAbsolutelyHidden = String(style.position || "").toLowerCase() === "absolute" && isTiny && clipsOverflow;

	const clipPath = String(style.clipPath || style.webkitClipPath || "").trim();
	const clip = String(style.clip || "").trim();
	return isAbsolutelyHidden || clippedByInset(clipPath) || clippedByRect(clip);
}

/** Tags whose text never overflows by accident: preformatted and replaced content. */
const TEXT_OVERFLOW_SKIP_TAGS: ReadonlySet<string> = new Set(["pre", "code", "textarea", "svg", "canvas", "select", "option", "marquee"]);

/**
 * Text overflow for a live element. Two paths, because they cover different shapes:
 * a block owner overflows its own `scrollWidth`, while an inline owner has no client
 * geometry at all and only spills past its nearest block container.
 */
function checkElementTextOverflowDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (TEXT_OVERFLOW_SKIP_TAGS.has(tag)) return [];
	// On SVG content the box metrics are arbitrary, so the delta is noise; SVG clips
	// to its own viewport anyway.
	if (el.namespaceURI === "http://www.w3.org/2000/svg") return [];
	if (!isRenderedForBrowserRule(el, dom)) return [];

	// Only the element that owns the overflowing text, not ancestors, which inherit a
	// wider scrollWidth from the spilling descendant.
	const hasDirectText = (el.childNodes ?? []).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
	if (!hasDirectText) return [];

	const style = dom.getComputedStyle(el);
	const rect: Rect | null = el.getBoundingClientRect?.() ?? null;
	const metrics = el as unknown as { clientWidth?: number; clientHeight?: number; scrollWidth?: number; clientLeft?: number };
	const clientWidth = typeof metrics.clientWidth === "number" ? metrics.clientWidth : 0;
	const scrollWidth = typeof metrics.scrollWidth === "number" ? metrics.scrollWidth : 0;
	const clientLeft = typeof metrics.clientLeft === "number" ? metrics.clientLeft : 0;

	if (isScreenReaderOnlyTextStyle(style, { width: rect?.width, height: rect?.height, clientWidth, clientHeight: metrics.clientHeight ?? 0 })) return [];

	const isScrollRegion = (s: CssStyle) => /(auto|scroll)/.test(s.overflowX || "") || /(auto|scroll)/.test(s.overflow || "");
	if (isScrollRegion(style)) return [];
	// A scrollable ancestor makes the overflow intentional and reachable.
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (isScrollRegion(dom.getComputedStyle(p))) return [];
	}

	const delta = scrollWidth - clientWidth;
	if (clientWidth > 0 && delta >= 16) {
		return [{ id: "text-overflow", snippet: `${classSelector(el)} overflows its box by ${Math.round(delta)}px` }];
	}

	// Inline owners have no client geometry, so the path above never sees them; their
	// overflow registers on a block ancestor that owns no direct text. Measure the
	// inline box against its nearest block container's padding box instead.
	if (clientWidth === 0 && rect && rect.width > 0) {
		let container: DomElement | null = el.parentElement;
		while (container && (container as unknown as { clientWidth?: number }).clientWidth === 0) container = container.parentElement;
		if (!container) return [];

		// Transforms make rect comparisons lie.
		for (let p: DomElement | null = el; p && p !== container.parentElement; p = p.parentElement) {
			const t = dom.getComputedStyle(p).transform;
			if (t && t !== "none") return [];
		}

		const cRect = container.getBoundingClientRect?.() ?? null;
		const cMetrics = container as unknown as { clientWidth?: number; clientLeft?: number };
		if (!cRect) return [];
		const contentRight = cRect.left + (cMetrics.clientLeft ?? 0) + (cMetrics.clientWidth ?? 0);
		const spill = rect.right - contentRight;
		if (spill >= 16) {
			return [{ id: "text-overflow", snippet: `${classSelector(el)} overflows its container by ${Math.round(spill)}px` }];
		}
	}
	return [];
}

// ─── Blinking cursor ───────────────────────────────────────────────────────

/** Block and underscore glyphs commonly used as a fake text cursor. */
const CURSOR_GLYPH_RE = /^[_|▀-▟■▮❙❚｜]$/;

// How far down still counts as the landing region. Hero compositions regularly run
// past a literal viewport height, so this is a budget, not an exact fold line.
const CURSOR_FIRST_VIEWPORT_PX = 1200;

/** The `@keyframes` rules a blink check needs from the CSSOM. */
export interface KeyframesSource {
	readonly styleSheets?: ArrayLike<{
		readonly cssRules?: ArrayLike<CssRuleLike>;
		readonly rules?: ArrayLike<CssRuleLike>;
	}>;
}

export interface CssRuleLike {
	readonly type?: number;
	readonly name?: string;
	readonly cssRules?: ArrayLike<CssRuleLike>;
	readonly style?: {
		readonly length: number;
		[idx: number]: string;
		getPropertyValue(property: string): string;
	} | null;
}

/**
 * Do the named keyframes only toggle visibility (opacity dropping to near zero, or
 * `visibility: hidden`)? That is a blink. Any other animated property means a fade,
 * move, or spin, which is a different thing.
 */
function keyframesToggleVisibility(name: string | null | undefined, source: KeyframesSource): boolean {
	if (!name) return false;

	for (const sheet of Array.from(source.styleSheets ?? [])) {
		let rules: ArrayLike<CssRuleLike> | null = null;
		try {
			rules = sheet.cssRules || sheet.rules || null;
		} catch {
			continue;
		}
		if (!rules) continue;

		const stack = Array.from(rules);
		while (stack.length > 0) {
			const rule = stack.shift() as CssRuleLike;
			// Descend into grouping rules (@media, @supports) but not into keyframes.
			if (rule.cssRules && rule.type !== 7) {
				stack.push(...Array.from(rule.cssRules));
				continue;
			}
			if (rule.type !== 7 || rule.name !== name) continue;

			let togglesOut = false;
			for (const frame of Array.from(rule.cssRules ?? [])) {
				const fs = frame.style;
				if (!fs) continue;
				for (let i = 0; i < fs.length; i++) {
					const prop = fs[i];
					if (prop === "opacity") {
						if ((parseFloat(fs.getPropertyValue("opacity")) || 0) <= 0.15) togglesOut = true;
					} else if (prop === "visibility") {
						if (/hidden/i.test(fs.getPropertyValue("visibility"))) togglesOut = true;
					} else if (prop !== "animation-timing-function") {
						// Keyframes animate something else: not a blink.
						return false;
					}
				}
			}
			return togglesOut;
		}
	}
	return false;
}

export interface BlinkingCursorOptions {
	readonly scrollY?: number;
	/** Source for `keyframesToggleVisibility`; without it, only the animation name decides. */
	readonly keyframes?: KeyframesSource | null;
}

/**
 * The decorative blinking cursor: a small block or underscore bound to an infinite
 * blink animation in the landing region. Real editable surfaces draw their own caret
 * and are exempt, and round dots belong to the pulsing-dot rule.
 */
function checkElementBlinkingCursorDOM(el: DomElement, dom: DomAdapter, opts: BlinkingCursorOptions = {}): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (["input", "textarea", "select", "img", "svg", "script", "style"].includes(tag)) return [];
	const style = dom.getComputedStyle(el);

	const iterations = (style.animationIterationCount || "").split(",").map((s) => s.trim());
	if (!iterations.includes("infinite")) return [];
	const names = (style.animationName || "")
		.split(",")
		.map((s) => s.trim())
		.filter((n) => n && n !== "none");
	if (names.length === 0) return [];

	const keyframes = opts.keyframes ?? null;
	const blinkName =
		names.find((n) => /blink|caret|cursor/i.test(n)) || (keyframes ? names.find((n) => keyframesToggleVisibility(n, keyframes)) : undefined);
	if (!blinkName) return [];

	// Real caret contexts are exempt.
	if ((el as { isContentEditable?: boolean }).isContentEditable) return [];
	if (el.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]')) return [];

	const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	if (rect.width <= 0 || rect.height <= 0) return [];

	const pageTop = rect.top + (opts.scrollY ?? 0);
	if (pageTop > CURSOR_FIRST_VIEWPORT_PX) return [];

	const text = (el.textContent || "").trim();
	const glyphCursor = text.length === 1 && CURSOR_GLYPH_RE.test(text);
	let blockCursor = false;

	if (!glyphCursor) {
		if (text.length > 0 || (el.children?.length ?? 0) > 0) return [];
		const bg = parseAnyColor(style.backgroundColor || "");
		const filled = !!bg && bg.a > 0.2;
		const hasBorderFill = ["Left", "Right", "Bottom"].some((side) => (parseFloat(style[`border${side}Width`] ?? "") || 0) >= 1);
		if (!filled && !hasBorderFill) return [];

		const vertical = rect.width >= 1 && rect.width <= 24 && rect.height >= 6 && rect.height <= 48 && rect.height >= rect.width;
		const underscore = rect.height >= 1 && rect.height <= 6 && rect.width >= 4 && rect.width <= 24;
		if (!vertical && !underscore) return [];

		// Round dots are the pulsing-dot rule's territory.
		const radiusPx = parseFloat(style.borderRadius ?? "") || 0;
		if (radiusPx >= 0.4 * Math.min(rect.width, rect.height)) return [];
		blockCursor = true;
	}
	if (!glyphCursor && !blockCursor) return [];

	// A fake caret in the first ~900px or inside the page chrome is the shipped hero
	// cliché, so it is promoted from advisory to warning; lower ones keep the default.
	const inHeroRegion = pageTop <= 900 || !!el.closest?.('header, nav, [role="banner"], [role="navigation"]');
	return [
		{
			id: "blinking-cursor",
			snippet: `${classSelector(el)} — ${Math.round(rect.width)}x${Math.round(rect.height)}px blinking cursor (animation "${blinkName}") in the first viewport`,
			...(inHeroRegion ? { severity: "warning" as const } : {}),
		},
	];
}

// ─── Content hidden at rest ────────────────────────────────────────────────

// Tags whose text never renders, or whose hidden state is legitimate UI. Their text
// stays out of both the numerator and the denominator.
const HIDDEN_TEXT_EXCLUDE_TAGS: ReadonlySet<string> = new Set([
	"script", "style", "noscript", "template", "title", "head", "meta", "link",
	"option", "optgroup", "select", "datalist", "dialog",
]);

export interface HiddenTextMeasurement {
	readonly totalChars: number;
	readonly hiddenChars: number;
	readonly hiddenSamples: readonly string[];
}

/**
 * How many characters render invisible (opacity near zero or `visibility: hidden`
 * anywhere up the chain) versus visible. `display: none`, `[hidden]`, and
 * `aria-hidden` subtrees are legitimately hidden UI, so they leave the denominator
 * entirely instead of counting as invisible.
 */
function measureHiddenText(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement>; readonly documentElement?: DomElement | null },
	dom: DomAdapter,
): HiddenTextMeasurement {
	const cache = new Map<DomElement, "visible" | "invisible" | "excluded">();

	const stateOf = (el: DomElement | null): "visible" | "invisible" | "excluded" => {
		if (!el || el.nodeType !== 1 || el === doc.documentElement) return "visible";
		const cached = cache.get(el);
		if (cached) return cached;

		let state: "visible" | "invisible" | "excluded";
		const tag = el.tagName.toLowerCase();
		if (HIDDEN_TEXT_EXCLUDE_TAGS.has(tag)) {
			state = "excluded";
		} else {
			const parentState = stateOf(el.parentElement);
			if (parentState === "excluded") {
				state = "excluded";
			} else {
				const style = dom.getComputedStyle(el);
				if (
					style.display === "none" ||
					(el as { hidden?: boolean }).hidden ||
					el.getAttribute?.("aria-hidden") === "true" ||
					String(style.contentVisibility || "").toLowerCase() === "hidden"
				) {
					state = "excluded";
				} else if (parentState === "invisible" || (parseFloat(style.opacity ?? "") || 0) <= 0.02 || /^(hidden|collapse)$/.test(style.visibility || "")) {
					state = "invisible";
				} else {
					state = "visible";
				}
			}
		}
		cache.set(el, state);
		return state;
	};

	let totalChars = 0;
	let hiddenChars = 0;
	const hiddenSamples: string[] = [];

	for (const el of Array.from(doc.querySelectorAll("body *"))) {
		let len = 0;
		for (const node of el.childNodes ?? []) {
			if (node.nodeType === 3) len += (node.textContent ?? "").replace(/\s+/g, " ").trim().length;
		}
		if (!len) continue;

		const state = stateOf(el);
		if (state === "excluded") continue;
		totalChars += len;
		if (state === "invisible") {
			hiddenChars += len;
			if (hiddenSamples.length < 3) {
				const text = String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
				if (text) hiddenSamples.push(text);
			}
		}
	}
	return { totalChars, hiddenChars, hiddenSamples };
}

/**
 * The threshold check over a measurement, run after a reveal sweep (scroll the page
 * so every reveal handler fires, then return to the top). A healthy reveal-on-scroll
 * page drops to near zero invisible text; a page whose reveal script died keeps most
 * of its text at opacity 0 forever. Fires above a 30% share with real text behind it.
 */
function checkContentHiddenAtRest(
	{ totalChars = 0, hiddenChars = 0, hiddenSamples = [] }: Partial<HiddenTextMeasurement> = {},
): RuleHit[] {
	if (totalChars < 200 || hiddenChars < 150) return [];
	const share = hiddenChars / totalChars;
	if (share <= 0.3) return [];
	const sample = hiddenSamples.length > 0 ? ` (e.g. "${hiddenSamples[0]}")` : "";
	return [
		{
			id: "content-hidden-at-rest",
			snippet: `${Math.round(share * 100)}% of page text (${hiddenChars} of ${totalChars} chars) stays at opacity 0 / visibility hidden after reveal handlers ran${sample}`,
		},
	];
}

/** The measured-once convenience for a page scan: measurement then threshold. */
function checkContentHiddenAtRestInDoc(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement>; readonly documentElement?: DomElement | null },
	dom: DomAdapter,
): RuleHit[] {
	return checkContentHiddenAtRest(measureHiddenText(doc, dom));
}

/** Unused import guard: keeps the length resolver available to future checks in this module. */
void resolveLengthPx;

export {
	checkContentHiddenAtRest,
	checkContentHiddenAtRestInDoc,
	checkElementBlinkingCursorDOM,
	checkElementTextOverflowDOM,
	CURSOR_FIRST_VIEWPORT_PX,
	CURSOR_GLYPH_RE,
	HIDDEN_TEXT_EXCLUDE_TAGS,
	isScreenReaderOnlyTextStyle,
	keyframesToggleVisibility,
	measureHiddenText,
	TEXT_OVERFLOW_SKIP_TAGS,
};
