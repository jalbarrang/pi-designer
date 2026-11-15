/**
 * The text engine: matcher table, page analyzers, and the source-file entry point.
 * Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * This is the engine that runs on a file that is not a parsed page: CSS, JSX, TSX,
 * a component, a stylesheet block inside one. It blanks comments first, then applies
 * a table of line matchers plus a handful of whole-document analyzers, and dedupes
 * what it collected. The table is data on purpose — a rule reads as one line of
 * intent rather than as code to trace.
 */
import { EM_DASH_CHARS_PER_DASH, EM_DASH_FLOOR, OVERUSED_FONTS } from "../core/shared/constants.ts";
import { extractGoogleFontFamilies } from "../core/shared/fonts.ts";
import { isNeutralColor } from "../core/shared/color.ts";
import { isFullPage } from "../core/shared/page.ts";
import { applyInlineIgnores } from "../core/shared/inline-ignores.ts";
import { finding } from "../core/findings.ts";
import { scanCssTextForGlow, scanCssTextForGridBackground, scanCssTextForRadialHalo } from "../core/checks/css-scan.ts";
import { scanCssTextForMarquee, scanCssTextForPseudoStripe } from "../core/checks/css-rules.ts";
import type { Finding } from "../types.ts";
import {
	blankCommentsForMatchers,
	blankCssLineComments,
	extractCssInJs,
	extFromFilePath,
	extractStyleBlocks,
	JS_SOURCE_EXTS,
	STYLESHEET_EXTS,
	stripCssComments,
	stripCssInJsComments,
	stripJsComments,
} from "./strip-comments.ts";

/** True when a line declares a rounded corner (excluding `rounded-none`). */
const hasRounded = (line: string): boolean => /\brounded(?:-\w+)?\b/.test(line.replace(/\brounded-none\b/g, ""));

/** True when a line declares a border radius in longhand. */
const hasBorderRadius = (line: string): boolean => /border-radius/i.test(line);

/** True for elements whose single-edge border is structural, not decorative. */
const isSafeElement = (line: string): boolean => /<(?:blockquote|nav[\s>]|pre[\s>]|code[\s>]|a\s|input[\s>]|span[\s>])/i.test(line);

/** Strip HTML to plain text: script, style, comments, and tags go, so content analyzers do not read code as prose. */
function stripHtmlToText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");
}

/** Only a whole page gets the document-level analyzers, and only in a page format. */
function shouldRunPageAnalyzers(content: string, filePath: string): boolean {
	if (!isFullPage(content)) return false;
	const ext = extFromFilePath(filePath);
	return !ext || [".html", ".htm", ".astro", ".vue", ".svelte"].includes(ext);
}

/** A named color whose channels are equal, so it reads as achromatic. */
const NEUTRAL_COLOR_KEYWORDS: ReadonlySet<string> = new Set([
	"transparent", "currentcolor",
	"black", "white", "gray", "grey", "silver",
	"dimgray", "dimgrey", "darkgray", "darkgrey", "lightgray", "lightgrey",
	"gainsboro", "whitesmoke",
]);

/** The RGB channels of a hex color, or null when it is not one. */
function hexChannels(color: string): [number, number, number] | null {
	const long = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i);
	if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
	const short = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])(?:[0-9a-f])?$/i);
	if (short) return [1, 2, 3].map((i) => parseInt(short[i] + short[i], 16)) as [number, number, number];
	return null;
}

/**
 * Split one box-shadow layer into top-level tokens. Whitespace inside parentheses is
 * not a separator: `rgb(0 0 0)` and `var(--x, 4px)` are each one value, and splitting
 * them on spaces would read their innards as lengths.
 */
function tokenizeShadowLayer(layer: string): string[] {
	const tokens: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of String(layer || "")) {
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (depth === 0 && /\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** The last match of a global regex in a string, or null. */
function lastMatch(text: string | null | undefined, re: RegExp): RegExpExecArray | null {
	const all = [...String(text || "").matchAll(re)];
	return all.length > 0 ? (all[all.length - 1] as RegExpExecArray) : null;
}

/** True when a shadow token is a length: a number with an optional `px`. */
function isShadowLength(token: string): boolean {
	return /^-?\d*\.?\d+(?:px)?$/i.test(String(token || ""));
}

/**
 * Neutrality for colors as written in source CSS.
 *
 * The computed-style parser only reads the function forms a browser emits and reports
 * every other spelling as chromatic, so an unknown format is never silently skipped.
 * That default is wrong for authored CSS, where `#000` and `black` are normal: a plain
 * black hairline would read as a colored stripe. Hex and named neutrals are handled
 * here before deferring.
 */
function isNeutralAuthoredColor(rawColor: string | null | undefined): boolean {
	const c = String(rawColor || "").trim().toLowerCase();
	if (!c) return false;
	if (NEUTRAL_COLOR_KEYWORDS.has(c)) return true;

	// Modern rgb() takes space-separated channels, which the computed parser does not
	// read; normalize before delegating.
	if (/^rgba?\(/i.test(c)) {
		const channels = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
		if (channels) {
			const values = [1, 2, 3].map((i) => Number(channels[i]));
			return Math.max(...values) - Math.min(...values) < 30;
		}
		return isNeutralColor(c);
	}
	if (/^(?:hsla?|oklch|oklab|lab|lch|hwb)\(/i.test(c)) return isNeutralColor(c);

	const channels = hexChannels(c);
	if (channels) return Math.max(...channels) - Math.min(...channels) < 30;
	return false;
}

/** True when a `border: Npx solid <color>` declaration names a neutral color. */
function isNeutralBorderColor(str: string): boolean {
	const m = str.match(/solid\s+((?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+)/i);
	if (!m) return false;
	return isNeutralAuthoredColor(m[1]);
}

/**
 * One line matcher: a pattern, a gate that reads the line as context, and a formatter
 * that turns the match into the finding's snippet.
 */
export interface RegexMatcher {
	readonly id: string;
	readonly regex: RegExp;
	test(match: RegExpExecArray, context: string): boolean;
	fmt(match: RegExpExecArray, context: string): string;
}

/** The first overused Google font a stylesheet URL asks for, or an empty string. */
function firstOverusedGoogleFont(text: string): string {
	return extractGoogleFontFamilies(text).find((f) => OVERUSED_FONTS.has(f)) || "";
}

/** Tailwind background utilities that paint a saturated surface, for the gray-on-color gate. */
const TAILWIND_COLOR_BG_RE = /\bbg-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+\b/;

/** Every line matcher. Order matters only for readability; the engine runs them all. */
const REGEX_MATCHERS: readonly RegexMatcher[] = [
	// --- Side-tab ---
	{
		id: "side-tab",
		regex: /\bborder-[lrse]-(\d+)\b/g,
		test: (m, line) => {
			const n = +m[1];
			return hasRounded(line) ? n >= 2 : n >= 4;
		},
		fmt: (m) => m[0],
	},
	{
		id: "side-tab",
		regex: /border-(?:left|right)\s*:\s*(\d+)px\s+solid[^;]*/gi,
		test: (m, line) => {
			if (isSafeElement(line)) return false;
			if (isNeutralBorderColor(m[0])) return false;
			const n = +m[1];
			return hasBorderRadius(line) ? n >= 2 : n >= 3;
		},
		fmt: (m) => m[0].replace(/\s*;?\s*$/, ""),
	},
	{ id: "side-tab", regex: /border-(?:left|right)-width\s*:\s*(\d+)px/gi, test: (m, line) => !isSafeElement(line) && +m[1] >= 3, fmt: (m) => m[0] },
	{ id: "side-tab", regex: /border-inline-(?:start|end)\s*:\s*(\d+)px\s+solid/gi, test: (m, line) => !isSafeElement(line) && +m[1] >= 3, fmt: (m) => m[0] },
	{ id: "side-tab", regex: /border-inline-(?:start|end)-width\s*:\s*(\d+)px/gi, test: (m, line) => !isSafeElement(line) && +m[1] >= 3, fmt: (m) => m[0] },
	{ id: "side-tab", regex: /border(?:Left|Right)\s*[:=]\s*["'`](\d+)px\s+solid/g, test: (m) => +m[1] >= 3, fmt: (m) => m[0] },

	// --- Border accent on a rounded element ---
	{ id: "border-accent-on-rounded", regex: /\bborder-[tb]-(\d+)\b/g, test: (m, line) => hasRounded(line) && +m[1] >= 1, fmt: (m) => m[0] },
	{
		id: "border-accent-on-rounded",
		regex: /border-(?:top|bottom)\s*:\s*(\d+)px\s+solid/gi,
		test: (m, line) => +m[1] >= 3 && hasBorderRadius(line),
		fmt: (m) => m[0],
	},

	// --- Overused font ---
	{
		id: "overused-font",
		regex: /font-family\s*:\s*['"]?(Inter|Roboto|Open Sans|Lato|Montserrat|Arial|Helvetica|Fraunces|Geist Sans|Geist Mono|Geist|Mona Sans|Plus Jakarta Sans|Space Grotesk|Recoleta|Instrument Sans|Instrument Serif)\b/gi,
		test: () => true,
		fmt: (m) => m[0],
	},
	{
		id: "overused-font",
		regex: /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi,
		test: (m) => Boolean(firstOverusedGoogleFont(m[0])),
		fmt: (m) => `Google Fonts: ${firstOverusedGoogleFont(m[0])}`,
	},

	// --- Gradient text ---
	{
		id: "gradient-text",
		regex: /background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/gi,
		test: (_m, line) => /gradient/i.test(line),
		fmt: () => "background-clip: text + gradient",
	},
	{ id: "gradient-text", regex: /\bbg-clip-text\b/g, test: (_m, line) => /\bbg-gradient-to-/i.test(line), fmt: () => "bg-clip-text + bg-gradient" },

	// --- Tailwind gray on a colored background ---
	{
		id: "gray-on-color",
		regex: /\btext-(?:gray|slate|zinc|neutral|stone)-(\d+)\b/g,
		test: (_m, line) => TAILWIND_COLOR_BG_RE.test(line),
		fmt: (m, line) => {
			const bg = line.match(TAILWIND_COLOR_BG_RE);
			return `${m[0]} on ${bg?.[0] || "?"}`;
		},
	},

	// --- Tailwind generated palette ---
	{
		id: "ai-color-palette",
		regex: /\btext-(?:purple|violet|indigo)-(\d+)\b/g,
		test: (_m, line) => /\btext-(?:[2-9]xl|[3-9]xl)\b|<h[1-3]/i.test(line),
		fmt: (m) => `${m[0]} on heading`,
	},
	{
		id: "ai-color-palette",
		regex: /\bfrom-(?:purple|violet|indigo)-(\d+)\b/g,
		test: (_m, line) => /\bto-(?:purple|violet|indigo|blue|cyan|pink|fuchsia)-\d+\b/.test(line),
		fmt: (m) => `${m[0]} gradient`,
	},

	// --- Bounce and elastic easing ---
	{ id: "bounce-easing", regex: /\banimate-bounce\b/g, test: () => true, fmt: () => "animate-bounce (Tailwind)" },
	{
		id: "bounce-easing",
		regex: /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi,
		test: () => true,
		fmt: (m) => {
			const token = m[1].split(/[,\s]+/).find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
			return `animation: ${token || m[1].trim()}`;
		},
	},
	{
		id: "bounce-easing",
		regex: /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g,
		test: (m) => {
			const y1 = parseFloat(m[2]);
			const y2 = parseFloat(m[4]);
			return y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1;
		},
		fmt: (m) => `cubic-bezier(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})`,
	},

	// --- Layout property transitions ---
	// JSX inline style objects use comma-delimited quoted values, not semicolons.
	{
		id: "layout-transition",
		regex: /transition\s*:\s*(?:(['"])((?:(?!\1)[^\\]|\\.)*)\1|([^;{}]+))/gi,
		test: (m) => {
			const val = (m[2] ?? m[3] ?? "").toLowerCase();
			if (/\ball\b/.test(val)) return false;
			return /\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding\b|\bmargin\b/.test(val);
		},
		fmt: (m) => {
			const raw = m[2] ?? m[3] ?? "";
			const found = raw.match(
				/\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding(?:-(?:top|right|bottom|left))?\b|\bmargin(?:-(?:top|right|bottom|left))?\b/gi,
			);
			return `transition: ${found ? found.join(", ") : raw.trim()}`;
		},
	},
	{
		id: "layout-transition",
		regex: /transition-property\s*:\s*(?:(['"])((?:(?!\1)[^\\]|\\.)*)\1|([^;{}]+))/gi,
		test: (m) => {
			const val = (m[2] ?? m[3] ?? "").toLowerCase();
			if (/\ball\b/.test(val)) return false;
			return /\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding\b|\bmargin\b/.test(val);
		},
		fmt: (m) => {
			const raw = m[2] ?? m[3] ?? "";
			const found = raw.match(
				/\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding(?:-(?:top|right|bottom|left))?\b|\bmargin(?:-(?:top|right|bottom|left))?\b/gi,
			);
			return `transition-property: ${found ? found.join(", ") : raw.trim()}`;
		},
	},

	// --- Broken images ---
	{ id: "broken-image", regex: /<img\b[^>]*?\bsrc\s*=\s*(?:""|''|"\s+"|'\s+'|"#"|'#')/gi, test: () => true, fmt: (m) => m[0].slice(0, 100) },
	{
		id: "broken-image",
		regex: /<img\b(?:(?!\bsrc\s*=)[^>])*>/gi,
		test: (m) => !/\bsrc\s*=/i.test(m[0]),
		fmt: (m) => m[0].slice(0, 100),
	},
];

/** A whole-document analyzer: raw source in, findings out. */
type RegexAnalyzer = (content: string, filePath: string) => Finding[];

/** SaaS phrase list for the marketing-buzzword analyzer. */
const BUZZWORDS: readonly string[] = [
	"streamline your", "empower your", "supercharge your",
	"unleash your", "unleash the power", "leverage the power",
	"built for the modern", "trusted by leading", "trusted by the world",
	"best-in-class", "industry-leading", "world-class", "enterprise-grade",
	"next-generation", "cutting-edge", "transform your business",
	"revolutionize", "game-changer", "game changing",
	"mission-critical", "best of breed", "future-proof", "future proof",
	"seamless experience", "seamlessly integrate",
	"drive engagement", "drive growth", "drive results",
	"harness the power",
];

/** The analyzers that read rendered text content rather than styles. */
const TEXT_CONTENT_ANALYZER_IDS: readonly string[] = ["em-dash-overuse", "marketing-buzzword", "aphoristic-cadence"];

/**
 * Whole-document analyzers. Each takes the raw source, because the spacing, copy, and
 * shadow tells are properties of the file rather than of one line.
 */
const REGEX_ANALYZERS: readonly RegexAnalyzer[] = [
	// Monotonous spacing: one rounded value dominating, with at most three in play.
	(content, filePath) => {
		const vals: number[] = [];
		const pxRe = /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*(\d+)px/gi;
		for (let m = pxRe.exec(content); m !== null; m = pxRe.exec(content)) {
			const v = +m[1];
			if (v > 0 && v < 200) vals.push(v);
		}
		const remRe = /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([\d.]+)rem/gi;
		for (let m = remRe.exec(content); m !== null; m = remRe.exec(content)) {
			const v = Math.round(parseFloat(m[1]) * 16);
			if (v > 0 && v < 200) vals.push(v);
		}
		const gapRe = /gap\s*:\s*(\d+)px/gi;
		for (let m = gapRe.exec(content); m !== null; m = gapRe.exec(content)) vals.push(+m[1]);
		const twRe = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-(\d+)\b/g;
		for (let m = twRe.exec(content); m !== null; m = twRe.exec(content)) vals.push(+m[1] * 4);

		const rounded = vals.map((v) => Math.round(v / 4) * 4);
		if (rounded.length < 10) return [];
		const counts: Record<string, number> = {};
		for (const v of rounded) counts[v] = (counts[v] || 0) + 1;
		const maxCount = Math.max(...Object.values(counts));
		const pct = maxCount / rounded.length;
		const unique = [...new Set(rounded)].filter((v) => v > 0);
		if (pct <= 0.6 || unique.length > 3) return [];
		const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
		return [finding("monotonous-spacing", filePath, `~${dominant}px used ${maxCount}/${rounded.length} times (${Math.round(pct * 100)}%)`)];
	},

	// Em-dash overuse (advisory). The tell is saturation, not the occasional dash, so
	// two gates hold: an absolute floor and a density. Character entities are decoded
	// first, because a rendered `&mdash;` is a dash the counter would otherwise miss.
	(content, filePath) => {
		const text = stripHtmlToText(content).replace(/&mdash;|&#0*8212;|&#x0*2014;/gi, "—");
		let count = 0;
		const re = /[—]|--(?=\S)/g;
		while (re.exec(text) !== null) count++;
		if (count < EM_DASH_FLOOR) return [];
		if (text.length > count * EM_DASH_CHARS_PER_DASH) return [];
		return [finding("em-dash-overuse", filePath, `${count} em-dashes in body text`)];
	},

	// Marketing buzzwords: how many SaaS phrases the copy leans on, with the first
	// occurrence quoted as evidence.
	(content, filePath) => {
		const text = stripHtmlToText(content);
		const lower = text.toLowerCase();
		let count = 0;
		let firstSample = "";
		for (const phrase of BUZZWORDS) {
			let from = 0;
			for (;;) {
				const idx = lower.indexOf(phrase, from);
				if (idx === -1) break;
				count++;
				if (!firstSample) {
					firstSample = text.slice(Math.max(0, idx - 12), Math.min(text.length, idx + phrase.length + 12)).trim();
				}
				from = idx + phrase.length;
			}
		}
		if (count === 0) return [];
		return [finding("marketing-buzzword", filePath, `${count} buzzword phrase${count === 1 ? "" : "s"}: "${firstSample}"`)];
	},

	// Aphoristic cadence: manufactured contrast followed by a short rebuttal. Three
	// constructions are the threshold; one is a sentence, not a voice.
	(content, filePath) => {
		const text = stripHtmlToText(content);
		const NOT_A_RE = /\bNot an? [a-z][^.!?]{1,40}[.!]\s+[A-Z][^.!?]{1,60}[.!]/g;
		const SHORT_REBUTTAL_RE = /\b[A-Z][^.!?]{4,80}[.!]\s+(No|Just)\s+[a-z][^.!?]{2,60}[.!]/g;
		let count = 0;
		let firstSample = "";
		for (const re of [NOT_A_RE, SHORT_REBUTTAL_RE]) {
			re.lastIndex = 0;
			for (let m = re.exec(text); m !== null; m = re.exec(text)) {
				count++;
				if (!firstSample) firstSample = m[0].trim().slice(0, 80);
			}
		}
		if (count < 3) return [];
		return [finding("aphoristic-cadence", filePath, `${count} aphoristic constructions: "${firstSample}"`)];
	},

	// Dark glow and chromatic halo shadows, page-level.
	(content, filePath) => {
		const hits = scanCssTextForGlow(content);
		if (hits.length === 0) return [];
		const line = content.substring(0, hits[0].index).split("\n").length;
		return [finding("dark-glow", filePath, hits[0].snippet, line)];
	},

	// Radial-gradient halo on a dark page: the gradient sibling of the shadow tell.
	(content, filePath) => {
		const hits = scanCssTextForRadialHalo(content);
		if (hits.length === 0) return [];
		const line = content.substring(0, hits[0].index).split("\n").length;
		return [finding("radial-halo", filePath, hits[0].snippet, line)];
	},

	// Auto-scrolling marquees, both the element and the infinite CSS loop.
	(content, filePath) => scanCssTextForMarquee(content).map((hit) => finding("marquee", filePath, hit.snippet)),
];

/** Color tokens that name an accent, used to judge an inset stripe drawn with `var()`. */
const CHROMATIC_SHADOW_TOKEN_RE =
	/(?:^|-)(?:accent|kinpaku|patina|gold|red|orange|amber|yellow|lime|green|emerald|teal|cyan|blue|indigo|violet|purple|magenta|pink|rose|coral|aqua|mint|burgundy|crimson|scarlet)(?:-|$)/i;

/** True when an authored color is chromatic: not neutral, not a keyword that paints nothing. */
function insetStripeColorIsChromatic(rawColor: string): boolean {
	const color = String(rawColor || "").trim().replace(/\s*!important\s*$/i, "");
	if (/^(?:currentcolor|transparent|inherit|unset)$/i.test(color)) return false;
	const variable = color.match(/^var\(\s*(--[\w-]+)/i);
	if (variable) return CHROMATIC_SHADOW_TOKEN_RE.test(variable[1]);
	if (!/^(?:#|rgba?\(|hsla?\(|hwb\(|oklch\(|oklab\(|lch\(|lab\(|color\(|[a-z]+$)/i.test(color)) return false;
	return !isNeutralAuthoredColor(color);
}

/** Blank comment bodies while preserving every byte offset, so line numbers hold. */
function blankCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * The inset-shadow stripe in stylesheet text: 3–12px on one axis, nothing on the other,
 * no blur or spread, chromatic. Selection state and structural tags are exempt, and a
 * narrow fixed width means artwork rather than an edge bar.
 *
 * Each layer is parsed by its grammar rather than by one spelling of it: a box-shadow
 * layer is `inset? && <length>{2,4} && <color>?` in any order, so `inset 4px 0 red`,
 * `4px 0 0 red inset`, and `red 4px 0 inset` all paint the same stripe.
 */
function scanInsetStripeCss(rawContent: string, filePath: string, lineOffset = 0): Finding[] {
	const content = blankCssComments(rawContent);
	const findings: Finding[] = [];
	const ruleRe = /([^{};]+)\{([^{}]*)\}/g;

	// Rule matches arrive in source order, so a monotonic cursor derives every line in
	// one pass instead of re-scanning the prefix per rule.
	let scanOffset = 0;
	let scanLine = 1;
	const lineAtOffset = (offset: number): number => {
		while (scanOffset < offset) {
			if (content[scanOffset] === "\n") scanLine++;
			scanOffset++;
		}
		return scanLine;
	};

	for (let match = ruleRe.exec(content); match !== null; match = ruleRe.exec(content)) {
		// The selector group greedily absorbs the whitespace and newlines trailing the
		// previous rule; advance past that run before deriving the line.
		const selectorStart = match.index + (match[1].length - match[1].trimStart().length);
		const selector = match[1].trim().replace(/\s+/g, " ");
		if (!selector) continue;
		if (/:(?:hover|focus|focus-visible|focus-within|active|checked|target)\b/i.test(selector)) continue;
		if (/\[aria-selected\s*[*^$|~]?=\s*["']?true/i.test(selector)) continue;
		if (/\[aria-current(?!\s*[*^$|~]?=\s*["']?false)/i.test(selector)) continue;
		if (/(?:^|[\s._[-])(?:active|current|selected)(?![\w])/i.test(selector)) continue;
		if (/(?:^|[\s>+~,(])(?:button|hr|tr|td|th|table|blockquote|pre|code)(?![\w-])/i.test(selector)) continue;

		// The last of a repeated declaration wins, which is what the cascade paints.
		const width = lastMatch(match[2], /(?:^|;)\s*(?:width|inline-size)\s*:\s*(\d+(?:\.\d+)?)px/gi);
		if (width && Number(width[1]) <= 40) continue;

		const declaration = lastMatch(match[2], /(?:^|;)\s*box-shadow\s*:\s*([^;]+)/gi);
		if (!declaration || !/\binset\b/i.test(declaration[1])) continue;
		// `!important` qualifies the declaration, not the shadow value.
		const shadowValue = declaration[1].replace(/\s*!\s*important\s*$/i, "").trim();

		for (const rawLayer of shadowValue.split(/,(?![^(]*\))/)) {
			const tokens = tokenizeShadowLayer(rawLayer.trim());
			if (!tokens.some((token) => /^inset$/i.test(token))) continue;

			const rest = tokens.filter((token) => !/^inset$/i.test(token));
			const lengths = rest.filter(isShadowLength);
			const colors = rest.filter((token) => !isShadowLength(token));
			// Only the two offsets are required; blur and spread default to zero, which is
			// exactly the stripe shape. More than one non-length token is a layer we do not
			// claim to understand, so it is left alone.
			if (lengths.length < 2 || lengths.length > 4 || colors.length !== 1) continue;

			const values = lengths.map((token) => ({ n: Number(token.replace(/px$/i, "")), hasPx: /px$/i.test(token) }));
			const x = values[0];
			const y = values[1];
			const blur = values[2] ? values[2].n : 0;
			const spread = values[3] ? values[3].n : 0;
			if ((x.n !== 0 && !x.hasPx) || (y.n !== 0 && !y.hasPx) || blur !== 0 || spread !== 0) continue;

			const ax = Math.abs(x.n);
			const ay = Math.abs(y.n);
			if (!((ax >= 3 && ax <= 12 && ay === 0) || (ay >= 3 && ay <= 12 && ax === 0))) continue;
			if (!insetStripeColorIsChromatic(colors[0])) continue;

			const edge = ay === 0 ? (x.n > 0 ? "left" : "right") : y.n > 0 ? "top" : "bottom";
			const line = lineOffset + lineAtOffset(selectorStart);
			findings.push(finding("side-tab", filePath, `${selector} — inset box-shadow ${ay === 0 ? ax : ay}px stripe (${edge})`, line));
			break;
		}
	}
	return findings;
}

/**
 * Run the matcher table over one array of lines. `blockContext` widens the context a
 * matcher sees to nearby lines, which is what lets a multi-line CSS rule match.
 */
function runRegexMatchers(lines: readonly string[], filePath: string, lineOffset = 0, blockContext = false): Finding[] {
	const findings: Finding[] = [];
	for (const matcher of REGEX_MATCHERS) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			matcher.regex.lastIndex = 0;
			for (let m = matcher.regex.exec(line); m !== null; m = matcher.regex.exec(line)) {
				const context = blockContext ? lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(" ") : line;
				if (matcher.test(m, context)) {
					findings.push(finding(matcher.id, filePath, matcher.fmt(m, context), i + 1 + lineOffset));
				}
			}
		}
	}
	return findings;
}

/** The rendered-text analyzers a page scan runs. */
function runTextContentAnalyzers(content: string, filePath: string, _options: unknown = {}): Finding[] {
	if (!shouldRunPageAnalyzers(content, filePath)) return [];
	// The three text-content analyzers are analyzers 1–3; the spacing analyzer is not
	// about rendered text, and flat-type-hierarchy left this path because it needs
	// rendered role evidence.
	const findings: Finding[] = [];
	for (let i = 0; i < TEXT_CONTENT_ANALYZER_IDS.length; i++) {
		const analyzer = REGEX_ANALYZERS[1 + i];
		findings.push(...analyzer(content, filePath));
	}
	return findings;
}

export interface DetectTextOptions {
	/** Run the design-system rules over the source, when the caller has a design file. */
	readonly designSystem?: unknown;
	/** False bypasses the inline `impeccable-disable*` waivers. */
	readonly inlineIgnores?: boolean;
	/**
	 * The design-system checker. Upstream imports it directly; pi takes it as a
	 * dependency so this engine has no import cycle with the design-file reader.
	 */
	readonly checkDesignSystem?: (content: string, filePath: string, options: { designSystem: unknown }) => Finding[];
}

/**
 * Findings for one source file: matcher table, stylesheet-only scans, extracted style
 * blocks and CSS-in-JS templates, the design-system pass when a design file is in play,
 * dedup, then the page analyzers for a whole page, then the inline waivers.
 */
function detectText(content: string, filePath: string, options: DetectTextOptions = {}): Finding[] {
	const findings: Finding[] = [];
	const ext = extFromFilePath(filePath);
	const commentStrippedSource = JS_SOURCE_EXTS.has(ext)
		? stripJsComments(content, { jsx: ext === ".js" || ext === ".jsx" || ext === ".tsx" })
		: blankCommentsForMatchers(content, ext);
	const source = stripCssInJsComments(commentStrippedSource, ext);
	const lines = source.split("\n");

	// The matcher table runs over the whole source: Tailwind classes and inline styles
	// are single lines, and a block context lets multi-line CSS match too.
	findings.push(...runRegexMatchers(lines, filePath, 0, STYLESHEET_EXTS.has(ext)));

	// Pseudo-element stripes carry the side-tab silhouette with no border token, so the
	// line matchers cannot see them. Each hit carries a source offset, so the finding
	// gets a real line and line-scoped waivers keep working.
	const pseudoStripeFindings = (text: string, lineOffset: number): Finding[] =>
		scanCssTextForPseudoStripe(text).map((hit) =>
			finding(hit.id, filePath, hit.snippet, lineOffset + text.slice(0, hit.index).split("\n").length),
		);

	if (STYLESHEET_EXTS.has(ext)) {
		findings.push(...scanInsetStripeCss(content, filePath));
		findings.push(...pseudoStripeFindings(content, 0));
	}

	// Block-level CSS needs multiple declarations, so it scans the whole source.
	findings.push(
		...scanCssTextForGridBackground(source).map((hit) =>
			finding("codex-grid-background", filePath, hit.snippet, source.substring(0, hit.index).split("\n").length),
		),
	);

	// `<style>` blocks in component formats.
	for (const block of extractStyleBlocks(content, ext)) {
		const blockContent = blankCssLineComments(stripCssComments(block.content));
		findings.push(...runRegexMatchers(blockContent.split("\n"), filePath, block.startLine - 1, true));
		// `startLine` is the first line after the `<style>` tag, while `block.content`
		// begins right after that tag, so its own line 1 sits on the tag's line: the
		// 1-based offset is startLine - 2. The matcher call keeps startLine - 1 because
		// it indexes split lines from zero.
		findings.push(...scanInsetStripeCss(blockContent, filePath, block.startLine - 2));
		findings.push(...pseudoStripeFindings(blockContent, block.startLine - 2));
	}

	// CSS-in-JS template literals.
	for (const block of extractCssInJs(source, ext)) {
		const blockContent = stripCssComments(block.content);
		findings.push(...runRegexMatchers(blockContent.split("\n"), filePath, block.startLine - 1, true));
		findings.push(...scanInsetStripeCss(blockContent, filePath, block.startLine - 1));
		findings.push(...pseudoStripeFindings(blockContent, block.startLine - 1));
	}

	if (options.designSystem && options.checkDesignSystem) {
		findings.push(...options.checkDesignSystem(content, filePath, { designSystem: options.designSystem }));
	}

	// Same rule, same snippet, within two lines: one finding, not two.
	const deduped: Finding[] = [];
	for (const f of findings) {
		const isDupe = deduped.some((d) => d.antipattern === f.antipattern && d.snippet === f.snippet && Math.abs(d.line - f.line) <= 2);
		if (!isDupe) deduped.push(f);
	}

	// Document analyzers only run on a whole page.
	if (shouldRunPageAnalyzers(content, filePath)) {
		for (const analyzer of REGEX_ANALYZERS) deduped.push(...analyzer(content, filePath));
	}

	// Inline `impeccable-disable*` waivers travel with the file.
	return options.inlineIgnores === false ? deduped : [...applyInlineIgnores(deduped, content)];
}

void 0;

export {
	BUZZWORDS,
	detectText,
	hexChannels,
	insetStripeColorIsChromatic,
	isNeutralAuthoredColor,
	isNeutralBorderColor,
	isShadowLength,
	lastMatch,
	NEUTRAL_COLOR_KEYWORDS,
	REGEX_ANALYZERS,
	REGEX_MATCHERS,
	runRegexMatchers,
	runTextContentAnalyzers,
	scanInsetStripeCss,
	stripHtmlToText,
	TEXT_CONTENT_ANALYZER_IDS,
	tokenizeShadowLayer,
};
export type { RegexAnalyzer };
