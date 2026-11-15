/**
 * Rule-level CSS text scanning: pseudo-element stripes, inset-shadow stripes,
 * marquees, and pulsing dots. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These read stylesheet text directly, because the patterns they catch are
 * drawn in ways the element-level cascade never sees: a `::before` bar, an inset
 * box-shadow, an infinite keyframe loop.
 */
import { parseAnyColor } from "../shared/color.ts";
import { collectCssCustomProps, extractShadowLengths, findShadowColor, resolveVarRefs } from "./css-scan.ts";

/** A scan hit with the rule it belongs to. */
export interface ScannedHit {
	readonly id: string;
	readonly snippet: string;
	/** Source offset of the matched rule, when the scan can attribute one. */
	readonly index?: number;
	/** The selector the rule applies to, when one was parsed. */
	readonly selector?: string;
	/** Promoted severity; absent means the catalog default. */
	readonly severity?: "error";
}

/** Iterate `selector { declarations }` pairs. A shared /g instance is not re-entrant, so callers create it. */
const CSS_RULE_BLOCK_SOURCE = String.raw`([^{};]+)\{([^{}]*)\}`;

/** Parse a declaration block into a property map, last declaration winning. `!important` is stripped. */
function parseCssDeclBlock(block: string): Map<string, string> {
	const decls = new Map<string, string>();
	for (const part of String(block || "").split(";")) {
		const idx = part.indexOf(":");
		if (idx <= 0) continue;
		const prop = part.slice(0, idx).trim().toLowerCase();
		const value = part.slice(idx + 1).replace(/\s*!important\s*$/i, "").trim();
		if (prop && value) decls.set(prop, value);
	}
	return decls;
}

/** A px/rem/em length as pixels (rem and em at 16px), or null when it is not one. */
function cssLengthToPx(value: string | null | undefined): number | null {
	const m = String(value || "").trim().match(/^(-?[\d.]+)(px|rem|em)$/i);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return m[2].toLowerCase() === "px" ? n : n * 16;
}

/** True for `0`, `0px`, `-0%`, `0rem`, `0em` — a pinned edge. */
function isZeroOffset(value: string | null | undefined): boolean {
	return value != null && /^-?0(?:px|%|rem|em)?$/.test(String(value).trim());
}

/**
 * The side-tab stripe drawn as an absolutely-positioned `::before`/`::after`
 * box hugging an edge instead of a border. Mirrors the border rule's gates: 3–12px
 * thick, chromatic fill, full height (or full width) against a side edge.
 *
 * Selection state, interaction state, and structural tags are exempt for the
 * horizontal variant: a stripe on every tab in a group is decoration, but a
 * selected item's underline is an affordance.
 */
function scanCssTextForPseudoStripe(rawContent: string): ScannedHit[] {
	// Blank comment bodies byte-for-byte: a commented-out rule is not live CSS,
	// and each rule keeps its source offset so callers can attribute a line.
	const content = String(rawContent || "").replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
	const customProps = collectCssCustomProps(content);
	const findings: ScannedHit[] = [];
	const seen = new Set<string>();
	const ruleRe = new RegExp(CSS_RULE_BLOCK_SOURCE, "g");

	for (let m = ruleRe.exec(content); m !== null; m = ruleRe.exec(content)) {
		const selector = m[1].trim();
		if (!/::?(?:before|after)\b/i.test(selector)) continue;
		// Keep the border rule's prose exemptions (blockquote bars and so on).
		if (/\b(?:blockquote|pre|code|nav|hr)\b/i.test(selector)) continue;
		const decls = parseCssDeclBlock(m[2]);
		const position = decls.get("position");
		if (position !== "absolute" && position !== "fixed") continue;

		const widthPx = cssLengthToPx(resolveVarRefs(decls.get("width") || decls.get("inline-size") || "", customProps));
		const heightPx = cssLengthToPx(resolveVarRefs(decls.get("height") || decls.get("block-size") || "", customProps));
		const verticalCandidate = widthPx != null && widthPx >= 3 && widthPx <= 12;
		const horizontalCandidate =
			heightPx != null &&
			heightPx >= 3 &&
			heightPx <= 12 &&
			!/(?:^|[\s>+~,(])(?:a|button|summary|tr|td|th|table|li)(?![\w-])/i.test(selector) &&
			!/\[aria-selected\s*[*^$|~]?=\s*["']?true/i.test(selector) &&
			!/\[aria-current(?!\s*[*^$|~]?=\s*["']?false)/i.test(selector) &&
			!/(?:^|[\s._[-])(?:active|current|selected|btn[\w-]*|button[\w-]*|link[\w-]*)(?![\w])/i.test(selector) &&
			!/:(?:hover|focus|focus-visible|focus-within|active|checked)\b/i.test(selector);
		if (!verticalCandidate && !horizontalCandidate) continue;

		const offsets: Record<"top" | "right" | "bottom" | "left", string | undefined> = {
			top: decls.get("top"),
			right: decls.get("right"),
			bottom: decls.get("bottom"),
			left: decls.get("left"),
		};
		const inset = decls.get("inset");
		if (inset) {
			const p = inset.split(/\s+/);
			const [t, r, b, l] =
				p.length === 1 ? [p[0], p[0], p[0], p[0]]
				: p.length === 2 ? [p[0], p[1], p[0], p[1]]
				: p.length === 3 ? [p[0], p[1], p[2], p[1]]
				: [p[0], p[1], p[2], p[3]];
			if (offsets.top == null) offsets.top = t;
			if (offsets.right == null) offsets.right = r;
			if (offsets.bottom == null) offsets.bottom = b;
			if (offsets.left == null) offsets.left = l;
		}
		if (offsets.left == null) offsets.left = decls.get("inset-inline-start");
		if (offsets.right == null) offsets.right = decls.get("inset-inline-end");

		const heightValue = String(resolveVarRefs(decls.get("height") || decls.get("block-size") || "", customProps)).trim();
		const widthValue = String(resolveVarRefs(decls.get("width") || decls.get("inline-size") || "", customProps)).trim();

		let edge: string | null = null;
		let thicknessPx: number | null = null;
		if (verticalCandidate) {
			// Full-height stripes hug both corners; the floating variant backs off
			// each end by a small inset. Both are the same accent.
			const topPx = cssLengthToPx(resolveVarRefs(String(offsets.top ?? ""), customProps));
			const bottomPx = cssLengthToPx(resolveVarRefs(String(offsets.bottom ?? ""), customProps));
			const fullHeight =
				(isZeroOffset(offsets.top) && isZeroOffset(offsets.bottom)) ||
				/^100(?:\.0*)?%$/.test(heightValue) ||
				(topPx != null && bottomPx != null && topPx >= 0 && topPx <= 20 && bottomPx >= 0 && bottomPx <= 20);
			if (fullHeight) {
				edge = isZeroOffset(offsets.left) ? "left" : isZeroOffset(offsets.right) ? "right" : null;
				thicknessPx = widthPx;
			}
		}
		if (!edge && horizontalCandidate) {
			const fullWidth = (isZeroOffset(offsets.left) && isZeroOffset(offsets.right)) || /^100(?:\.0*)?%$/.test(widthValue);
			if (fullWidth) {
				edge = isZeroOffset(offsets.top) ? "top" : isZeroOffset(offsets.bottom) ? "bottom" : null;
				thicknessPx = heightPx;
			}
		}
		if (!edge) continue;

		// Chromatic fill only: a neutral hairline divider is not an accent stripe.
		// Unresolvable colors err toward detection, matching the border rule.
		const bg = String(resolveVarRefs(decls.get("background-color") || decls.get("background") || "", customProps)).trim();
		if (!bg || /^(?:none|transparent|inherit|initial|unset|currentcolor)$/i.test(bg)) continue;
		const colorToken = bg.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^)]*\)|#[0-9a-f]{3,8}\b/i);
		const parsed = parseAnyColor(colorToken ? colorToken[0] : bg);
		if (parsed) {
			if (parsed.a < 0.1) continue;
			const spread = Math.max(parsed.r, parsed.g, parsed.b) - Math.min(parsed.r, parsed.g, parsed.b);
			if (spread < 30) continue;
		} else if (/^(?:white|black|gray|grey|silver)$/i.test(bg)) {
			continue;
		}

		if (seen.has(selector)) continue;
		seen.add(selector);
		// The selector group absorbs the whitespace trailing the previous rule;
		// advance past it so `index` points at the selector itself.
		const selectorStart = m.index + (m[1].length - m[1].trimStart().length);
		findings.push({
			id: "side-tab",
			snippet: `${selector} — absolute ${thicknessPx}px pseudo-element stripe (${edge}: 0)`,
			index: selectorStart,
			selector,
		});
	}
	return findings;
}

/**
 * A side-tab stripe drawn as a single-edge inset box-shadow: 3–12px on one axis,
 * nothing on the other, no blur or spread, chromatic. Selection state and
 * structural tags are exempt, and narrow fixed-width elements use inset fills as
 * artwork rather than edge stripes.
 */
function scanCssTextForInsetStripe(content: string): ScannedHit[] {
	const customProps = collectCssCustomProps(content);
	const findings: ScannedHit[] = [];
	const seen = new Set<string>();
	const ruleRe = new RegExp(CSS_RULE_BLOCK_SOURCE, "g");

	for (let m = ruleRe.exec(content); m !== null; m = ruleRe.exec(content)) {
		const selector = m[1].trim();
		if (/:(?:hover|focus|focus-visible|focus-within|active|checked|target)\b/i.test(selector)) continue;
		if (/\[aria-selected\s*[*^$|~]?=\s*["']?true/i.test(selector)) continue;
		if (/\[aria-current(?!\s*[*^$|~]?=\s*["']?false)/i.test(selector)) continue;
		if (/(?:^|[\s._[-])(?:active|current|selected)(?![\w])/i.test(selector)) continue;
		if (/(?:^|[\s>+~,(])(?:button|hr|tr|td|th|table|blockquote|pre|code)(?![\w-])/i.test(selector)) continue;

		const decls = parseCssDeclBlock(m[2]);
		const shadow = decls.get("box-shadow");
		if (!shadow || !/\binset\b/i.test(shadow)) continue;

		// Narrow fixed-width elements (logo marks, icon glyphs) use inset fills as
		// artwork. Stripe targets are wider or leave width to layout.
		const declaredWidth = cssLengthToPx(resolveVarRefs(decls.get("width") || decls.get("inline-size") || "", customProps));
		if (declaredWidth != null && declaredWidth <= 40) continue;

		const value = resolveVarRefs(shadow, customProps);
		for (const layer of value.split(/,(?![^(]*\))/)) {
			if (!/\binset\b/i.test(layer)) continue;
			const colorInfo = findShadowColor(layer);
			// Unresolvable colors (currentColor, external vars): do not guess.
			if (!colorInfo || !colorInfo.color) continue;
			const c = colorInfo.color;
			if (c.a < 0.1) continue;
			const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
			if (chroma < 30) continue;
			const vals = extractShadowLengths(layer, colorInfo.start, colorInfo.end);
			const x = vals[0] || 0;
			const y = vals[1] || 0;
			const blur = vals[2] || 0;
			const sp = vals[3] || 0;
			if (blur !== 0 || sp !== 0) continue;
			const ax = Math.abs(x);
			const ay = Math.abs(y);
			const isStripe = (ax >= 3 && ax <= 12 && ay === 0) || (ay >= 3 && ay <= 12 && ax === 0);
			if (!isStripe) continue;
			if (seen.has(selector)) break;
			seen.add(selector);
			const edge = ay === 0 ? (x > 0 ? "left" : "right") : y > 0 ? "top" : "bottom";
			findings.push({
				id: "side-tab",
				snippet: `${selector} — inset box-shadow ${ay === 0 ? ax : ay}px stripe (${edge})`,
				selector,
			});
			break;
		}
	}
	return findings;
}

/**
 * `@keyframes` names whose body travels horizontally by a percentage: the
 * marquee loop. A centered element animating something else keeps a constant
 * X, so it never qualifies. Pixel-travel loops are bespoke product animations
 * (playheads, progress indicators), not marquees.
 */
function collectMarqueeKeyframes(content: string): Set<string> {
	const names = new Set<string>();
	const re = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g;

	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < content.length && depth > 0) {
			const ch = content.charCodeAt(i);
			if (ch === 0x7b) depth++;
			else if (ch === 0x7d) depth--;
			i++;
		}
		const body = content.slice(re.lastIndex, Math.max(re.lastIndex, i - 1));
		re.lastIndex = i;

		const pct: number[] = [];
		const xRe = /\btranslate(?:X|3d)?\(\s*(-?[\d.]+)%/gi;
		for (let xm = xRe.exec(body); xm !== null; xm = xRe.exec(body)) pct.push(parseFloat(xm[1]));
		if (pct.length === 0) continue;
		if (pct.length === 1 && /\bscale\(|\bopacity\s*:/i.test(body)) continue;
		// A lone declared X animates from the resting position, so its magnitude
		// is the travel.
		const travelPct = pct.length > 1 ? Math.max(...pct) - Math.min(...pct) : Math.abs(pct[0]);
		if (travelPct >= 20) names.add(m[1]);
	}
	return names;
}

/**
 * An auto-scrolling marquee: a `<marquee>` element, or an infinite animation
 * bound to a keyframe loop that travels far horizontally. `content` is
 * CSS-bearing text; `markup` is where the `<marquee>` tag lives, defaulting to
 * the same string for single-corpus callers.
 */
function scanCssTextForMarquee(content: string, markup: string = content): ScannedHit[] {
	const findings: ScannedHit[] = [];
	if (/<marquee\b/i.test(markup)) {
		findings.push({ id: "marquee", snippet: "<marquee> element", selector: "marquee" });
	}
	const marqueeKeyframes = collectMarqueeKeyframes(content);
	if (marqueeKeyframes.size === 0) return findings;

	const seen = new Set<string>();
	const ruleRe = new RegExp(CSS_RULE_BLOCK_SOURCE, "g");
	for (let m = ruleRe.exec(content); m !== null; m = ruleRe.exec(content)) {
		const selector = m[1].trim();
		const decls = parseCssDeclBlock(m[2]);
		for (const name of infiniteAnimationNames(decls)) {
			if (!marqueeKeyframes.has(name)) continue;
			const key = `${selector} ${name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push({ id: "marquee", snippet: `${selector} — infinite horizontal loop animation "${name}"`, selector });
		}
	}
	return findings;
}

/**
 * `@keyframes` names mapped to whether each reads as a pulse — varying opacity,
 * scale, or box-shadow. Rotation-only keyframes (spinners) are not pulses.
 */
function collectPulseKeyframes(content: string): Map<string, boolean> {
	const map = new Map<string, boolean>();
	const re = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g;

	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < content.length && depth > 0) {
			const ch = content.charCodeAt(i);
			if (ch === 0x7b) depth++;
			else if (ch === 0x7d) depth--;
			i++;
		}
		const body = content.slice(re.lastIndex, Math.max(re.lastIndex, i - 1));
		const pulses =
			/\bopacity\s*:/i.test(body) || /\bbox-shadow\s*:/i.test(body) || /\btransform\s*:[^;{}]*\bscale/i.test(body);
		if (!map.has(m[1]) || pulses) map.set(m[1], pulses);
		re.lastIndex = i;
	}
	return map;
}

const ANIMATION_VALUE_KEYWORDS: ReadonlySet<string> = new Set([
	"ease", "ease-in", "ease-out", "ease-in-out", "linear",
	"infinite", "alternate", "alternate-reverse", "normal", "reverse",
	"none", "forwards", "backwards", "both", "running", "paused",
	"step-start", "step-end", "inherit", "initial", "unset",
]);

/** Animation names running with `iteration-count: infinite`, from the shorthand or the longhands. */
function infiniteAnimationNames(decls: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	const shorthand = decls.get("animation");
	if (shorthand) {
		for (const layer of shorthand.split(/,(?![^(]*\))/)) {
			if (!/\binfinite\b/i.test(layer)) continue;
			const name = layer.split(/\s+/).find((t) => /^[a-zA-Z_-][\w-]*$/.test(t) && !ANIMATION_VALUE_KEYWORDS.has(t.toLowerCase()));
			if (name) out.push(name);
		}
	}
	const nameDecl = decls.get("animation-name");
	if (nameDecl && /\binfinite\b/i.test(decls.get("animation-iteration-count") || "")) {
		for (const raw of nameDecl.split(",")) {
			const t = raw.trim();
			if (t && t.toLowerCase() !== "none") out.push(t);
		}
	}
	return out;
}

/** True when the radius renders a dot: 40% or more, a pill value, or at least 40% of the smaller side. */
function isRoundDotRadius(radiusValue: string | null | undefined, w: number, h: number): boolean {
	if (!radiusValue) return false;
	const first = String(radiusValue).trim().split(/\s+/)[0];
	const pct = first.match(/^([\d.]+)%$/);
	if (pct) return parseFloat(pct[1]) >= 40;
	const px = cssLengthToPx(first);
	if (px == null) return false;
	return px >= 999 || px >= 0.4 * Math.min(w, h);
}

/**
 * Remove `@media (prefers-reduced-motion: reduce)` blocks. They describe the
 * accessibility fallback, not the default experience, so an `animation: none`
 * reset inside one must not mask the animation the page plays for everyone else.
 */
function stripReducedMotionBlocks(content: string): string {
	const re = /@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{/gi;
	let out = "";
	let last = 0;
	for (let m = re.exec(content); m !== null; m = re.exec(content)) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < content.length && depth > 0) {
			const ch = content.charCodeAt(i);
			if (ch === 0x7b) depth++;
			else if (ch === 0x7d) depth--;
			i++;
		}
		out += content.slice(last, m.index);
		last = i;
		re.lastIndex = i;
	}
	return out + content.slice(last);
}

/** Source ranges of `<header>` and `<nav>` landmarks, so a string scan can tell page chrome from content. */
function landmarkSourceRanges(content: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const tag of ["header", "nav"]) {
		const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
		const stack: number[] = [];
		for (let m = re.exec(content); m !== null; m = re.exec(content)) {
			if (m[0].charAt(1) === "/") {
				const start = stack.pop();
				if (start != null) ranges.push([start, m.index]);
			} else {
				stack.push(m.index);
			}
		}
	}
	return ranges;
}

function indexInSourceRanges(index: number, ranges: readonly [number, number][]): boolean {
	return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Does any element targeted by the final compound of `selector` appear inside a
 * header/nav landmark? Resolves the last `.class` or `#id` token against class and
 * id attributes; a tag-only compound is not resolvable this way and returns false,
 * because no promotion without placement evidence.
 */
function selectorHitsLandmark(content: string, selector: string, ranges: readonly [number, number][]): boolean {
	if (!ranges || ranges.length === 0) return false;
	const last = selector.split(/[\s>+~]+/).filter(Boolean).pop() || "";
	const idMatch = last.match(/#([A-Za-z_][\w-]*)/);
	const classMatch = last.match(/\.([A-Za-z_][\w-]*)/);
	let attrRe: RegExp | null = null;
	if (idMatch) {
		const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		attrRe = new RegExp(`<[a-zA-Z][^>]*\\bid\\s*=\\s*["']${id}["']`, "gi");
	} else if (classMatch) {
		const cls = classMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		attrRe = new RegExp(`<[a-zA-Z][^>]*\\bclass\\s*=\\s*["'][^"']*(?<![\\w-])${cls}(?![\\w-])[^"']*["']`, "gi");
	}
	if (!attrRe) return false;
	for (let m = attrRe.exec(content); m !== null; m = attrRe.exec(content)) {
		if (indexInSourceRanges(m.index, ranges)) return true;
	}
	return false;
}

/**
 * A small circular indicator bound to an infinite pulse animation: the
 * decorative "live" dot. Gates: 2–16px square-ish, round, and an infinite
 * animation whose keyframes vary opacity/scale/box-shadow, or a pulse/blink/ping
 * name when the keyframes are not in the scanned text. Rotation-only animations
 * never flag.
 *
 * Declarations for one selector merge across rule blocks before the predicate
 * runs, because size in the base rule plus animation in a second block is the
 * construction that ships. A dot inside a header/nav landmark is the hero
 * liveness cliché and is promoted to error severity.
 */
function scanCssTextForPulsingDot(content: string, markup: string = content): ScannedHit[] {
	const customProps = collectCssCustomProps(content);
	const keyframes = collectPulseKeyframes(content);
	const heroRanges = landmarkSourceRanges(markup);
	const findings: ScannedHit[] = [];
	const seen = new Set<string>();

	// Merge declarations per selector across blocks, approximating the cascade:
	// later declarations win. Comma lists split so `.a, .b { … }` reaches both.
	// Comments are stripped first so they neither pollute selector keys nor
	// smuggle a comma into the split.
	const scanText = stripReducedMotionBlocks(content).replace(/\/\*[\s\S]*?\*\//g, " ");
	const merged = new Map<string, Map<string, string>>();
	const ruleRe = new RegExp(CSS_RULE_BLOCK_SOURCE, "g");
	for (let m = ruleRe.exec(scanText); m !== null; m = ruleRe.exec(scanText)) {
		const decls = parseCssDeclBlock(m[2]);
		if (decls.size === 0) continue;
		for (const rawSelector of m[1].split(",")) {
			const selector = rawSelector.trim();
			if (!selector || selector.startsWith("@")) continue;
			let acc = merged.get(selector);
			if (!acc) {
				acc = new Map();
				merged.set(selector, acc);
			}
			for (const [prop, value] of decls) acc.set(prop, value);
		}
	}

	for (const [selector, decls] of merged) {
		const names = infiniteAnimationNames(decls);
		if (names.length === 0) continue;
		const pulseName = names.find((n) => {
			const known = keyframes.get(n);
			if (known != null) return known;
			return /pulse|blink|ping/i.test(n);
		});
		if (!pulseName) continue;

		const w = cssLengthToPx(resolveVarRefs(decls.get("width") || decls.get("inline-size") || "", customProps));
		const h = cssLengthToPx(resolveVarRefs(decls.get("height") || decls.get("block-size") || "", customProps));
		if (w == null || h == null || w < 2 || h < 2 || w > 16 || h > 16) continue;

		const radius = resolveVarRefs(decls.get("border-radius") || "", customProps);
		if (!isRoundDotRadius(radius, w, h)) continue;

		if (seen.has(selector)) continue;
		seen.add(selector);
		const inLandmark = selectorHitsLandmark(markup, selector, heroRanges);
		findings.push({
			id: "pulsing-dot",
			snippet: `${selector} — ${w}x${h}px dot with infinite "${pulseName}" animation${inLandmark ? " in header/nav" : ""}`,
			selector,
			...(inLandmark ? { severity: "error" as const } : {}),
		});
	}

	// Tailwind utilities: animate-ping / animate-pulse on a tiny rounded-full
	// element declared entirely in the class attribute. Scanned in the markup
	// corpus so the match index lines up with the landmark ranges.
	const classRe = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
	for (let cm = classRe.exec(markup); cm !== null; cm = classRe.exec(markup)) {
		const cls = cm[1] || cm[2] || "";
		const anim = cls.match(/\banimate-(ping|pulse)\b/);
		if (!anim) continue;
		if (!/\brounded-full\b/.test(cls)) continue;
		if (!/\b(?:w|h|size)-(?:1|1\.5|2|2\.5|3|3\.5|4)\b/.test(cls)) continue;
		const key = `tw:${cls}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const inLandmark = indexInSourceRanges(cm.index, heroRanges);
		findings.push({
			id: "pulsing-dot",
			snippet: `animate-${anim[1]} on tiny rounded-full element${inLandmark ? " in header/nav" : ""}`,
			...(inLandmark ? { severity: "error" as const } : {}),
		});
	}

	return findings;
}

export {
	collectMarqueeKeyframes,
	collectPulseKeyframes,
	CSS_RULE_BLOCK_SOURCE,
	cssLengthToPx,
	infiniteAnimationNames,
	isRoundDotRadius,
	isZeroOffset,
	landmarkSourceRanges,
	parseCssDeclBlock,
	scanCssTextForInsetStripe,
	scanCssTextForMarquee,
	scanCssTextForPseudoStripe,
	scanCssTextForPulsingDot,
	selectorHitsLandmark,
	stripReducedMotionBlocks,
};
