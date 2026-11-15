/**
 * Background resolution, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Contrast is only meaningful against the surface the text is actually painted
 * on, and computing that surface means walking ancestors, compositing
 * translucent layers, and knowing when to abstain. Abstaining is a feature: one
 * skipped finding costs less than a hundred false ones on a dark theme.
 */
import {
	compositeColorOver,
	isNoPaintColorValue,
	parseAnyColor,
	parseGradientColors,
	parseRgb,
	splitTopLevelCommas,
	type Color,
} from "../shared/color.ts";
import type { CssStyle } from "../../dom.ts";
import { parseColorResolved } from "./css-scan.ts";
import type { ScanMode } from "./colors.ts";

/** The computed style these walks read. Every CSS property is a string. */
export type ComputedStyleLike = CssStyle;

/**
 * The slice of an Element the walk needs. pi resolves styles through its browser
 * tooling or a static parser, so the engine takes the shape rather than a class.
 */
export interface ElementLike {
	readonly nodeType: number;
	readonly parentElement: ElementLike | null;
	getAttribute?(name: string): string | null;
}

/** Where computed styles come from: a live browser or a parsed document. */
export interface StyleHost {
	getComputedStyle(el: ElementLike): ComputedStyleLike;
}

/**
 * The surface below the text, as far as the engine can tell.
 *
 * - `color` set: the effective surface, with translucent overlays composited in.
 * - `unresolved: true`: some layer paints a color this parser cannot read, so the
 *   surface is unknown and callers must skip their contrast checks.
 * - both null and false: no solid color, but a gradient or image is in play, so
 *   callers fall back to gradient stops.
 */
export interface BackgroundInfo {
	readonly color: Color | null;
	readonly unresolved: boolean;
}

/**
 * The element's own background color. Computed style wins; in a static scan, a
 * missing or near-transparent value falls back to the inline `background:`
 * shorthand, which some parsers do not decompose into `background-color`.
 */
function readOwnBackgroundColor(el: ElementLike, computedStyle: ComputedStyleLike, mode: ScanMode): Color | null {
	const bg = parseRgb(computedStyle.backgroundColor) ?? parseAnyColor(computedStyle.backgroundColor);
	if (mode === "browser" || (bg && bg.a >= 0.1)) return bg;

	const rawStyle = el.getAttribute?.("style") ?? "";
	const bgMatch = rawStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
	const inlineBg = bgMatch ? bgMatch[1].trim() : "";
	if (!inlineBg) return bg;
	if (/gradient/i.test(inlineBg) || /url\s*\(/i.test(inlineBg)) return bg;

	const fromRgb = parseRgb(inlineBg);
	if (fromRgb) return fromRgb;

	const hexMatch = inlineBg.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
	if (hexMatch) {
		const h = hexMatch[1];
		if (h.length === 6) {
			return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
		}
		return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
	}
	return bg;
}

/**
 * One element's background color as the cascade walk sees it: computed style
 * first (with the modern-color fallback), then, in static mode only, custom
 * property resolution and the inline-shorthand peek. Shared by both walks so
 * they read the same surfaces.
 */
function readCascadeBackgroundColor(
	current: ElementLike,
	style: ComputedStyleLike,
	customPropMap: Map<string, string> | null | undefined,
	mode: ScanMode,
): Color | null {
	let bg = parseRgb(style.backgroundColor) ?? parseAnyColor(style.backgroundColor);
	if (mode === "static" && (!bg || bg.a < 0.1)) {
		// A static engine can hand back literal `var(--X)` or `oklch(…)` strings;
		// resolving through the custom-property map turns design tokens into RGB.
		if (customPropMap) bg = parseColorResolved(style.backgroundColor, customPropMap);
		if (!bg || bg.a < 0.1) {
			const rawStyle = current.getAttribute?.("style") ?? "";
			const bgMatch = rawStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
			const inlineBg = bgMatch ? bgMatch[1].trim() : "";
			if (inlineBg && !/gradient/i.test(inlineBg) && !/url\s*\(/i.test(inlineBg)) {
				bg = parseColorResolved(inlineBg, customPropMap) ?? parseAnyColor(inlineBg);
			}
		}
	}
	return bg;
}

/**
 * Walk ancestors for the surface the element's text is painted on.
 *
 * Translucent layers are collected and composited over the first opaque base,
 * which is what a browser does and what the old code got wrong in both
 * directions (treating a wash as opaque, or skipping it entirely).
 */
function resolveBackgroundInfo(
	el: ElementLike | null,
	host: StyleHost,
	customPropMap: Map<string, string> | null | undefined,
	mode: ScanMode,
): BackgroundInfo {
	let current: ElementLike | null = el;
	const overlays: Color[] = [];
	const flatten = (base: Color): Color => {
		let acc = base;
		for (let i = overlays.length - 1; i >= 0; i--) acc = compositeColorOver(overlays[i], acc);
		return acc;
	};

	while (current && current.nodeType === 1) {
		const style = host.getComputedStyle(current);
		const bgImage = style.backgroundImage || "";
		const hasGradientOrUrl = !!bgImage && bgImage !== "none" && (/gradient/i.test(bgImage) || /url\s*\(/i.test(bgImage));

		// Try the solid color first. An element can carry both a solid color and
		// a decorative gradient or image overlay (paper-grain texture on a token
		// background); the solid color is then the visible surface.
		let bg = readCascadeBackgroundColor(current, style, customPropMap, mode);

		// `background-color: currentcolor` paints with the element's own text
		// color: real paint whose value we know. Real browsers resolve the
		// keyword before computed style; a static parser may pass it through.
		if ((!bg || bg.a < 0.1) && /^currentcolor$/i.test(String(style.backgroundColor || "").trim())) {
			bg = parseRgb(style.color ?? "") ?? parseColorResolved(style.color, customPropMap);
		}

		if (bg && bg.a > 0.1) {
			if (bg.a >= 0.99) return { color: flatten(bg), unresolved: false };
			overlays.push(bg);
		} else if (!bg && !isNoPaintColorValue(style.backgroundColor)) {
			// This layer names a color we cannot parse, and it may be opaque, which
			// would make every ancestor invisible. The surface is unknown, so stop
			// here rather than report an ancestor the visitor never sees.
			return { color: null, unresolved: true };
		}

		// Background layers stack first-on-top, so which layer leads decides what
		// is visible:
		//   • gradient on top — the gradient is the surface; return a null color so
		//     the caller falls back to the gradient's own stops.
		//   • url() on top — the surface is an image whose pixels this engine cannot
		//     read, and it may fully cover every layer beneath. Abstain, so the
		//     gradient-stop fallback never measures a hidden gradient.
		if (hasGradientOrUrl) {
			const layers = splitTopLevelCommas(bgImage);
			const topPaintLayer = layers.find((layer) => /gradient\s*\(/i.test(layer) || /url\s*\(/i.test(layer));
			const gradientOnTop =
				!!topPaintLayer && /gradient\s*\(/i.test(topPaintLayer) && !/^\s*url\s*\(/i.test(topPaintLayer);
			if (!gradientOnTop) return { color: null, unresolved: true };

			// A translucent wash over a url() paints a blend with unreadable pixels;
			// only a gradient whose every readable stop is opaque provably covers it.
			const urlBeneath = layers.some((layer) => layer !== topPaintLayer && /url\s*\(/i.test(layer));
			if (urlBeneath) {
				const topStops = parseGradientColors(topPaintLayer);
				const provablyOpaque = topStops.length > 0 && topStops.every((s) => s.a >= 0.99);
				if (!provablyOpaque) return { color: null, unresolved: true };
			}
			return { color: null, unresolved: false };
		}

		current = current.parentElement;
	}

	// Every layer up to the root was genuinely see-through, so the browser paints
	// its default canvas. This is the only case that earns the white assumption.
	return { color: flatten({ r: 255, g: 255, b: 255, a: 1 }), unresolved: false };
}

/** The effective background color alone, for callers that only need the surface. */
function resolveBackground(
	el: ElementLike | null,
	host: StyleHost,
	customPropMap: Map<string, string> | null | undefined,
	mode: ScanMode,
): Color | null {
	return resolveBackgroundInfo(el, host, customPropMap, mode).color;
}

/**
 * Walk ancestors for a gradient background and return its color stops, used when
 * the effective background is a gradient and there is no single solid color to
 * compare against. A url() layer anywhere abstains: pixels this engine cannot read
 * are not a base. Translucent solid layers between the element and the gradient
 * are composited over every stop, the same way the solid walk flattens them.
 */
function resolveGradientStops(
	el: ElementLike | null,
	host: StyleHost,
	customPropMap: Map<string, string> | null | undefined,
	mode: ScanMode,
): Color[] | null {
	let current: ElementLike | null = el;
	const overlays: Color[] = [];

	while (current && current.nodeType === 1) {
		const style = host.getComputedStyle(current);
		const bgImage = style.backgroundImage || "";
		if (bgImage && bgImage !== "none" && /url\s*\(/i.test(bgImage)) return null;

		let stops: Color[] | null = null;
		if (bgImage && bgImage !== "none" && /gradient/i.test(bgImage)) {
			// The shared parser reads modern-space stops too, so computed values that
			// keep the authored syntax stay measurable.
			const parsed = parseGradientColors(bgImage);
			if (parsed.length > 0) stops = parsed;
		}
		if (!stops && mode === "static") {
			// Peek at the raw inline style for gradients the cascade did not surface.
			const rawStyle = current.getAttribute?.("style") ?? "";
			const bgMatch = rawStyle.match(/background(?:-image)?\s*:\s*([^;]+)/i);
			if (bgMatch && /gradient/i.test(bgMatch[1])) {
				const parsed = parseGradientColors(bgMatch[1]);
				if (parsed.length > 0) stops = parsed;
			}
		}

		if (stops) {
			const composited = compositeGradientStops(stops, current, host, customPropMap, mode);
			if (!composited || overlays.length === 0) return composited;
			return composited.map((stop) => {
				let acc = stop;
				for (let i = overlays.length - 1; i >= 0; i--) acc = compositeColorOver(overlays[i], acc);
				return acc;
			});
		}

		const bg = readCascadeBackgroundColor(current, style, customPropMap, mode);
		if (bg && bg.a > 0.1) {
			// An opaque surface above the gradient hides it; the caller reached here
			// by another path, so bail rather than measure the wrong layer.
			if (bg.a >= 0.99) return null;
			overlays.push(bg);
		}
		current = current.parentElement;
	}
	return null;
}

/**
 * A translucent gradient stop paints over whatever sits beneath the gradient, so
 * its effective color is closer to the base than to the full-opacity accent.
 * Treating it as opaque flags every text child of a softly-glowing section. Each
 * alpha stop composites over the resolved surface; when that surface is not
 * resolvable, the stop is dropped, because a dropped stop cannot manufacture a
 * false finding.
 */
function compositeGradientStops(
	stops: readonly Color[],
	gradientEl: ElementLike,
	host: StyleHost,
	customPropMap: Map<string, string> | null | undefined,
	mode: ScanMode,
): Color[] | null {
	const hasAlpha = stops.some((s) => s.a < 0.99);
	if (!hasAlpha) return [...stops];

	const base = resolveBackground(gradientEl.parentElement || gradientEl, host, customPropMap, mode);
	const out: Color[] = [];
	for (const s of stops) {
		if (s.a >= 0.99) {
			out.push(s);
			continue;
		}
		if (base) out.push(compositeColorOver(s, base));
	}
	return out.length > 0 ? out : null;
}

/**
 * A CSS length token as pixels. Uses the first value of a shorthand, converts a
 * percentage against `widthPx` when one is available, and otherwise returns the
 * raw percentage number so callers gating on `> 0` still see a positive value
 * where layout is unknown.
 */
function parseRadiusToPx(value: string | null | undefined, widthPx?: number | null): number | null {
	if (!value || typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const first = trimmed.split(/\s+/)[0];
	const num = parseFloat(first);
	if (Number.isNaN(num)) return null;
	if (/%$/.test(first)) {
		if (widthPx && widthPx > 0) return (num / 100) * widthPx;
		return num;
	}
	return num;
}

/** The border radius in pixels, or 0 when the engine has no readable radius. */
function resolveBorderRadiusPx(style: ComputedStyleLike, widthPx?: number | null): number {
	const fromComputed = parseRadiusToPx(style.borderRadius, widthPx);
	return fromComputed ?? 0;
}

export {
	compositeGradientStops,
	parseRadiusToPx,
	readCascadeBackgroundColor,
	readOwnBackgroundColor,
	resolveBackground,
	resolveBackgroundInfo,
	resolveBorderRadiusPx,
	resolveGradientStops,
};
