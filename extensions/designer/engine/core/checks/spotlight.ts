/**
 * Element wrappers around the motion, glow, palette, and spotlight tells. Ported
 * from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Each takes the DOM plus a style source, because a live page and a parsed file
 * answer the same questions from different places.
 */
import {
	colorToHex,
	getHue,
	hasChroma,
	parseAnyColor,
	parseGradientColors,
	parseRgb,
	relativeLuminance,
	splitTopLevelCommas,
	type Color,
} from "../shared/color.ts";
import { SAFE_TAGS } from "../shared/constants.ts";
import { checkGlow } from "./css-scan.ts";
import { checkMotion } from "./motion.ts";
import { resolveBackgroundInfo, type ElementLike } from "./background.ts";
import type { DocHost } from "./doc-checks.ts";
import type { CssStyle, DomAdapter, DomElement } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** Motion findings for a live element. */
function checkElementMotionDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (SAFE_TAGS.has(tag)) return [];
	const style = dom.getComputedStyle(el);
	return checkMotion({
		tag,
		transitionProperty: style.transitionProperty || "",
		animationName: style.animationName || "",
		timingFunctions: [style.animationTimingFunction, style.transitionTimingFunction].filter(Boolean).join(" "),
		classList: el.getAttribute?.("class") || "",
	});
}

/**
 * The average color of the nearest ancestor gradient? Used when the effective
 * background is a gradient, which has no single color to judge a glow against.
 * The average is enough for the darkness gate that consumes it.
 */
function ancestorGradientAverage(el: DomElement | null | undefined, dom: DomAdapter): Color | null {
	for (let cur: DomElement | null = el ?? null; cur && cur.nodeType === 1; cur = cur.parentElement) {
		const bgImage = dom.getComputedStyle(cur).backgroundImage || "";
		const gradColors = parseGradientColors(bgImage);
		if (gradColors.length > 0) {
			const avg = { r: 0, g: 0, b: 0 };
			for (const c of gradColors) {
				avg.r += c.r;
				avg.g += c.g;
				avg.b += c.b;
			}
			return {
				r: Math.round(avg.r / gradColors.length),
				g: Math.round(avg.g / gradColors.length),
				b: Math.round(avg.b / gradColors.length),
				a: 1,
			};
		}
	}
	return null;
}

/**
 * Glow findings for a live element. The parent surface decides whether a blurred
 * chromatic shadow reads as the dark-mode glow accent.
 *
 * `text-shadow` inherits, so it is only checked on the element that introduces it:
 * otherwise one declaration reports on every descendant.
 */
function checkElementGlowDOM(el: DomElement, dom: DomAdapter, mode: "static" | "browser" = "browser"): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	const style = dom.getComputedStyle(el);
	const boxShadow = style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : "";
	let textShadow = style.textShadow && style.textShadow !== "none" ? style.textShadow : "";
	if (textShadow && el.parentElement && dom.getComputedStyle(el.parentElement).textShadow === textShadow) textShadow = "";
	if (!boxShadow && !textShadow) return [];

	// Glow radiates outward, so the surrounding context is what matters. An
	// unresolved surface skips only the gradient hunt, which would otherwise score
	// the glow against a background the visitor never sees; checkGlow still runs
	// with a null surface, because the zero-offset halo tell holds on any ground.
	const host: import("./background.ts").StyleHost = { getComputedStyle: (node) => dom.getComputedStyle(node as DomElement) };
	const parentBgInfo = resolveBackgroundInfo((el.parentElement || el) as ElementLike, host, null, mode);
	let parentBg: Color | null = parentBgInfo.color;
	if (!parentBg && !parentBgInfo.unresolved) {
		parentBg = ancestorGradientAverage(el.parentElement, dom);
	}
	return checkGlow({ boxShadow, textShadow, effectiveBg: parentBg });
}

/**
 * The generated-palette tell on one element: a purple/violet or cyan gradient
 * background, and vivid neon text of the same hues on a dark ground.
 */
function checkElementAIPaletteDOM(el: DomElement, dom: DomAdapter, mode: "static" | "browser" = "browser"): RuleHit[] {
	const style = dom.getComputedStyle(el);
	const findings: RuleHit[] = [];

	for (const c of parseGradientColors(style.backgroundImage || "")) {
		if (!hasChroma(c, 50)) continue;
		const hue = getHue(c);
		if (hue >= 260 && hue <= 310) {
			findings.push({ id: "ai-color-palette", snippet: "Purple/violet gradient background" });
			break;
		}
		if (hue >= 160 && hue <= 200) {
			findings.push({ id: "ai-color-palette", snippet: "Cyan gradient background" });
			break;
		}
	}

	const textColor = parseRgb(style.color) ?? parseAnyColor(style.color);
	if (textColor && hasChroma(textColor, 80)) {
		const hue = getHue(textColor);
		const isAIPalette = (hue >= 160 && hue <= 200) || (hue >= 260 && hue <= 310);
		if (isAIPalette) {
			const host: import("./background.ts").StyleHost = { getComputedStyle: (node) => dom.getComputedStyle(node as DomElement) };
			const parentBgInfo = el.parentElement
				? resolveBackgroundInfo(el.parentElement as ElementLike, host, null, mode)
				: { color: null, unresolved: false };
			let effectiveBg: Color | null = parentBgInfo.color;
			if (!effectiveBg && !parentBgInfo.unresolved) {
				effectiveBg = ancestorGradientAverage(el.parentElement, dom);
			}
			if (effectiveBg && relativeLuminance(effectiveBg) < 0.1) {
				const label = hue >= 260 ? "Purple/violet" : "Cyan";
				findings.push({ id: "ai-color-palette", snippet: `${label} neon text on dark background` });
			}
		}
	}

	return findings;
}

// ─── Decorative radial spotlight ───────────────────────────────────────────
//
// A soft, low-opacity chromatic radial-gradient fading to transparent, painted as
// a decorative wash. This is the translucent sibling of `radial-halo`: that rule
// wants a saturated, near-opaque center on a dark page, and this one catches the
// low-alpha spotlight the halo gate lets through. The two alpha bands are
// disjoint, so one declaration never reports twice.

const SPOTLIGHT_COLOR_TOKEN_RE = /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\([^)]*(?:\([^)]*\))?[^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i;

/** One stop of a radial gradient, as far as the spotlight gate cares. */
interface RadialStop {
	readonly color: Color | null;
	readonly transparent: boolean;
}

/**
 * The ordered color stops of the first non-repeating `radial-gradient` in a
 * background value, or null when there is none. A repeating gradient is a pattern,
 * not a spotlight.
 */
function parseRadialGradientStops(value: string | null | undefined): RadialStop[] | null {
	if (!value || !/radial-gradient/i.test(value)) return null;

	const gradRe = /(repeating-)?radial-gradient\(/gi;
	for (let g = gradRe.exec(value); g !== null; g = gradRe.exec(value)) {
		if (g[1]) continue;
		let depth = 0;
		let end = -1;
		const open = value.indexOf("(", g.index);
		for (let i = open; i < value.length; i++) {
			if (value[i] === "(") depth++;
			else if (value[i] === ")") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end < 0) return null;

		const args = splitTopLevelCommas(value.slice(open + 1, end));
		// The optional prelude (shape, size, `at <position>`) carries no color token.
		const stopArgs = args.filter((a) => SPOTLIGHT_COLOR_TOKEN_RE.test(a));
		if (stopArgs.length < 2) return null;

		return stopArgs.map((a) => {
			const tok = a.match(SPOTLIGHT_COLOR_TOKEN_RE);
			if (!tok) return { color: null, transparent: false };
			if (/^transparent$/i.test(tok[0])) return { color: null, transparent: true };
			const color = parseAnyColor(tok[0]);
			return { color, transparent: !!color && color.a <= 0.05 };
		});
	}
	return null;
}

export interface RadialSpotlightOptions {
	readonly gradientValue: string;
	readonly width: number;
	readonly height: number;
	/** A stable identifier for the report; the element's data-name, id, or class. */
	readonly label?: string;
}

/**
 * The spotlight gate: fades to transparent, at most two visible stops, every visible
 * stop low-opacity, at least one chromatic, on a surface large enough to read as a
 * wash (240x160). A neutral vignette is a legitimate lighting move and passes.
 */
function checkRadialSpotlight(opts: RadialSpotlightOptions): RuleHit[] {
	const { gradientValue, width, height, label } = opts;
	const stops = parseRadialGradientStops(gradientValue);
	if (!stops || stops.length < 2) return [];

	// Must fade out: a gradient between two visible surfaces is a background.
	const last = stops[stops.length - 1];
	const lastAlpha = last.transparent ? 0 : last.color ? last.color.a : 1;
	if (lastAlpha > 0.05) return [];

	const colored = stops.filter((s): s is { color: Color; transparent: boolean } => !!s.color && !s.transparent && s.color.a > 0.05);
	if (colored.length === 0) return [];
	// One soft glow, not a multi-color composition.
	if (colored.length > 2) return [];
	// Every visible stop must be low opacity; an opaque one is a fill or a halo.
	if (colored.some((s) => s.color.a >= 0.45)) return [];
	// At least one stop must be chromatic: a neutral vignette is legitimate.
	const chromatic = colored.find((s) => hasChroma(s.color, 24));
	if (!chromatic) return [];
	// Decorative scale: badges and small lights are exempt.
	if (!(width >= 240 && height >= 160)) return [];

	const alpha = chromatic.color.a.toFixed(2);
	const name = label || "section";
	return [
		{
			id: "radial-spotlight-glow",
			snippet: `radial-gradient spotlight glow "${name}" (${colorToHex(chromatic.color)} a${alpha} → transparent) on ${Math.round(width)}x${Math.round(height)} surface`,
		},
	];
}

/**
 * The raw radial-gradient source for an element: computed `background-image` first,
 * then the `background` shorthand and the inline attribute, for engines that do not
 * decompose the shorthand.
 */
function elementGradientValue(style: CssStyle, el: DomElement | null | undefined): string {
	const bgImage = style.backgroundImage && style.backgroundImage !== "none" ? style.backgroundImage : "";
	if (/radial-gradient/i.test(bgImage)) return bgImage;
	const bg = style.background || "";
	if (/radial-gradient/i.test(bg)) return bg;
	const rawStyle = el?.getAttribute?.("style") || "";
	const m = rawStyle.match(/background(?:-image)?\s*:\s*([^;]+)/i);
	if (m && /radial-gradient/i.test(m[1])) return m[1];
	return "";
}

/** A stable label for a spotlight finding: data-name, then id, then first class, then tag. */
function spotlightLabel(el: DomElement): string {
	const dataName = el.getAttribute?.("data-name");
	if (dataName) return dataName;
	if (typeof el.id === "string" && el.id) return el.id;
	const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
	if (cls) return cls;
	return el.tagName ? el.tagName.toLowerCase() : "section";
}

/** The spotlight tell on a live element, measured from its rect. */
function checkElementRadialSpotlightDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const style = dom.getComputedStyle(el);
	const gradientValue = elementGradientValue(style, el);
	if (!gradientValue) return [];
	const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	return checkRadialSpotlight({ gradientValue, width: rect.width, height: rect.height, label: spotlightLabel(el) });
}

/** The spotlight tell on a parsed element, measured from declared width and height. */
function checkElementRadialSpotlightInDoc(el: DomElement, style: CssStyle): RuleHit[] {
	const gradientValue = elementGradientValue(style, el);
	if (!gradientValue) return [];
	return checkRadialSpotlight({
		gradientValue,
		width: parseFloat(style.width ?? "") || 0,
		height: parseFloat(style.height ?? "") || 0,
		label: spotlightLabel(el),
	});
}

/** Motion findings from a parsed style, with no class-list hints. */
function checkElementMotionInDocStyle(tag: string, style: CssStyle): RuleHit[] {
	return checkMotion({
		tag,
		transitionProperty: style.transitionProperty || "",
		animationName: style.animationName || "",
		timingFunctions: [style.animationTimingFunction, style.transitionTimingFunction].filter(Boolean).join(" "),
		classList: "",
	});
}

export {
	ancestorGradientAverage,
	checkElementAIPaletteDOM,
	checkElementGlowDOM,
	checkElementMotionDOM,
	checkElementMotionInDocStyle,
	checkElementRadialSpotlightDOM,
	checkElementRadialSpotlightInDoc,
	checkRadialSpotlight,
	elementGradientValue,
	parseRadialGradientStops,
	SPOTLIGHT_COLOR_TOKEN_RE,
	spotlightLabel,
};
export type { DocHost, RadialStop };
