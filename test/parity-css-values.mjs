/**
 * Parity check: the static CSS engine's value layer against the reference.
 *
 * A file scan has no browser, so this layer decides what every downstream rule sees:
 * a shorthand expanded wrong, or a color normalized differently, changes findings without
 * ever throwing. These comparisons run both implementations over the same values.
 */
import * as port from "../extensions/designer/engine/detect/static-html/css-values.ts";
import * as cascade from "../extensions/designer/engine/detect/static-html/css-cascade.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/engines/static-html/css-cascade.mjs";

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     port: ${a}\n     ref:  ${e}`);
}

for (const value of ["#fff", "#ffffff", "#FFFFFF80", "white", "black", "rebeccapurple", "rgb(1,2,3)", "var(--x)", "", null]) {
	check(`normalizeColorForCheck(${JSON.stringify(value)})`, port.normalizeColorForCheck(value), ref.normalizeColorForCheck(value));
}

for (const value of [
	"a, b, c",
	"rgb(1, 2, 3), url(a.png)",
	"linear-gradient(to right, #fff 1px, transparent 1px)",
	'"a,b", c',
	"one",
	"",
]) {
	check(`splitCssList(${JSON.stringify(value)})`, port.splitCssList(value), ref.splitCssList(value));
}

for (const value of [
	"1px solid red",
	"  rgb(1, 2, 3)  0 0  24px ",
	"inset 4px 0 #c81414",
	"url(a.png) center / cover",
	"",
]) {
	check(`splitCssTokens(${JSON.stringify(value)})`, port.splitCssTokens(value), ref.splitCssTokens(value));
}

for (const prop of ["background-color", "border-top-width", "-webkit-background-clip", "font-size", "custom-prop", "", "inset"]) {
	check(`cssPropToCamel(${prop})`, port.cssPropToCamel(prop), ref.cssPropToCamel(prop));
}

for (const color of [{ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 0.4 }, null]) {
	check(`staticColorToCss(${JSON.stringify(color)})`, port.staticColorToCss(color), ref.staticColorToCss(color));
}

for (const value of ["transparent", "#fff", "oklch(0.5 0.1 200)", "not-a-color", ""]) {
	check(`parseStaticColor(${JSON.stringify(value)})`, port.parseStaticColor(value), ref.parseStaticColor(value));
}

for (const value of [
	"1px solid #c81414",
	"1px solid rgb(200, 20, 20)",
	"2px dashed purple",
	"2px dashed rebeccapurple",
	"1px solid rgba(0,0,0,0.2)",
	"color-mix(in oklab, transparent 20%, #fff)",
	"var(--brand)",
	"",
]) {
	check(`extractStaticColor(${JSON.stringify(value)})`, port.extractStaticColor(value), ref.extractStaticColor(value));
}

const tokenMap = new Map([["--brand", "#8c2f1e"], ["--size", "1.5rem"]]);
for (const [prop, value] of [
	["color", "var(--brand)"],
	["backgroundColor", "transparent"],
	["borderTopWidth", "1.5rem"],
	["fontSize", "1.5rem"],
	["fontSize", "2em"],
	["letterSpacing", "0.05em"],
	["lineHeight", "1.5"],
	["lineHeight", "normal"],
	["color", "inherit"],
	["display", "var(--size)"],
	["borderLeftColor", "oklch(0.6 0.2 250)"],
]) {
	check(
		`normalizeStaticCssValue(${prop}, ${value})`,
		port.normalizeStaticCssValue(prop, value, tokenMap, { fontSize: "16px", color: "rgb(9, 9, 9)" }, { fontSize: "20px" }),
		ref.normalizeStaticCssValue(prop, value, tokenMap, { fontSize: "16px", color: "rgb(9, 9, 9)" }, { fontSize: "20px" }),
	);
}

for (const tokens of [[], ["1px"], ["1px", "2px"], ["1px", "2px", "3px"], ["1px", "2px", "3px", "4px"]]) {
	check(`expandStaticBoxValues(${JSON.stringify(tokens)})`, port.expandStaticBoxValues(tokens), ref.expandStaticBoxValues(tokens));
}

for (const value of ["1px solid red", "2px dashed #0f0", "1px", "0.5rem solid rgb(1,2,3)", ""]) {
	check(`parseStaticBorder(${JSON.stringify(value)})`, port.parseStaticBorder(value), ref.parseStaticBorder(value));
}

for (const value of [
	"italic 700 16px/1.5 Inter, sans-serif",
	"16px Inter",
	"bold 2rem/1.2 'Playfair Display', serif",
	"inherit",
	"",
]) {
	check(`parseStaticFont(${JSON.stringify(value)})`, port.parseStaticFont(value), ref.parseStaticFont(value));
}

for (const value of [
	"width 200ms ease",
	"opacity 150ms ease-in-out, transform 200ms",
	"all 200ms cubic-bezier(0.4, 0, 0.2, 1)",
	"none",
	"",
]) {
	check(`parseStaticTransition(${JSON.stringify(value)})`, port.parseStaticTransition(value), ref.parseStaticTransition(value));
}

for (const value of ["bounce 1s infinite", "spin 2s linear infinite, fade 1s ease", "none", ""]) {
	check(`parseStaticAnimation(${JSON.stringify(value)})`, port.parseStaticAnimation(value), ref.parseStaticAnimation(value));
}

for (const source of [
	"",
	".a { color: red }",
	"@layer utilities { .a { color: red } .b { padding: 0 } }",
	"@layer base, utilities;",
	"@layer a { @layer b { .x { color: red } } }",
	"@layer broken { .a { color: red }",
	"@media (min-width: 40rem) { .a { color: red } }",
]) {
	check(`unwrapCssAtLayer(${JSON.stringify(source.slice(0, 30))})`, port.unwrapCssAtLayer(source), ref.unwrapCssAtLayer(source));
}

check("STATIC_INHERITED_PROPS", [...port.STATIC_INHERITED_PROPS].sort(), [...ref.STATIC_INHERITED_PROPS].sort());
check("STATIC_DEFAULT_STYLE", port.STATIC_DEFAULT_STYLE, ref.STATIC_DEFAULT_STYLE);
check("STATIC_PROP_MAP", port.STATIC_PROP_MAP, ref.STATIC_PROP_MAP);
check("STATIC_NAMED_COLORS", port.STATIC_NAMED_COLORS, ref.STATIC_NAMED_COLORS);
check("NAMED_COLORS", port.NAMED_COLORS, ref.NAMED_COLORS);

// ─── Cascade weight and declaration expansion ─────────────────

for (const selector of [
	"div",
	".card",
	"#main",
	".a .b",
	".a > .b",
	"a:hover",
	"a:focus-visible",
	":where(.a) .b",
	"ul li:first-child",
	"[data-x=\"1\"]",
	"*",
	"h1, h2",
	".a.b.c",
	"input[type=text]::placeholder",
]) {
	check(`staticSpecificity(${selector})`, cascade.staticSpecificity(selector), ref.staticSpecificity(selector));
}

for (const [prop, value] of [
	["background", "#fff"],
	["background", "url(a.png) center / cover"],
	["background", "none"],
	["background", "linear-gradient(red, blue)"],
	["background", "var(--surface)"],
	["border", "1px solid #c81414"],
	["border", "2px dashed rebeccapurple"],
	["border-left", "4px solid red"],
	["border-width", "1px 2px"],
	["border-color", "red rgb(1,2,3) #fff #000"],
	["padding", "4px 8px 12px 16px"],
	["margin", "0 auto"],
	["outline", "2px solid #0af"],
	["outline", "0"],
	["font", "italic 700 16px/1.5 Inter, sans-serif"],
	["transition", "width 200ms ease"],
	["animation", "bounce 1s infinite"],
	["color", "#8c2f1e"],
	["--brand", "#8c2f1e"],
	["unknown-property", "x"],
	["display", "flex"],
]) {
	check(`expandStaticDeclaration(${prop}: ${value})`, cascade.expandStaticDeclaration(prop, value), ref.expandStaticDeclaration(prop, value));
}

for (const [a, b] of [
	[null, { important: false, specificity: [0, 1, 0], order: 1, inline: false }],
	[{ important: false, specificity: [0, 1, 0], order: 1, inline: false }, { important: true, specificity: [0, 0, 1], order: 0, inline: false }],
	[{ important: true, specificity: [1, 0, 0], order: 1, inline: false }, { important: true, specificity: [1, 0, 0], order: 1, inline: true }],
	[{ important: false, specificity: [0, 1, 0], order: 5, inline: false }, { important: false, specificity: [0, 2, 0], order: 1, inline: false }],
	[{ important: false, specificity: [0, 1, 0], order: 5, inline: false }, { important: false, specificity: [0, 1, 0], order: 4, inline: false }],
	[{ important: false, specificity: [0, 1, 0], order: 5, inline: false }, { important: false, specificity: [0, 1, 0], order: 6, inline: false }],
]) {
	check(`compareStaticPriority(${JSON.stringify(a)}, ${JSON.stringify(b)})`, cascade.compareStaticPriority(a, b), ref.compareStaticPriority(a, b));
}

for (const styleText of ["color: red", "color: red !important; padding: 4px", ";;color:red;;", "", "nope", "background: url(data:image/png;base64,AAA)"]) {
	check(`parseStaticStyleAttribute(${JSON.stringify(styleText)})`, cascade.parseStaticStyleAttribute(styleText), ref.parseStaticStyleAttribute(styleText));
	check(`parseStaticStyleAttribute(${JSON.stringify(styleText)}, 7)`, cascade.parseStaticStyleAttribute(styleText, 7), ref.parseStaticStyleAttribute(styleText, 7));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} css-value parity comparisons failed`);
	process.exit(1);
}
console.log(`css-value parity: ${comparisons} comparisons match the reference`);
