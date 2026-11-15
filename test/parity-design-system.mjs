/**
 * Parity check: the ported design-system module against the reference implementation.
 *
 * The design file is a token vocabulary, and every check downstream is a comparison
 * against it, so a parsing difference does not surface as a parse error — it surfaces as
 * a wrong finding on a real project months later. These comparisons run the parser, the
 * allowlist comparators, and the source check on the same inputs.
 */
import * as port from "../extensions/designer/engine/detect/design-system.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/design-system.mjs";

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

/** A design system in a comparable shape: sets and maps become sorted arrays. */
function serialize(ds) {
	if (!ds) return null;
	return {
		present: ds.present,
		sourcePath: ds.sourcePath,
		sidecarPath: ds.sidecarPath,
		mdNewerThanJson: ds.mdNewerThanJson,
		allowedFonts: [...ds.allowedFonts].sort(),
		allowedColors: [...ds.allowedColorKeys.keys()].sort(),
		allowedRadii: ds.allowedRadii.map((r) => `${r.name}=${r.value}=${r.px}`),
		allowedFontSizes: ds.allowedFontSizes.map((s) => `${s.value}=${s.px}=${s.fluid}`),
		allowedShadowColors: ds.allowedShadowColors.map((c) => `${c.color.r},${c.color.g},${c.color.b},${c.color.a}`),
		hasPillRadius: ds.hasPillRadius,
		hasFonts: ds.hasFonts,
		hasColors: ds.hasColors,
		hasRadii: ds.hasRadii,
		hasFontSizes: ds.hasFontSizes,
	};
}

const frontmatters = [
	`name: Test\ndescription: A system\ncolors:\n  primary: "#8c2f1e"\n  paper: "#f5efe3"\n  ink: "oklch(0.25 0.02 60)"\n`,
	`colors:\n  a: "rgb(10, 10, 10)"\n  b: "hsl(20, 50%, 40%)"\n  c: "rgba(0,0,0,0.04)"\n`,
	`typography:\n  display:\n    fontFamily: "\\"Fraunces\\", Georgia, serif"\n    fontSize: clamp(2rem, 5vw, 4rem)\n  body:\n    fontFamily: Inter, system-ui, sans-serif\n    fontSize: 1rem\n  scale:\n    sm: 0.875rem\n    lg: 1.5rem\n`,
	`rounded:\n  sm: 4px\n  md: 8px\n  full: 9999px\n`,
	`typography:\n  only:\n    fontFamily: Inter\n    fontSize: clamp(0.5rem, 2vw, 99rem)\n`,
	`name: "Quoted # not a comment"\ncolors:\n  x: "#ffffff" # trailing comment\n`,
	`typography:\n  body:\n    fontFamily: var(--font)\n    fontSize: 1em\n`,
	``,
];

const sidecars = [
	null,
	{ extensions: { colorMeta: { accent: { canonical: "#8c2f1e", tonalRamp: ["#a33", "#722"] } } } },
	{ extensions: { roundedMeta: { full: { canonical: "9999px", role: "pill" }, xl: { values: ["16px", "20px"] } } } },
	{ extensions: { shadows: [{ name: "card", value: "0 1px 2px rgba(0,0,0,0.28), 0 8px 24px rgba(0,0,0,0.55)" }] } },
];

for (const [i, yaml] of frontmatters.entries()) {
	const md = `---\n${yaml}---\n# Title\n`;
	check(`parseFrontmatter(#${i})`, port.parseFrontmatter(md), ref.parseFrontmatter(md));
	for (const [j, sidecar] of sidecars.entries()) {
		const p = port.normalizeDesignSystem({ frontmatter: port.parseFrontmatter(md), sidecar });
		const r = ref.normalizeDesignSystem({ frontmatter: ref.parseFrontmatter(md), sidecar });
		check(`normalizeDesignSystem(#${i}.${j})`, serialize(p), serialize(r));
	}
}

// Comparators, against a design system both sides built from the same file.
const fixtureFrontmatter = ref.parseFrontmatter(
	`---\ncolors:\n  primary: "#8c2f1e"\n  paper: "#f5efe3"\ntypography:\n  body:\n    fontFamily: Inter, sans-serif\n    fontSize: 1rem\n  scale:\n    sm: 0.875rem\n0rounded:\n  sm: 4px\n  full: 9999px\n---\n`,
);
const richerFrontmatter = ref.parseFrontmatter(
	`---\ncolors:\n  primary: "#8c2f1e"\n  paper: "#f5efe3"\ntypography:\n  body:\n    fontFamily: Inter, sans-serif\n    fontSize: 1rem\n  scale:\n    sm: 0.875rem\nrounded:\n  sm: 4px\n  full: 9999px\n---\n`,
);
const portDs = port.normalizeDesignSystem({ frontmatter: richerFrontmatter, sidecar: sidecars[3] });
const refDs = ref.normalizeDesignSystem({ frontmatter: richerFrontmatter, sidecar: sidecars[3] });
check("fixture design system is comparable", serialize(portDs), serialize(refDs));
void fixtureFrontmatter;

for (const font of ["inter", "roboto", "system-ui", "fraunces", "", null]) {
	check(`isAllowedFont(${JSON.stringify(font)})`, port.isAllowedFont(font, portDs), ref.isAllowedFont(font, refDs));
}
for (const color of ["#8c2f1e", "#8C2F1E", "#ffffff", "#8c2f1f", "rgb(140, 47, 30)", "rgba(0,0,0,0.04)", "transparent", "var(--x)", "currentcolor", "not-a-color"]) {
	check(`isAllowedColorRaw(${JSON.stringify(color)})`, port.isAllowedColorRaw(color, portDs), ref.isAllowedColorRaw(color, refDs));
}
for (const color of ["rgba(0,0,0,0.28)", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.3)", "#000", "not-a-color"]) {
	check(`isAllowedShadowColorRaw(${JSON.stringify(color)})`, port.isAllowedShadowColorRaw(color, portDs), ref.isAllowedShadowColorRaw(color, refDs));
}
for (const radius of ["4px", "4.4px", "8px", "0", "50%", "999px", "9999px", "var(--r)", "0.25rem", "auto"]) {
	check(`isAllowedRadiusRaw(${JSON.stringify(radius)})`, port.isAllowedRadiusRaw(radius, portDs), ref.isAllowedRadiusRaw(radius, refDs));
}
for (const size of ["1rem", "14px", "0.875rem", "1.1rem", "clamp(0.875rem, 2vw, 1rem)", "clamp(0.5rem, 2vw, 99rem)", "var(--s)", "1em"]) {
	check(`isAllowedFontSizeRaw(${JSON.stringify(size)})`, port.isAllowedFontSizeRaw(size, portDs), ref.isAllowedFontSizeRaw(size, refDs));
	check(`offRampClampEndpoints(${JSON.stringify(size)})`, port.offRampClampEndpoints(size, portDs), ref.offRampClampEndpoints(size, refDs));
}

const sources = [
	`.card { font-family: Roboto, sans-serif; color: #ff0000; border-radius: 12px; font-size: 1.25rem; }`,
	`.card { font-family: Inter, sans-serif; color: #8c2f1e; border-radius: 4px; font-size: 1rem; }`,
	`// .card { color: #ff0000; }\n/* font-family: Roboto; */`,
	`const s = { fontFamily: "Roboto", color: "#ff0000", borderRadius: "12px", fontSize: "1.25rem" };`,
	`<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400&family=Fraunces">`,
	`.x { box-shadow: 0 8px 24px rgba(0,0,0,0.55); }`,
	`.x { box-shadow: 0 8px 24px rgba(0,0,0,0.9); }`,
	`.y { background: linear-gradient(#ff0000, #8c2f1e); }`,
	`<p>PR #155 and &#8596; are not colors</p>`,
	`.z { border-radius: 8px 12px; font-size: clamp(0.5rem, 2vw, 99rem); }`,
];
for (const [i, content] of sources.entries()) {
	check(
		`checkSourceDesignSystem(#${i})`,
		port.checkSourceDesignSystem(content, "a.css", { designSystem: portDs }),
		ref.checkSourceDesignSystem(content, "a.css", { designSystem: refDs }),
	);
}

const groups = [
	[
		[
			{ antipattern: "design-system-color", snippet: "a", line: 0, ignoreValue: "#ff0000" },
			{ antipattern: "design-system-color", snippet: "b", line: 3, ignoreValue: "#ff0000" },
			{ antipattern: "design-system-font", snippet: "c", line: 1, ignoreValue: "Roboto" },
		],
		[{ antipattern: "design-system-font", snippet: "Google Fonts: Roboto", line: 2, ignoreValue: "Roboto" }],
	],
	[[{ antipattern: "side-tab", snippet: "x", line: 1 }]],
];
for (const [i, group] of groups.entries()) {
	check(`mergeDesignSystemFindings(#${i})`, port.mergeDesignSystemFindings(...group), ref.mergeDesignSystemFindings(...group));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} design-system parity comparisons failed`);
	process.exit(1);
}
console.log(`design-system parity: ${comparisons} comparisons match the reference`);
