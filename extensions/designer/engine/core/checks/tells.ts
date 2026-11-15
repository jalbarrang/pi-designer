/**
 * Page and element tells: the cream palette, an oversized hero headline, and the
 * hairline-border-plus-wide-shadow card. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */
import { parseAnyColor, type Color } from "../shared/color.ts";
import { readOwnBackgroundColor } from "./background.ts";
import { cssColorIsTransparent } from "./quality.ts";
import { resolveFontSizePx } from "./lengths.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/**
 * The default "tasteful" AI surface: a warm off-white. Light, warm-ordered, and
 * tinted by only a little — white and a strong color both fail.
 */
function isCreamColor(rgb: Color | null | undefined): boolean {
	if (!rgb) return false;
	const { r, g, b } = rgb;
	if (Math.min(r, g, b) < 209) return false;
	if (!(r >= g && g >= b)) return false;
	const warmth = r - b;
	return warmth >= 6 && warmth <= 48;
}

// Tailwind background utilities that render as a warm off-white surface. A static
// scan never fetches Tailwind's CSS, so `bg-amber-50` on the body resolves to
// nothing in computed style; these tokens map to their real hex and still pass
// through isCreamColor, so neutral grays and strong shades drop out.
const TAILWIND_BG_HEX: Readonly<Record<string, string>> = {
	"bg-amber-50": "#fffbeb",
	"bg-amber-100": "#fef3c7",
	"bg-orange-50": "#fff7ed",
	"bg-orange-100": "#ffedd5",
	"bg-yellow-50": "#fefce8",
	"bg-stone-50": "#fafaf9",
	"bg-stone-100": "#f5f5f4",
	"bg-stone-200": "#e7e5e4",
};

/** The Tailwind background token that paints a cream surface, if the class list names one. */
function creamFromClassList(cls: string | null | undefined): string | null {
	if (!cls) return null;

	// Arbitrary value: `bg-[#f5f0e6]` or `bg-[rgb(245_240_230)]` (underscores are spaces).
	const arb = cls.match(/\bbg-\[([^\]]+)\]/);
	if (arb && isCreamColor(parseAnyColor(arb[1].replace(/_/g, " ")))) return `bg-[${arb[1]}]`;

	for (const [tok, hex] of Object.entries(TAILWIND_BG_HEX)) {
		if (new RegExp(`(^|\\s)${tok}($|\\s)`).test(cls) && isCreamColor(parseAnyColor(hex))) return tok;
	}
	return null;
}

/** The cream-palette tell on the page's ground, read from computed background first, then Tailwind classes. */
function checkCreamPalette(
	doc: {
		readonly body?: DomElement | null;
		readonly documentElement?: DomElement | null;
		querySelector?(selector: string): DomElement | null;
	},
	dom: DomAdapter,
): RuleHit[] {
	const findings: RuleHit[] = [];
	const body = doc.body ?? doc.querySelector?.("body") ?? null;
	if (!body) return findings;
	const html = doc.documentElement ?? null;
	const getCS = (el: DomElement) => dom.getComputedStyle(el);

	// Computed background covers inline, `<style>`, and linked CSS, plus Tailwind once
	// it is actually rendered.
	let bg = readOwnBackgroundColor(body, getCS(body), "static");
	if (!bg || bg.a === 0) {
		if (html) bg = readOwnBackgroundColor(html, getCS(html), "static");
	}
	if (isCreamColor(bg) && bg) {
		findings.push({ id: "cream-palette", snippet: `cream/beige page background rgb(${bg.r}, ${bg.g}, ${bg.b})` });
		return findings;
	}

	// Tailwind class fallback, for the static path where utilities never resolve.
	for (const el of [body, html]) {
		const tok = creamFromClassList(el?.getAttribute?.("class") ?? "");
		if (tok) {
			findings.push({ id: "cream-palette", snippet: `cream/beige page background (Tailwind ${tok})` });
			break;
		}
	}
	return findings;
}

// A long headline at display size that actually dominates the viewport. A punchy
// one- or two-word headline at the same size is a legitimate choice, and a
// large-but-contained two-line hero should pass: length and viewport share
// together are the tell.
const OVERSIZED_H1_FONT_PX = 72;
const OVERSIZED_H1_MIN_CHARS = 40;
const OVERSIZED_H1_MIN_VIEWPORT_HEIGHT_RATIO = 0.28;
const OVERSIZED_H1_MIN_VIEWPORT_AREA_RATIO = 0.25;

export interface OversizedH1Options {
	readonly tag: string;
	readonly fontSize: number;
	readonly headingText: string;
	/** Null when the engine cannot lay out; the viewport gate then abstains. */
	readonly rect?: Rect | null;
	readonly viewportWidth?: number;
	readonly viewportHeight?: number;
}

/** The oversized-hero-headline tell for one heading. */
function checkOversizedH1(opts: OversizedH1Options): RuleHit[] {
	const { tag, fontSize, headingText, rect = null, viewportWidth = 0, viewportHeight = 0 } = opts;
	if (tag !== "h1") return [];
	const textLen = headingText.length;

	if (fontSize >= OVERSIZED_H1_FONT_PX && textLen >= OVERSIZED_H1_MIN_CHARS) {
		let viewportDetail = "";
		if (rect && viewportWidth > 0 && viewportHeight > 0) {
			const heightRatio = rect.height / viewportHeight;
			const areaRatio = (rect.width * rect.height) / (viewportWidth * viewportHeight);
			const dominatesViewport =
				heightRatio >= OVERSIZED_H1_MIN_VIEWPORT_HEIGHT_RATIO || areaRatio >= OVERSIZED_H1_MIN_VIEWPORT_AREA_RATIO;
			if (!dominatesViewport) return [];
			viewportDetail = `, ${Math.round(heightRatio * 100)}vh`;
		}
		return [
			{
				id: "oversized-h1",
				snippet: `${Math.round(fontSize)}px h1, ${textLen} chars${viewportDetail} "${headingText.slice(0, 60)}"`,
			},
		];
	}
	return [];
}

/** Oversized h1 from a parsed style, with the font size resolved through the parent chain. */
function checkElementOversizedH1InDoc(el: DomElement, tag: string, dom: DomAdapter): RuleHit[] {
	if (tag !== "h1") return [];
	const fontSize = resolveFontSizePx(el, (node) => dom.getComputedStyle(node));
	const headingText = (el.textContent || "").trim().replace(/\s+/g, " ");
	return checkOversizedH1({ tag, fontSize, headingText });
}

/** Oversized h1 from a live style and rect. */
function checkElementOversizedH1DOM(el: DomElement, dom: DomAdapter, viewportWidth = 0, viewportHeight = 0): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (tag !== "h1") return [];
	const fontSize = parseFloat(dom.getComputedStyle(el).fontSize ?? "") || 0;
	const headingText = (el.textContent || "").trim().replace(/\s+/g, " ");
	return checkOversizedH1({ tag, fontSize, headingText, rect: el.getBoundingClientRect?.() ?? null, viewportWidth, viewportHeight });
}

// ─── Hairline border plus wide diffuse shadow ───────────────────────────────

const CSS_COLOR_TOKEN_RE = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:black|white|transparent|currentcolor)\b/gi;

/** The alpha of the first color token in a shadow layer; opaque when it has none. */
function shadowLayerAlpha(layer: string): number {
	CSS_COLOR_TOKEN_RE.lastIndex = 0;
	const match = CSS_COLOR_TOKEN_RE.exec(layer);
	if (!match) return 1;
	if (match[0].toLowerCase() === "transparent") return 0;
	const parsed = parseAnyColor(match[0]);
	return parsed ? parsed.a : 1;
}

/**
 * The largest blur radius in a box-shadow, across layers whose alpha clears
 * `minAlpha`. Color tokens and keywords are stripped first, leaving the ordered
 * lengths (offset-x, offset-y, blur, [spread]); unitless zeros and px values read
 * the same this way.
 */
function shadowMaxBlurPx(boxShadow: string | null | undefined, { minAlpha = 0 }: { minAlpha?: number } = {}): number {
	if (!boxShadow || boxShadow === "none") return 0;
	let maxBlur = 0;
	for (const layer of boxShadow.split(/,(?![^()]*\))/)) {
		if (shadowLayerAlpha(layer) < minAlpha) continue;
		const cleaned = layer.replace(CSS_COLOR_TOKEN_RE, " ").replace(/\b[a-z]+\b/gi, " ");
		const nums = [...cleaned.matchAll(/-?\d*\.?\d+/g)].map((m) => parseFloat(m[0]));
		if (nums.length >= 3) maxBlur = Math.max(maxBlur, nums[2]);
	}
	return maxBlur;
}

/** The alpha of a border color, treating unreadable values as opaque. */
function cssColorAlpha(value: string | null | undefined): number {
	if (cssColorIsTransparent(value)) return 0;
	const parsed = parseAnyColor(value);
	return parsed ? parsed.a : 1;
}

export interface ThinBorderWideShadowOptions {
	readonly borderWidths: readonly number[];
	readonly borderColors: readonly string[];
	readonly boxShadow?: string | null;
}

/**
 * At least two visible hairline borders (1.5px or thinner, at 0.28 alpha or more)
 * plus a 16px-or-wider diffuse shadow: the "subtle card" recipe generated UI
 * converges on.
 */
function checkGptThinBorderWideShadow(opts: ThinBorderWideShadowOptions): RuleHit[] {
	const { borderWidths, borderColors, boxShadow } = opts;
	const visibleThinBorders = borderWidths
		.map((width, index) => ({ width, alpha: cssColorAlpha(borderColors[index] || "") }))
		.filter(({ width, alpha }) => width > 0 && width <= 1.5 && alpha >= 0.28);
	const maxBorder = Math.max(0, ...visibleThinBorders.map(({ width }) => width));
	const blur = shadowMaxBlurPx(boxShadow, { minAlpha: 0.12 });
	if (visibleThinBorders.length >= 2 && blur >= 16) {
		return [{ id: "gpt-thin-border-wide-shadow", snippet: `${maxBorder}px border + ${Math.round(blur)}px shadow blur` }];
	}
	return [];
}

function borderWidthsFromStyle(style: CssStyle): number[] {
	return [
		parseFloat(style.borderTopWidth ?? "") || 0,
		parseFloat(style.borderRightWidth ?? "") || 0,
		parseFloat(style.borderBottomWidth ?? "") || 0,
		parseFloat(style.borderLeftWidth ?? "") || 0,
	];
}

function borderColorsFromStyle(style: CssStyle): string[] {
	return [
		style.borderTopColor || "",
		style.borderRightColor || "",
		style.borderBottomColor || "",
		style.borderLeftColor || "",
	];
}

/** The hairline-plus-shadow tell from a parsed or live style. */
function checkElementGptBorderShadow(style: CssStyle): RuleHit[] {
	return checkGptThinBorderWideShadow({
		borderWidths: borderWidthsFromStyle(style),
		borderColors: borderColorsFromStyle(style),
		boxShadow: style.boxShadow || "",
	});
}

export {
	borderColorsFromStyle,
	borderWidthsFromStyle,
	checkCreamPalette,
	checkElementGptBorderShadow,
	checkElementOversizedH1DOM,
	checkElementOversizedH1InDoc,
	checkGptThinBorderWideShadow,
	checkOversizedH1,
	creamFromClassList,
	cssColorAlpha,
	isCreamColor,
	OVERSIZED_H1_FONT_PX,
	OVERSIZED_H1_MIN_CHARS,
	shadowLayerAlpha,
	shadowMaxBlurPx,
	TAILWIND_BG_HEX,
};
