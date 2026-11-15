/**
 * Parity check: the TypeScript color helpers against the reference
 * implementation in `reference/impeccable-js/`.
 *
 * This is the oracle for the port. It compares computed output, not asserted
 * output, so a transcription slip in a matrix constant or a regex fails here
 * instead of surfacing as a wrong finding in a review six months from now.
 */
import * as port from "../extensions/designer/engine/core/shared/color.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/shared/color.mjs";

let failures = 0;

function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     port: ${a}\n     ref:  ${e}`);
}

const colors = [
	"rgb(0, 0, 0)", "rgb(255,255,255)", "rgb(10.5, 20, 30.9)", "rgba(10, 20, 30, 0.5)",
	"rgb(10 20 30 / 40%)", "#fff", "#ffff", "#0a141e", "#0a141e80",
	"oklch(0.84 0.19 80.46)", "oklch(21.5% 0.02 50)", "oklch(0.7 0.1 200 / 50%)",
	"oklab(0.6 0.1 -0.1)", "oklab(60% 10% -10% / 0.3)",
	"lch(20 5 60)", "lch(20% 30 60 / 25%)", "lab(50 20 -30)",
	"color(srgb 1.04 0.72 -0.21)", "color(srgb-linear 0.5 0.5 0.5)", "color(display-p3 0.4 0.5 0.6)",
	"color(unknown-space 0.1 0.2 0.3)",
	"hsl(210 50% 40%)", "hsla(210, 50%, 40%, 0.5)", "hsl(210deg 50% 40% / 60%)",
	"hwb(210 20% 30%)", "hwb(210 80% 40%)",
	"color-mix(in oklab, oklch(0.7 0.1 200) 20%, transparent)",
	"color-mix(in srgb, #ff0000 30%, #0000ff)",
	"color-mix(in srgb, red, transparent)",
	"color-mix(in srgb, red 20% 30%, blue)",
	"color-mix(in srgb, var(--x), blue)",
	"rebeccapurple", "transparent", "currentcolor", "inherit", "not-a-color",
	"", "linear-gradient(90deg, oklch(0.3 0.05 20), #112233)",
];

for (const input of colors) {
	check(`parseAnyColor(${JSON.stringify(input)})`, port.parseAnyColor(input), ref.parseAnyColor(input));
	check(`isNeutralColor(${JSON.stringify(input)})`, port.isNeutralColor(input), ref.isNeutralColor(input));
	check(`isNoPaintColorValue(${JSON.stringify(input)})`, port.isNoPaintColorValue(input), ref.isNoPaintColorValue(input));
}

const gradients = [
	"linear-gradient(oklch(0.3 0.05 20), oklch(0.9 0.02 20))",
	"linear-gradient(#fff 0%, #000 100%)",
	"color-mix(in srgb, #ff0000 30%, #0000ff)",
	"radial-gradient(circle, rgba(1,2,3,0.5), rgb(4,5,6))",
	"none",
];
for (const input of gradients) {
	check(`parseGradientColors(${JSON.stringify(input)})`, port.parseGradientColors(input), ref.parseGradientColors(input));
	check(`extractColorFunctionTokens(${JSON.stringify(input)})`, port.extractColorFunctionTokens(input), ref.extractColorFunctionTokens(input));
}

const channels = [
	{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, { r: 10, g: 20, b: 30 }, { r: 200, g: 40, b: 90 },
];
for (const c of channels) {
	check(`relativeLuminance(${JSON.stringify(c)})`, port.relativeLuminance(c), ref.relativeLuminance(c));
	check(`getHue(${JSON.stringify(c)})`, port.getHue(c), ref.getHue(c));
	check(`colorToHex(${JSON.stringify(c)})`, port.colorToHex(c), ref.colorToHex(c));
	check(`hasChroma(${JSON.stringify(c)})`, port.hasChroma(c), ref.hasChroma(c));
	check(`hasChroma(${JSON.stringify(c)}, 10)`, port.hasChroma(c, 10), ref.hasChroma(c, 10));
}
check("contrastRatio(black, white)", port.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), ref.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }));
check("contrastRatio close pair", port.contrastRatio({ r: 120, g: 120, b: 120 }, { r: 130, g: 130, b: 130 }), ref.contrastRatio({ r: 120, g: 120, b: 120 }, { r: 130, g: 130, b: 130 }));

const top = { r: 10, g: 20, b: 30, a: 0.4 };
const base = { r: 200, g: 100, b: 50 };
check("compositeColorOver", port.compositeColorOver(top, base), ref.compositeColorOver(top, base));

const mixes = ["a, b, c", "color-mix(in srgb, red 20%, blue), x", "one"];
for (const input of mixes) {
	check(`splitTopLevelCommas(${JSON.stringify(input)})`, port.splitTopLevelCommas(input), ref.splitTopLevelCommas(input));
}

check("CSS_NAMED_COLORS", port.CSS_NAMED_COLORS, ref.CSS_NAMED_COLORS);

if (failures > 0) {
	console.log(`\n${failures} color parity check(s) failed`);
	process.exit(1);
}
console.log(`color parity: ${colors.length + gradients.length * 2 + channels.length * 5 + mixes.length + 3} comparisons match the reference`);
