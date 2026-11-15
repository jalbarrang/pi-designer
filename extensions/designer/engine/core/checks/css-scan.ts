/**
 * Text-level CSS scanning: custom properties, glow, grid, and radial-halo
 * tells. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These run on raw CSS/HTML text, so the static engine, the regex engine, and
 * the page-level HTML pass all reach the same verdicts. A hit carries the source
 * offset so the caller can turn it into a line number.
 */
import {
	CSS_NAMED_COLORS,
	colorToHex,
	hasChroma,
	parseAnyColor,
	type Color,
	relativeLuminance,
	splitTopLevelCommas,
} from "../shared/color.ts";
import type { RuleHit } from "./rule-hit.ts";

/** A finding located by character offset in the scanned text. */
export interface TextHit {
	readonly index: number;
	readonly snippet: string;
}

/** The color token in a shadow layer, or null when it has none. */
interface ShadowColor {
	readonly color: Color | null;
	readonly start: number;
	readonly end: number;
}

/**
 * Locate the color token in one shadow layer. Both serialization orders are
 * handled: computed style puts the color first (`rgb(…) 0px 0px 20px`), authored
 * CSS usually puts it last (`0 0 20px #3b82f6`). A token that exists but cannot
 * be parsed (unresolved `var()`, exotic space) still reports its span, with a
 * null color, so the caller abstains instead of guessing.
 */
function findShadowColor(layer: string): ShadowColor | null {
	const fn = layer.match(/(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\([^)]*\)/i);
	if (fn?.index != null) return { color: parseAnyColor(fn[0]), start: fn.index, end: fn.index + fn[0].length };
	const hex = layer.match(/#[0-9a-fA-F]{3,8}\b/);
	if (hex?.index != null) return { color: parseAnyColor(hex[0]), start: hex.index, end: hex.index + hex[0].length };
	const wordRe = /[a-zA-Z][a-zA-Z]*/g;
	for (let m = wordRe.exec(layer); m !== null; m = wordRe.exec(layer)) {
		const named = CSS_NAMED_COLORS[m[0].toLowerCase()];
		if (named) return { color: { ...named, a: 1 }, start: m.index, end: m.index + m[0].length };
	}
	return null;
}

/**
 * The length values of a shadow layer in declaration order, with the color token
 * removed so its components are not read as lengths. Handles computed px values
 * and authored unitless zeros (`0 0 20px`); rem/em approximate at 16px. Order is
 * offset-x, offset-y, blur, [spread].
 */
function extractShadowLengths(layer: string, colorStart: number | null, colorEnd: number | null): number[] {
	const stripped = colorStart != null && colorEnd != null
		? `${layer.slice(0, colorStart)} ${layer.slice(colorEnd)}`
		: layer;
	const vals: number[] = [];
	const re = /(-?\d*\.?\d+)(px|rem|em)?/g;
	for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
		let v = parseFloat(m[1]);
		if (m[2] === "rem" || m[2] === "em") v *= 16;
		vals.push(v);
	}
	return vals;
}

export interface GlowOptions {
	readonly boxShadow?: string | null;
	readonly textShadow?: string | null;
	readonly effectiveBg?: Color | null;
}

/**
 * Two glow tells, in any color format:
 *
 * 1. A zero-offset chromatic halo (`0 0 Npx <color>`) on any background: light
 *    radiating evenly outward is never how elevation works. Achromatic
 *    zero-offset shadows stay legal as soft ambient elevation, as do focus
 *    rings, which have no blur.
 * 2. Any chromatic shadow with real blur on a dark background: the dark-mode
 *    glow accent.
 */
function checkGlow(opts: GlowOptions): RuleHit[] {
	const { boxShadow, textShadow, effectiveBg } = opts;
	const onDarkBg = effectiveBg ? relativeLuminance(effectiveBg) < 0.1 : false;

	const scan = (value: string | null | undefined, prop: string): RuleHit | null => {
		if (!value || value === "none") return null;
		for (const layer of value.split(/,(?![^(]*\))/)) {
			const colorInfo = findShadowColor(layer);
			// No color token, or one we cannot resolve: skip rather than guess.
			if (!colorInfo || !colorInfo.color) continue;
			const color = colorInfo.color;
			if (!hasChroma(color, 30)) continue;
			const vals = extractShadowLengths(layer, colorInfo.start, colorInfo.end);
			// Third value is blur (offset-x, offset-y, blur, [spread]).
			if (vals.length < 3 || vals[2] <= 4) continue;
			if (vals[0] === 0 && vals[1] === 0) {
				return { id: "dark-glow", snippet: `Zero-offset ${prop} glow (${colorToHex(color)})` };
			}
			if (onDarkBg) {
				return { id: "dark-glow", snippet: `Colored ${prop} glow (${colorToHex(color)}) on dark background` };
			}
		}
		return null;
	};

	const found = scan(boxShadow, "box-shadow") ?? scan(textShadow, "text-shadow");
	return found ? [found] : [];
}

/** The slice of a stylesheet `buildCustomPropMap` walks. */
interface CustomPropSheet {
	readonly cssRules?: ArrayLike<CustomPropRule>;
}

interface CustomPropRule {
	readonly type?: number;
	readonly selectorText?: string;
	readonly cssRules?: ArrayLike<CustomPropRule>;
	readonly style?: {
		readonly length: number;
		readonly [index: number]: string;
		getPropertyValue(property: string): string;
	} | null;
}

/**
 * Custom properties declared on `:root`, `html`, or `:host`, for resolving `var()`
 * references a parser hands back verbatim.
 *
 * This matters more than it looks: a utility framework can route every value through
 * a CSS variable (`font-weight: var(--font-weight-bold)`), so without this map every
 * style-based check silently sees the literal string and its `parseFloat` yields NaN.
 */
function buildCustomPropMap(sheets: ArrayLike<CustomPropSheet> | null | undefined): Map<string, string> {
	const map = new Map<string, string>();
	let list: CustomPropSheet[];
	try {
		list = Array.from(sheets ?? []);
	} catch {
		return map;
	}

	for (const sheet of list) {
		let rules: CustomPropRule[];
		try {
			rules = Array.from(sheet.cssRules ?? []);
		} catch {
			// A cross-origin sheet: nothing readable, and nothing to report.
			continue;
		}

		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			// Grouping rules (@media, @supports) carry nested style rules.
			if (rule.type === 4 || rule.type === 12) {
				try {
					rules.push(...Array.from(rule.cssRules ?? []));
				} catch {
					// Unreadable nested rules: skip this group.
				}
				continue;
			}
			if (rule.type !== 1) continue;

			const selector = rule.selectorText || "";
			if (!/(^|,\s*)(:root|html|:host)\b/i.test(selector)) continue;
			const style = rule.style;
			if (!style) continue;

			for (let j = 0; j < style.length; j++) {
				const prop = style[j];
				if (!prop || !prop.startsWith("--")) continue;
				const value = style.getPropertyValue(prop).trim();
				if (value) map.set(prop, value);
			}
		}
	}
	return map;
}

/**
 * CSS custom property declarations from raw text. First declaration wins, since
 * `:root` usually comes first; that is enough for the single-level `var()`
 * resolution the text engines need.
 */
function collectCssCustomProps(content: string): Map<string, string> {
	const map = new Map<string, string>();
	const re = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		if (!map.has(m[1])) map.set(m[1], m[2].trim());
	}
	return map;
}

/**
 * Resolve `var(--X[, fallback])` refs in a value string, up to 8 levels for
 * chained refs (`--a: var(--b)`). Returns the original string when nothing
 * resolves, and is safe to call on already-resolved values.
 */
function resolveVarRefs(raw: string, customPropMap: Map<string, string> | null | undefined, depth = 0): string {
	if (typeof raw !== "string" || !raw.includes("var(")) return raw;
	if (depth > 8) return raw;
	return raw.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (match, name: string, fallback: string | undefined) => {
		const v = customPropMap?.get(name);
		if (v != null) return resolveVarRefs(v, customPropMap, depth + 1);
		return fallback ? resolveVarRefs(fallback.trim(), customPropMap, depth + 1) : match;
	});
}

/** Resolve `var()` refs in a color string, then parse it. Null on any failure. */
function parseColorResolved(str: string | null | undefined, customPropMap?: Map<string, string> | null): Color | null {
	if (!str) return null;
	const resolved = customPropMap ? resolveVarRefs(str, customPropMap) : str;
	return parseAnyColor(resolved);
}

/**
 * Dark-page heuristic for raw CSS/HTML text: dark hex or rgb literals, Tailwind
 * dark background utilities, or a root-scoped (`body`/`html`/`:root`, or an
 * inline `<body style>`) background that resolves, via `var()`, to a dark color.
 *
 * The root scoping is deliberate: a light page with one dark accent chip must
 * not turn every tinted drop shadow into a "dark page" signal.
 */
function cssTextHasDarkRootBg(content: string, customProps: Map<string, string>): boolean {
	const darkBgRe = /background(?:-color)?\s*:\s*(?:#(?:0[0-9a-f]|1[0-9a-f]|2[0-3])[0-9a-f]{4}\b|#(?:0|1)[0-9a-f]{2}\b|rgb\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\))/i;
	const twDarkBg = /\bbg-(?:gray|slate|zinc|neutral|stone)-(?:9\d{2}|800)\b/;
	if (darkBgRe.test(content) || twDarkBg.test(content)) return true;

	const rootScopes: string[] = [];
	const blockRe = /(?:^|[}\s,;>])(?:body|html|:root)\s*(?:,[^{]*)?\{([^}]*)\}/gi;
	for (let sm = blockRe.exec(content); sm !== null; sm = blockRe.exec(content)) rootScopes.push(sm[1]);
	const inlineBody = content.match(/<body[^>]*\bstyle\s*=\s*"([^"]*)"/i);
	if (inlineBody) rootScopes.push(inlineBody[1]);

	for (const scope of rootScopes) {
		const bgRe = /background(?:-color)?\s*:\s*([^;{}]+)/gi;
		for (let bm = bgRe.exec(scope); bm !== null; bm = bgRe.exec(scope)) {
			const c = parseAnyColor(resolveVarRefs(bm[1].trim(), customProps));
			if (c && c.a > 0.5 && relativeLuminance(c) < 0.1) return true;
		}
	}
	return false;
}

/** Glow tells in raw CSS/HTML text, with `var()` refs resolved first. */
function scanCssTextForGlow(content: string): TextHit[] {
	const customProps = collectCssCustomProps(content);
	const hasDarkBg = cssTextHasDarkRootBg(content, customProps);

	const results: TextHit[] = [];
	const shadowRe = /\b(box-shadow|text-shadow)\s*:\s*([^;{}]+)/gi;
	for (let m = shadowRe.exec(content); m !== null; m = shadowRe.exec(content)) {
		const prop = m[1].toLowerCase();
		const value = resolveVarRefs(m[2].trim(), customProps);
		for (const layer of value.split(/,(?![^(]*\))/)) {
			const colorInfo = findShadowColor(layer);
			if (!colorInfo || !colorInfo.color || !hasChroma(colorInfo.color, 30)) continue;
			const vals = extractShadowLengths(layer, colorInfo.start, colorInfo.end);
			if (vals.length < 3 || vals[2] <= 4) continue;
			const zeroOffset = vals[0] === 0 && vals[1] === 0;
			if (!zeroOffset && !hasDarkBg) continue;
			results.push({
				index: m.index,
				snippet: zeroOffset
					? `Zero-offset ${prop} glow (${colorToHex(colorInfo.color)})`
					: `Colored ${prop} glow (${colorToHex(colorInfo.color)}) on dark page`,
			});
			break; // one finding per declaration
		}
	}
	return results;
}

/**
 * A decorative two-axis grid drawn with hairline `linear-gradient` layers tiled
 * by a fixed pixel cell. Both signals must appear in one declaration block:
 * unrelated rules must not add up across a file. A single hairline tiled by a 2D
 * pixel cell is a line, divider, or rail, not a grid. Capped at one finding per
 * source, which is what the page-level check has always reported.
 */
function scanCssTextForGridBackground(content: string): TextHit[] {
	const hairlineRe = /\b\d{1,3}px\s*,\s*transparent\s+\d{1,3}px/gi;
	const invertedHairlineRe = /transparent\s+calc\(100%\s*-\s*\d{1,3}px\)/gi;
	const sizeDeclPxRe = /background-size\s*:[^;{}"']*\b\d{1,3}px\b/i;
	const shorthandPxAnyRe = /\/\s*\d{1,3}px\b/;
	const bgDeclRe = /\bbackground(?:-image)?\s*:\s*([^;{}"']*)/gi;
	const blockRe = /\{([^{}]*)\}|style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/gi;

	for (let blk = blockRe.exec(content); blk !== null; blk = blockRe.exec(content)) {
		const block = blk[1] || blk[2] || blk[3] || "";
		let hairlineCount = 0;
		let bgJoined = "";
		bgDeclRe.lastIndex = 0;
		for (let bm = bgDeclRe.exec(block); bm !== null; bm = bgDeclRe.exec(block)) {
			hairlineCount += (bm[1].match(hairlineRe) || []).length;
			hairlineCount += (bm[1].match(invertedHairlineRe) || []).length;
			bgJoined += `${bm[1]};`;
		}
		if (hairlineCount === 0) continue;
		const hasPxCell = sizeDeclPxRe.test(block) || shorthandPxAnyRe.test(bgJoined);
		if (hairlineCount >= 2 && hasPxCell) {
			return [{ index: blk.index, snippet: "two-axis grid-line gradient background" }];
		}
	}
	return [];
}

/**
 * A chromatic halo drawn as a radial-gradient on a dark page: a saturated center
 * stop dissolving to transparent. The gradient sibling of the dark-glow shadow
 * tell. Gates, in order: dark root background; no `url()` layer, since
 * photographic imagery is exempt; first stop chromatic (spread >= 24) and
 * visible (alpha >= 0.7, because translucent light-scene washes composite with
 * content instead of painting a flat halo); last stop transparent; no small
 * pixel stop positions (<= 24px means a dot pattern); not `repeating-*`.
 */
function scanCssTextForRadialHalo(content: string): TextHit[] {
	const customProps = collectCssCustomProps(content);
	if (!cssTextHasDarkRootBg(content, customProps)) return [];

	const findings: TextHit[] = [];
	const seen = new Set<string>();
	const declRe = /background(?:-image)?\s*:\s*([^;{}]+)/gi;

	for (let m = declRe.exec(content); m !== null; m = declRe.exec(content)) {
		const value = resolveVarRefs(m[1].trim(), customProps);
		if (/url\s*\(/i.test(value)) continue;

		const gradRe = /(repeating-)?radial-gradient\(/gi;
		for (let g = gradRe.exec(value); g !== null; g = gradRe.exec(value)) {
			if (g[1]) continue; // repeating-* is a pattern, not a halo
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
			if (end < 0) break;
			const args = splitTopLevelCommas(value.slice(open + 1, end));
			if (args.length < 2) continue;

			const colorTokenRe = /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\([^)]*(?:\([^)]*\))?[^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i;
			const stops = args.filter((a) => colorTokenRe.test(a));
			if (stops.length < 2) continue;

			// A pixel-sized stop position means a repeating background-size
			// pattern, not a page-scale halo.
			const pxStop = stops.some((s) => {
				const pm = s.match(/(-?[\d.]+)px\b/);
				return pm && Math.abs(parseFloat(pm[1])) <= 24;
			});
			if (pxStop) continue;

			const first = stops[0].match(colorTokenRe);
			const last = stops[stops.length - 1].match(colorTokenRe);
			if (!first || !last) continue;

			const lastColor = /^transparent$/i.test(last[0]) ? { r: 0, g: 0, b: 0, a: 0 } : parseAnyColor(last[0]);
			if (!lastColor || lastColor.a > 0.05) continue;

			const firstColor = /^transparent$/i.test(first[0]) ? null : parseAnyColor(first[0]);
			if (!firstColor) continue;
			if (firstColor.a < 0.7) continue;
			const spread = Math.max(firstColor.r, firstColor.g, firstColor.b) - Math.min(firstColor.r, firstColor.g, firstColor.b);
			if (spread < 24) continue;

			const snippet = `radial-gradient halo (${colorToHex(firstColor)} → transparent) on dark page`;
			if (seen.has(snippet)) continue;
			seen.add(snippet);
			findings.push({ index: m.index, snippet });
		}
	}
	return findings;
}

/**
 * Best-effort extraction of the selector whose declaration block contains `index`
 * in raw CSS text, so a text finding can carry an anchor the browser pass can
 * resolve against a real element. Returns null for @-rule preludes, keyframe
 * steps, nested blocks, and anything that does not read as a selector; those
 * findings stay page-level.
 */
function enclosingCssSelector(cssText: string, index: number): string | null {
	if (!cssText || !Number.isFinite(index)) return null;
	const open = cssText.lastIndexOf("{", index);
	if (open === -1) return null;
	// A match inside an inline style fragment (`style="…"` appended to the corpus
	// by buildHtmlPatternCorpora) has no enclosing rule; the previous `{` belongs
	// to some other selector.
	const closeBeforeIndex = cssText.lastIndexOf("}", index);
	if (closeBeforeIndex > open) return null;
	const prevClose = Math.max(cssText.lastIndexOf("}", open - 1), cssText.lastIndexOf(";", open - 1));
	const raw = cssText
		.slice(prevClose + 1, open)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.trim()
		.replace(/\s+/g, " ");
	if (!raw || raw.startsWith("@") || /^\d/.test(raw) || /[{}<]/.test(raw)) return null;
	// Keyframe steps: percentage steps fail the digit test above, but `from` and
	// `to` would read as never-matching type selectors and get a valid finding
	// wrongly dropped by the zero-match rule downstream.
	if (/^(?:from|to)(?:\s*,\s*(?:from|to))*$/i.test(raw)) return null;
	return raw;
}

export {
	buildCustomPropMap,
	checkGlow,
	collectCssCustomProps,
	cssTextHasDarkRootBg,
	enclosingCssSelector,
	extractShadowLengths,
	findShadowColor,
	parseColorResolved,
	resolveVarRefs,
	scanCssTextForGlow,
	scanCssTextForGridBackground,
	scanCssTextForRadialHalo,
};
export type { CustomPropRule, CustomPropSheet, ShadowColor };
