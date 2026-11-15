/**
 * Parity check: font matching's decisions against the reference.
 *
 * Three things here can go wrong quietly: the width and weight classes (a moved threshold changes
 * what the report says about a comp), the candidate list (which faces a rank even tries), and the
 * choice stamp (the only thing telling a measured choice from a hand-typed one). The browser
 * rendering upstream does is a host surface, so it is not compared.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/font-match.ts");
const ref = await import("../reference/impeccable-js/scripts/font-match.mjs");

const portIndex = await import("../extensions/designer/engine/lib/font-index.ts");
const refIndex = await import("../reference/impeccable-js/scripts/lib/font-index.mjs");

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

// ─── width ──────────────────────────────────────────────────────────
for (const value of [null, undefined, {}]) {
	check(`widthMeasure(${JSON.stringify(value)})`, port.widthMeasure(value), ref.widthMeasure(value));
}
check("widthMeasure(advX)", port.widthMeasure({ advX: 0.5 }), ref.widthMeasure({ advX: 0.5 }));
check("widthMeasure(falls back to advTall)", port.widthMeasure({ advTall: 0.5 }), ref.widthMeasure({ advTall: 0.5 }));
check("widthMeasure(falls back to advance)", port.widthMeasure({ advance: 0.5 }), ref.widthMeasure({ advance: 0.5 }));
check("widthMeasure(mixed case prefers advX)", port.widthMeasure({ advX: 0.5, advTall: 0.8, advance: 0.6 }), ref.widthMeasure({ advX: 0.5, advTall: 0.8, advance: 0.6 }));

for (const fp of [
	{ advX: 0.3 }, { advX: 0.41 }, { advX: 0.42 }, { advX: 0.55 }, { advX: 0.584 }, { advX: 0.585 }, { advX: 0.7 }, { advX: 0.72 }, { advX: 0.9 },
	{ advTall: 0.44 }, { advTall: 0.45 }, { advTall: 0.6 }, { advTall: 0.61 }, { advTall: 0.79 },
	{ advance: 0.5 }, {}, null, 0.5, 0.3, 0.8,
]) {
	check(`widthClass(${JSON.stringify(fp)})`, port.widthClass(fp), ref.widthClass(fp));
}

// ─── weight ─────────────────────────────────────────────────────────
check("weightMeasure(densTall)", port.weightMeasure({ densTall: 0.4 }), ref.weightMeasure({ densTall: 0.4 }));
check("weightMeasure(densX)", port.weightMeasure({ densX: 0.4 }), ref.weightMeasure({ densX: 0.4 }));
check("weightMeasure(stemW)", port.weightMeasure({ stemW: 0.14 }), ref.weightMeasure({ stemW: 0.14 }));
check("weightMeasure(weight)", port.weightMeasure({ weight: 0.44 }), ref.weightMeasure({ weight: 0.44 }));
check("weightMeasure(null)", port.weightMeasure(null), ref.weightMeasure(null));

for (const fp of [
	{ densTall: 0.2 }, { densTall: 0.33 }, { densTall: 0.34 }, { densTall: 0.47 }, { densTall: 0.48 }, { densTall: 0.55 }, { densTall: 0.56 }, { densTall: 0.65 }, { densTall: 0.66 }, { densTall: 0.9 },
	{ stemW: 0.1 }, { stemW: 0.105 }, { stemW: 0.16 }, { stemW: 0.19 }, { stemW: 0.24 }, { stemW: 0.5 },
	{}, null, 0.4, 0.7,
]) {
	check(`weightClass(${JSON.stringify(fp)})`, port.weightClass(fp), ref.weightClass(fp));
}

// ─── shortlist and variants ─────────────────────────────────────────
check("SHORTLIST", port.SHORTLIST, ref.SHORTLIST);
for (const list of [[], ["Inter:700"], ["Inter:700", "Inter:100", "Anton:400"], ["Anton:900"], ["NoWeight"], ["A:200", "B:800"], ["Inter:700", "Inter:700"]]) {
	check(`withWeightVariants(${JSON.stringify(list)})`, port.withWeightVariants(list), ref.withWeightVariants(list));
}

// ─── candidate parsing and selection ────────────────────────────────
// `parseCandidates` is module-private upstream, so it is compared through `selectCandidates`,
// which is the only caller and is exported.

const index = null;

// Selection without an index uses the shortlist, which is the only path a missing catalog takes.
for (const fp of [{ advX: 0.3 }, { advX: 0.55 }, { advX: 0.65 }, { advX: 0.9 }, {}, null]) {
	check(`selectCandidates(shortlist, ${JSON.stringify(fp)})`, port.selectCandidates(fp, { own: [{ family: "Custom", weight: 500 }] }), ref.selectCandidates(fp, { own: [{ family: "Custom", weight: 500 }] }));
}

// Selection with a synthetic index: a real file, read by both loaders.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-font-match-"));
const indexFile = path.join(dir, "font-index.json");
try {
	const fp = { advX: 0.5, advTall: 0.5, advance: 0.5, stemW: 0.1, densTall: 0.4, densX: 0.35, gap: 0.08, xRatio: 0.5, contrast: 2, roundFrac: 0.3, advCV: 0.3, descRatio: 0.2, runDensity: 2, serif: 1 };
	const vector = portIndex.packVector({ ...fp, advX: 0.52 });
	fs.writeFileSync(
		indexFile,
		JSON.stringify({
			schema: 1,
			text: "Hamburgefonstiv",
			sizes: [48, 14],
			features: portIndex.INDEX_FEATURES,
			categories: ["sans", "serif"],
			entries: [
				["Inter", 400, 0, 0, vector, vector],
				["Fraunces", 400, 1, 0, vector, vector],
				["Inter", 700, 0, 0, vector, vector],
			],
		}),
	);

	const indexPort = portIndex.loadFontIndex(indexFile);
	const indexRef = refIndex.loadFontIndex(indexFile);
	for (const options of [{}, { n: 1 }, { category: "serif" }, { own: [{ family: "Own", weight: 300 }] }]) {
		check(
			`selectCandidates(index, ${JSON.stringify(options)})`,
			port.selectCandidates({ ...fp, capHeightPx: 48 }, { own: options.own ?? [], index: indexPort, n: options.n ?? 25, category: options.category ?? null }),
			ref.selectCandidates({ ...fp, capHeightPx: 48 }, { own: options.own ?? [], index: indexRef, n: options.n ?? 25, category: options.category ?? null }),
		);
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ─── the choice stamp ───────────────────────────────────────────────
const chosen = { family: "Inter", weight: 700, fontSizePx: 32, source: "measured" };
check("stampChoice", port.stampChoice("hero-headline", chosen), ref.stampChoice("hero-headline", chosen));
check("stampChoice(different region)", port.stampChoice("body", chosen), ref.stampChoice("body", chosen));

const stamped = port.stampChoice("hero-headline", chosen);
check("choiceStamped(valid)", port.choiceStamped("hero-headline", stamped), ref.choiceStamped("hero-headline", ref.stampChoice("hero-headline", chosen)));
check("choiceStamped(wrong region)", port.choiceStamped("body", stamped), false);
check("choiceStamped(no stamp)", port.choiceStamped("hero-headline", chosen), false);
check("choiceStamped(null)", port.choiceStamped("hero-headline", null), false);
check(
	"choiceStamped(hand-typed is rejected)",
	port.choiceStamped("hero-headline", { family: "Arial Narrow", weight: 400, fontSizePx: 30, source: "system-fallback" }),
	false,
);
check(
	"choiceStamped(tampered family is rejected)",
	port.choiceStamped("hero-headline", { ...stamped, family: "Arial Narrow" }),
	false,
);

// ─── report helpers ─────────────────────────────────────────────────
const sampleFp = {
	capHeightPx: 48, glyphs: 12, lines: 1, inkIsDark: true, allCaps: false, gap: 0.08,
	advX: 0.5, advTall: 0.55, advance: 0.52, densTall: 0.42, densX: 0.4, stemW: 0.12,
	contrast: 1.9, serif: 1.0, roundFrac: 0.2, xRatio: 0.5, descRatio: 0.2, runDensity: 2.1, weight: 0.42,
	vprof0: 0.01, hrun25: 0.02, colq25: 0.03,
};
// `describe` and `compactFp` are module-private upstream (used by the CLI's report), so the
// report string is reconstructed from the exported class helpers it is built out of.
const describeFromParts = (fp) => {
	const wm = ref.widthMeasure(fp);
	const wt = ref.weightMeasure(fp);
	return `capHeight ${fp.capHeightPx}px, width ${ref.widthClass(fp)}${wm ? ` (${wm.key} ${wm.value})` : ""}, weight ${ref.weightClass(fp)}${wt ? ` (${wt.key} ${wt.value})` : ""}, tracking ${fp.gap}${fp.allCaps ? ", all caps" : ""}`;
};
check("describe(mixed)", port.describe(sampleFp), describeFromParts(sampleFp));
check("describe(all caps)", port.describe({ ...sampleFp, allCaps: true }), describeFromParts({ ...sampleFp, allCaps: true }));
check("describe(sparse)", port.describe({ capHeightPx: 14 }), describeFromParts({ capHeightPx: 14 }));

// The compact form keeps only the class-bearing fields; asserted against the documented list.
check(
	"compactFp",
	Object.keys(port.compactFp(sampleFp)).sort(),
	["advX", "advTall", "advance", "allCaps", "capHeightPx", "contrast", "densTall", "densX", "gap", "glyphs", "inkIsDark", "lines", "serif", "stemW", "weight", "xRatio"].sort(),
);
check("compactFp(null)", port.compactFp(null), null);

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} font-match comparisons failed`);
	process.exit(1);
}
console.log(`font-match parity: ${comparisons} comparisons match the reference`);
