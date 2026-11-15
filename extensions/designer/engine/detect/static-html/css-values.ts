/**
 * The value layer of the static CSS engine: tokenizing CSS values, normalizing colors
 * and lengths, and expanding shorthands into longhands. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A file scan has no browser, so it has to compute styles itself. This module is the
 * bottom half of that: everything here turns authored CSS text into the longhand values
 * a cascade can compare. The rule-matching half is `css-cascade.ts`.
 */
import { CSS_NAMED_COLORS, parseAnyColor, type Color } from "../../core/shared/color.ts";
import { resolveVarRefs } from "../../core/checks/css-scan.ts";
import { resolveLengthPx } from "../../core/checks/lengths.ts";

/** `Npx solid <color>`, the border shorthand shape the border-override pass rescues. */
const BORDER_SHORTHAND_RE = /^(\d+(?:\.\d+)?)px\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\s+(.+)$/i;

/**
 * The handful of named colors a `var()` typically holds. The shared parser knows the
 * full table; this exists only so a resolved `var()` value can be normalized before the
 * neutrality check, which understands function forms only.
 */
const NAMED_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
	white: [255, 255, 255],
	black: [0, 0, 0],
	gray: [128, 128, 128],
	grey: [128, 128, 128],
	silver: [192, 192, 192],
	red: [255, 0, 0],
	green: [0, 128, 0],
	blue: [0, 0, 255],
	yellow: [255, 255, 0],
};

/**
 * Normalize a color for the neutrality check: hex and named colors become `rgb()`, and
 * anything unrecognized passes through unchanged, which the check then treats as
 * non-neutral (the safer default).
 */
function normalizeColorForCheck(value: string | null | undefined): string | null | undefined {
	if (!value) return value;
	const v = value.trim();

	const hex6 = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (hex6) {
		const [r, g, b] = [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)];
		return `rgb(${r}, ${g}, ${b})`;
	}
	const hex3 = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
	if (hex3) {
		const [r, g, b] = [parseInt(hex3[1] + hex3[1], 16), parseInt(hex3[2] + hex3[2], 16), parseInt(hex3[3] + hex3[3], 16)];
		return `rgb(${r}, ${g}, ${b})`;
	}
	const named = NAMED_COLORS[v.toLowerCase()];
	if (named) return `rgb(${named[0]}, ${named[1]}, ${named[2]})`;
	return v;
}

/** Properties that inherit, so a child with no declaration reads its parent's value. */
const STATIC_INHERITED_PROPS: ReadonlySet<string> = new Set([
	"color", "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant",
	"lineHeight", "letterSpacing", "textTransform", "textAlign", "hyphens",
	"webkitHyphens",
	// `visibility` inherits in real CSS, and the invisible-at-rest contrast skip relies
	// on descendants of a hidden container computing as hidden. A child that declares
	// `visibility: visible` still overrides it.
	"visibility",
]);

/** The computed style an element starts from. */
const STATIC_DEFAULT_STYLE: Readonly<Record<string, string>> = {
	color: "rgb(0, 0, 0)",
	backgroundColor: "rgba(0, 0, 0, 0)",
	backgroundImage: "none",
	borderTopWidth: "0px",
	borderRightWidth: "0px",
	borderBottomWidth: "0px",
	borderLeftWidth: "0px",
	borderTopColor: "rgb(0, 0, 0)",
	borderRightColor: "rgb(0, 0, 0)",
	borderBottomColor: "rgb(0, 0, 0)",
	borderLeftColor: "rgb(0, 0, 0)",
	borderRadius: "0px",
	outlineWidth: "0px",
	outlineColor: "rgb(0, 0, 0)",
	outlineStyle: "none",
	boxShadow: "none",
	// NOT inherited even though text-shadow is in real CSS: the glow check only needs to
	// fire once, on the element that declares the shadow.
	textShadow: "none",
	fontFamily: "",
	fontSize: "16px",
	fontStyle: "normal",
	fontVariant: "normal",
	fontWeight: "400",
	lineHeight: "normal",
	letterSpacing: "normal",
	textTransform: "none",
	textAlign: "start",
	hyphens: "manual",
	webkitHyphens: "manual",
	transitionProperty: "",
	transitionTimingFunction: "",
	animationName: "",
	animationTimingFunction: "",
	webkitBackgroundClip: "",
	backgroundClip: "",
	width: "",
	height: "",
	paddingTop: "0px",
	paddingRight: "0px",
	paddingBottom: "0px",
	paddingLeft: "0px",
	marginTop: "0px",
	marginRight: "0px",
	marginBottom: "0px",
	marginLeft: "0px",
	position: "static",
	visibility: "visible",
	contentVisibility: "visible",
	opacity: "1",
	top: "auto",
	right: "auto",
	bottom: "auto",
	left: "auto",
	inset: "",
	display: "",
	overflow: "visible",
	overflowX: "visible",
	overflowY: "visible",
};

/** CSS property name to the camelCase key the checks read. */
const STATIC_PROP_MAP: Readonly<Record<string, string>> = {
	"background-color": "backgroundColor",
	"background-image": "backgroundImage",
	"background-clip": "backgroundClip",
	"-webkit-background-clip": "webkitBackgroundClip",
	"border-radius": "borderRadius",
	"border-top-width": "borderTopWidth",
	"border-right-width": "borderRightWidth",
	"border-bottom-width": "borderBottomWidth",
	"border-left-width": "borderLeftWidth",
	"border-top-color": "borderTopColor",
	"border-right-color": "borderRightColor",
	"border-bottom-color": "borderBottomColor",
	"border-left-color": "borderLeftColor",
	"outline-width": "outlineWidth",
	"outline-color": "outlineColor",
	"outline-style": "outlineStyle",
	"box-shadow": "boxShadow",
	"text-shadow": "textShadow",
	"font-family": "fontFamily",
	"font-size": "fontSize",
	"font-style": "fontStyle",
	"font-weight": "fontWeight",
	"line-height": "lineHeight",
	"letter-spacing": "letterSpacing",
	"text-transform": "textTransform",
	"text-align": "textAlign",
	hyphens: "hyphens",
	"-webkit-hyphens": "webkitHyphens",
	"transition-property": "transitionProperty",
	"transition-timing-function": "transitionTimingFunction",
	"animation-name": "animationName",
	"animation-timing-function": "animationTimingFunction",
	width: "width",
	height: "height",
	"padding-top": "paddingTop",
	"padding-right": "paddingRight",
	"padding-bottom": "paddingBottom",
	"padding-left": "paddingLeft",
	"margin-top": "marginTop",
	"margin-right": "marginRight",
	"margin-bottom": "marginBottom",
	"margin-left": "marginLeft",
	position: "position",
	visibility: "visibility",
	opacity: "opacity",
	top: "top",
	right: "right",
	bottom: "bottom",
	left: "left",
	inset: "inset",
	display: "display",
	overflow: "overflow",
	"overflow-x": "overflowX",
	"overflow-y": "overflowY",
};

/**
 * The keywords the shared parser deliberately returns null for. The cascade needs
 * `transparent` to read as a real zero-alpha color.
 */
const STATIC_NAMED_COLORS: Readonly<Record<string, Color>> = {
	transparent: { r: 0, g: 0, b: 0, a: 0 },
};

// Named-color alternation for plucking a color token out of a shorthand. Derived from the
// table the parser resolves against, so extraction and parsing cannot drift apart, and
// longest-first so a name containing another as a substring (rebeccapurple) matches whole.
const NAMED_COLOR_TOKENS = [...Object.keys(CSS_NAMED_COLORS), ...Object.keys(STATIC_NAMED_COLORS)]
	.sort((a, b) => b.length - a.length)
	.join("|");

const STATIC_COLOR_TOKEN_RE = new RegExp(
	`(?:rgba?\\([^)]+\\)|oklch\\([^)]+\\)|oklab\\([^)]+\\)|lch\\([^)]+\\)|lab\\([^)]+\\)|hsla?\\([^)]+\\)|hwb\\([^)]+\\)|#[0-9a-f]{3,8}\\b|\\b(?:${NAMED_COLOR_TOKENS})\\b)`,
	"i",
);

/** Split a comma-separated CSS list, respecting parentheses, brackets, and quotes. */
function splitCssList(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === quote && value[i - 1] !== "\\") quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		else if (ch === "," && depth === 0) {
			parts.push(value.slice(start, i).trim());
			start = i + 1;
		}
	}
	const tail = value.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

/** Split a CSS value into whitespace-separated tokens, respecting parentheses and quotes. */
function splitCssTokens(value: string): string[] {
	const tokens: string[] = [];
	let depth = 0;
	let quote = "";
	let current = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			current += ch;
			if (ch === quote && value[i - 1] !== "\\") quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "(") {
			depth++;
			current += ch;
			continue;
		}
		if (ch === ")") {
			depth = Math.max(0, depth - 1);
			current += ch;
			continue;
		}
		if (/\s/.test(ch) && depth === 0) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** A CSS property name as the camelCase key the checks read. */
function cssPropToCamel(prop: string): string {
	if (!prop) return prop;
	const mapped = STATIC_PROP_MAP[prop];
	if (mapped) return mapped;
	return prop.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
}

/** A color as a CSS string, keeping alpha only when it is not fully opaque. */
function staticColorToCss(c: Color | null | undefined): string {
	if (!c) return "";
	if (c.a != null && c.a < 1) return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
	return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

/** Parse a color, including the `transparent` keyword the shared parser declines. */
function parseStaticColor(value: string | null | undefined): Color | null {
	const parsed = parseAnyColor(value);
	if (parsed) return parsed;
	const named = STATIC_NAMED_COLORS[String(value || "").trim().toLowerCase()];
	return named ? { ...named } : null;
}

/**
 * The color token inside a shorthand value. `color-mix()` needs balanced-paren capture:
 * its arguments regularly contain nested `var()`/`oklch()` calls AND the keyword
 * `transparent`, which a flat regex would pluck out of the middle of the expression.
 */
function extractStaticColor(value: string | null | undefined): string {
	if (!value) return "";
	const raw = String(value).trim();
	if (/^var\(/i.test(raw)) return raw;

	const mixStart = raw.search(/color-mix\(/i);
	if (mixStart !== -1) {
		let depth = 0;
		for (let i = raw.indexOf("(", mixStart); i < raw.length; i++) {
			if (raw[i] === "(") depth++;
			else if (raw[i] === ")") {
				depth--;
				if (depth === 0) return raw.slice(mixStart, i + 1);
			}
		}
		return "";
	}

	const colorLike = raw.match(STATIC_COLOR_TOKEN_RE);
	return colorLike ? colorLike[0] : "";
}

/**
 * Normalize one declared value into the form the checks read: `var()` resolved, colors as
 * `rgb()`/`rgba()`, and the relative lengths (`fontSize`, `letterSpacing`, `lineHeight`)
 * converted to pixels, since a file scan cannot ask a browser for the used value.
 */
function normalizeStaticCssValue(
	prop: string,
	value: string | null | undefined,
	customProps: Map<string, string> | null | undefined,
	parentStyle: Record<string, string> | null | undefined,
	currentStyle: Record<string, string> | null = null,
): string {
	let resolved = resolveVarRefs(String(value || "").trim(), customProps);

	if (resolved === "inherit") return parentStyle?.[prop] || STATIC_DEFAULT_STYLE[prop] || "";

	// A modern color function in a border color is kept verbatim: the border checks
	// understand those spaces, and normalizing them here would lose gamut information.
	const isModernBorderColor = /^border[A-Z][a-z]+Color$/.test(prop) && /^(?:oklch|oklab|lch|lab|hsl|hwb)\(/i.test(resolved);
	if (!isModernBorderColor && (/color$/i.test(prop) || prop === "color" || prop === "backgroundColor")) {
		const parsed = parseStaticColor(resolved);
		if (parsed) resolved = staticColorToCss(parsed);
	}

	if (prop === "fontSize") {
		const base = parseFloat(parentStyle?.fontSize ?? "") || 16;
		const px = resolveLengthPx(resolved, base);
		if (px != null) resolved = `${px}px`;
	}
	if (prop === "letterSpacing") {
		const base = parseFloat(currentStyle?.fontSize || parentStyle?.fontSize || "") || 16;
		const px = resolveLengthPx(resolved, base);
		if (px != null) resolved = `${px}px`;
	}
	if (prop === "lineHeight" && resolved !== "normal") {
		const base = parseFloat(currentStyle?.fontSize || parentStyle?.fontSize || "") || 16;
		const px = resolveLengthPx(resolved, base);
		if (px != null) resolved = `${px}px`;
	}

	return resolved;
}

/** A 1–4 value box shorthand as top, right, bottom, left. */
function expandStaticBoxValues(tokens: readonly string[]): [string, string, string, string] {
	if (tokens.length === 0) return ["0px", "0px", "0px", "0px"];
	if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
	if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
	if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
	return [tokens[0], tokens[1], tokens[2], tokens[3]];
}

/** The width and color a border shorthand declares. */
function parseStaticBorder(value: string): { width: string; color: string } {
	let width = "";
	let color = "";
	for (const token of splitCssTokens(value)) {
		if (!width && /^-?[\d.]+(?:px|rem|em|%)$/.test(token)) width = token;
		if (!color) color = extractStaticColor(token);
	}
	return { width, color };
}

/** The declarations a `font` shorthand implies. */
function parseStaticFont(value: string): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const slashParts = value.match(/(?:^|\s)([\d.]+(?:px|rem|em|%))(?:\/([^\s]+))?/);
	if (/\bitalic\b/i.test(value)) out.push(["fontStyle", "italic"]);
	const weight = value.match(/\b([1-9]00|bold|normal|lighter|bolder)\b/i);
	if (weight) out.push(["fontWeight", weight[1]]);
	if (slashParts) {
		out.push(["fontSize", slashParts[1]]);
		if (slashParts[2]) out.push(["lineHeight", slashParts[2]]);
		const familyStart = value.indexOf(slashParts[0]) + slashParts[0].length;
		const family = value.slice(familyStart).trim();
		if (family) out.push(["fontFamily", family]);
	}
	return out;
}

/** The properties and timing functions a `transition` shorthand declares. */
function parseStaticTransition(value: string): { property: string; timing: string } {
	const props: string[] = [];
	const timings: string[] = [];
	for (const item of splitCssList(value)) {
		const tokens = splitCssTokens(item);
		const timing = tokens.find((token) => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
		if (timing) timings.push(timing);
		const prop = tokens.find(
			(token) =>
				/^[a-z-]+$/i.test(token) &&
				!/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none)$/.test(token) &&
				!/s$/.test(token),
		);
		if (prop) props.push(prop);
	}
	return { property: props.join(", "), timing: timings.join(", ") };
}

/** The names and timing functions an `animation` shorthand declares. */
function parseStaticAnimation(value: string): { name: string; timing: string } {
	const names: string[] = [];
	const timings: string[] = [];
	for (const item of splitCssList(value)) {
		const tokens = splitCssTokens(item);
		const timing = tokens.find((token) => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
		if (timing) timings.push(timing);
		const name = tokens.find(
			(token) =>
				/^[a-z_-][\w-]*$/i.test(token) &&
				!/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none|running|paused)$/.test(token),
		);
		if (name) names.push(name);
	}
	return { name: names.join(", "), timing: timings.join(", ") };
}

/**
 * Strip `@layer NAME { … }` wrappers, leaving the inner rules as flat CSS.
 *
 * A parser that does not implement `@layer` leaves every rule inside one invisible, and
 * modern utility frameworks put *every* utility in `@layer utilities`: without
 * unwrapping, every element styled by one computes an empty style. Braces are balanced
 * by hand so nested style rules inside the layer block survive intact.
 */
function unwrapCssAtLayer(source: string): string {
	if (!source || !source.includes("@layer")) return source;

	const re = /@layer\b[^{;]*\{/g;
	let out = "";
	let lastIdx = 0;

	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		const openStart = m.index;
		const openEnd = m.index + m[0].length; // position right after `{`
		let depth = 1;
		let i = openEnd;
		while (i < source.length && depth > 0) {
			const c = source.charCodeAt(i);
			if (c === 0x7b) depth++;
			else if (c === 0x7d) depth--;
			i++;
		}
		if (depth !== 0) return source; // unbalanced: leave the source alone

		out += source.slice(lastIdx, openStart);
		out += source.slice(openEnd, i - 1); // i-1 is the matched closing brace
		lastIdx = i;
		re.lastIndex = i;
	}
	out += source.slice(lastIdx);
	return out;
}

export {
	BORDER_SHORTHAND_RE,
	cssPropToCamel,
	expandStaticBoxValues,
	extractStaticColor,
	NAMED_COLORS,
	normalizeColorForCheck,
	normalizeStaticCssValue,
	parseStaticAnimation,
	parseStaticBorder,
	parseStaticColor,
	parseStaticFont,
	parseStaticTransition,
	splitCssList,
	splitCssTokens,
	STATIC_COLOR_TOKEN_RE,
	STATIC_DEFAULT_STYLE,
	STATIC_INHERITED_PROPS,
	STATIC_NAMED_COLORS,
	STATIC_PROP_MAP,
	staticColorToCss,
	unwrapCssAtLayer,
};
