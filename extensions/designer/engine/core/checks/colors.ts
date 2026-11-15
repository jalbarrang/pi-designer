/**
 * Color rules, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Contrast and palette checks run on resolved colors, so they are pure: the
 * engine that owns the DOM resolves computed styles and hands the values in.
 */
import {
	colorToHex,
	contrastRatio,
	getHue,
	hasChroma,
	type Color,
	relativeLuminance,
} from "../shared/color.ts";
import { SAFE_TAGS, WCAG_LARGE_BOLD_TEXT_PX, WCAG_LARGE_TEXT_PX } from "../shared/constants.ts";
import type { RuleHit } from "./rule-hit.ts";

/**
 * Which surface the values came from. Upstream reads an ambient browser flag
 * here; pi passes it, because the same checks run over a saved file and over a
 * live DOM in the same process.
 *
 * The distinction matters for one false-positive class: a static scan cannot
 * resolve `var(--token)` colors, so a translucent text color with no resolvable
 * opaque ancestor is compared against a fallback gradient and can read as
 * failing when it does not.
 */
export type ScanMode = "static" | "browser";

export interface ColorCheckOptions {
	readonly tag: string;
	readonly textColor: Color | null;
	/** The element's own background color, when it has one. */
	readonly bgColor?: Color | null;
	/** The nearest opaque ancestor surface, when the engine could resolve one. */
	readonly effectiveBg?: Color | null;
	/** Every stop of an ancestor gradient, when the ancestor surface is a gradient. */
	readonly effectiveBgStops?: readonly Color[] | null;
	readonly fontSize: number;
	readonly fontWeight: number;
	readonly hasDirectText: boolean;
	readonly isEmojiOnly?: boolean;
	readonly bgClip?: string | null;
	readonly bgImage?: string | null;
	readonly classList?: string | Iterable<string> | null;
	readonly mode: ScanMode;
}

function isLargeText(fontSize: number, fontWeight: number): boolean {
	return fontSize >= WCAG_LARGE_TEXT_PX || (fontSize >= WCAG_LARGE_BOLD_TEXT_PX && fontWeight >= 700);
}

/**
 * Contrast, palette, and gradient-text checks for one element.
 *
 * Citation and chip elements are suppressed unless they paint their own
 * surface: a link inherits the ancestor surface's contrast by design, but a span
 * with an opaque background is a styled control where failing contrast is a
 * real, frequent bug.
 */
function checkColors(opts: ColorCheckOptions): RuleHit[] {
	const { tag, textColor, bgColor, effectiveBg, effectiveBgStops, fontSize, fontWeight, hasDirectText, isEmojiOnly, bgClip, bgImage, classList, mode } = opts;

	if (SAFE_TAGS.has(tag)) {
		const isStyledControl =
			hasDirectText &&
			((bgColor != null && bgColor.a > 0.5) || (bgImage != null && /gradient/i.test(bgImage))) &&
			fontSize >= 9;
		if (!isStyledControl) return [];
	}

	const findings: RuleHit[] = [];

	if (hasDirectText && textColor && !isEmojiOnly) {
		// Gradient-clipped text paints its glyphs with the element's own
		// gradient, so the cascade's `color` is never painted and measuring it
		// against that gradient is a guaranteed false positive. The gradient-text
		// rule below still flags the pattern itself.
		const isGradientClippedText = bgClip === "text";
		const bgs = isGradientClippedText
			? null
			: effectiveBg
				? [effectiveBg]
				: effectiveBgStops && effectiveBgStops.length > 0
					? effectiveBgStops
					: null;

		if (bgs) {
			// Gray text on a chromatic surface.
			const textLum = relativeLuminance(textColor);
			const isGray = !hasChroma(textColor, 20) && textLum > 0.05 && textLum < 0.85;
			if (isGray && bgs.every((bg) => hasChroma(bg, 40))) {
				const bgLabel = effectiveBg ? colorToHex(effectiveBg) : `gradient(${bgs.map(colorToHex).join(", ")})`;
				findings.push({ id: "gray-on-color", snippet: `text ${colorToHex(textColor)} on bg ${bgLabel}` });
			}

			// WCAG AA, worst case across every background stop.
			const ratios = bgs.map((bg) => contrastRatio(textColor, bg));
			let worstIdx = 0;
			for (let i = 1; i < ratios.length; i++) if (ratios[i] < ratios[worstIdx]) worstIdx = i;
			const ratio = ratios[worstIdx];
			const threshold = isLargeText(fontSize, fontWeight) ? 3.0 : 4.5;

			if (ratio < threshold) {
				const isAlphaFallbackFP = mode === "static" && !effectiveBg && textColor.a < 1;
				if (!isAlphaFallbackFP) {
					// A near-threshold ratio would round to the threshold itself and
					// read as "4.5 needs 4.5", so show two decimals there.
					const ratioLabel = ratio.toFixed(1) === threshold.toFixed(1) ? ratio.toFixed(2) : ratio.toFixed(1);
					findings.push({
						id: "low-contrast",
						snippet: `${ratioLabel}:1 (need ${threshold}:1) — text ${colorToHex(textColor)} on ${colorToHex(bgs[worstIdx])}`,
					});
				}
			}
		}

		// Purple/violet text on headings: the generated-palette tell.
		if (hasChroma(textColor, 50)) {
			const hue = getHue(textColor);
			if (hue >= 260 && hue <= 310 && (["h1", "h2", "h3"].includes(tag) || fontSize >= 20)) {
				findings.push({ id: "ai-color-palette", snippet: `Purple/violet text (${colorToHex(textColor)}) on heading` });
			}
		}
	}

	if (bgClip === "text" && bgImage && bgImage.includes("gradient")) {
		findings.push({ id: "gradient-text", snippet: "background-clip: text + gradient" });
	}

	if (classList) {
		const classStr = typeof classList === "string" ? classList : Array.from(classList).join(" ");

		const grayMatch = classStr.match(/\btext-(?:gray|slate|zinc|neutral|stone)-\d+\b/);
		const colorBgMatch = classStr.match(/\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/);
		if (grayMatch && colorBgMatch) {
			findings.push({ id: "gray-on-color", snippet: `${grayMatch[0]} on ${colorBgMatch[0]}` });
		}

		if (/\bbg-clip-text\b/.test(classStr) && /\bbg-gradient-to-/.test(classStr)) {
			findings.push({ id: "gradient-text", snippet: "bg-clip-text + bg-gradient (Tailwind)" });
		}

		const purpleText = classStr.match(/\btext-(?:purple|violet|indigo)-\d+\b/);
		if (purpleText && (["h1", "h2", "h3"].includes(tag) || /\btext-(?:[2-9]xl)\b/.test(classStr))) {
			findings.push({ id: "ai-color-palette", snippet: `${purpleText[0]} on heading` });
		}

		if (/\bfrom-(?:purple|violet|indigo)-\d+\b/.test(classStr) && /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/.test(classStr)) {
			findings.push({ id: "ai-color-palette", snippet: "Purple/violet gradient (Tailwind)" });
		}
	}

	return findings;
}

export interface HoverContrastOptions {
	readonly tag: string;
	readonly textColor: Color | null;
	readonly bg: Color | null;
	readonly ownBgAlpha?: number | null;
	readonly fontSize: number;
	readonly fontWeight: number;
	readonly hasDirectText: boolean;
	readonly isEmojiOnly?: boolean;
}

/**
 * WCAG contrast for the `:hover` state of an element whose hover rules change
 * its text color or background. The classic miss: a nav CTA whose intended
 * hover pair passes AA but a broader selector wins the specificity fight and
 * swaps in a failing pair. Only fires for elements that present as styled
 * controls, so plain inline links keep the same suppression as elsewhere.
 */
function checkHoverContrast(opts: HoverContrastOptions): RuleHit[] {
	const { tag, textColor, bg, ownBgAlpha, fontSize, fontWeight, hasDirectText, isEmojiOnly } = opts;
	if (!hasDirectText || isEmojiOnly || !textColor || !bg) return [];
	if (SAFE_TAGS.has(tag) && !(ownBgAlpha != null && ownBgAlpha > 0.5)) return [];

	const ratio = contrastRatio(textColor, bg);
	const threshold = isLargeText(fontSize, fontWeight) ? 3.0 : 4.5;
	if (ratio >= threshold) return [];

	return [
		{
			id: "low-contrast",
			snippet: `:hover state ${ratio.toFixed(1)}:1 (need ${threshold}:1) — text ${colorToHex(textColor)} on ${colorToHex(bg)}`,
		},
	];
}

/** A card shape: a shadow or border, plus a radius or a background. */
function isCardLikeFromProps(hasShadow: boolean, hasBorder: boolean, hasRadius: boolean, hasBg: boolean): boolean {
	if (!hasShadow && !hasBorder) return false;
	return hasRadius || hasBg;
}

/**
 * True when the color carries visible chroma, i.e. it reads as an accent rather
 * than near-neutral. Handles rgb()/rgba(), hex, oklch(), and hsl(); `var()`
 * references are expected to be resolved by the caller.
 */
function isAccentColor(cssColor: string | null | undefined): boolean {
	if (!cssColor) return false;
	const s = String(cssColor).trim();

	const rgbStrict = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
	if (rgbStrict) {
		const r = +rgbStrict[1];
		const g = +rgbStrict[2];
		const b = +rgbStrict[3];
		return Math.max(r, g, b) - Math.min(r, g, b) >= 40;
	}

	const hexMatch = /^#([0-9a-f]{3,8})\b/i.exec(s);
	if (hexMatch) {
		let h = hexMatch[1];
		if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("").slice(0, 6);
		else h = h.slice(0, 6);
		if (h.length === 6) {
			const r = parseInt(h.slice(0, 2), 16);
			const g = parseInt(h.slice(2, 4), 16);
			const b = parseInt(h.slice(4, 6), 16);
			return Math.max(r, g, b) - Math.min(r, g, b) >= 40;
		}
	}

	// oklch(L C H): chroma is the second number. Neutral grays sit under 0.02,
	// visible accents at 0.05+. Minification can drop the space after `%`
	// ("oklch(43%.15 34)"), so take the numbers in order rather than matching
	// L-then-space-then-C.
	if (/^oklch\(/i.test(s)) {
		const nums = s.match(/\d*\.\d+|\d+/g);
		if (nums && nums.length >= 2) {
			const c = parseFloat(nums[1]);
			return !Number.isNaN(c) && c >= 0.05;
		}
	}

	const hslMatch = /hsla?\(\s*[\d.]+\s*,\s*([\d.]+)%/i.exec(s);
	if (hslMatch) {
		const sat = parseFloat(hslMatch[1]);
		return !Number.isNaN(sat) && sat >= 20;
	}

	return false;
}

export { checkColors, checkHoverContrast, isAccentColor, isCardLikeFromProps };
