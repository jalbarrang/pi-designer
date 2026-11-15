/**
 * Parity check: the font index against the reference.
 *
 * The index is a packed representation of 3,000 faces, so the two things worth comparing are the
 * packing (a change there silently re-reads every stored vector) and the candidate generator
 * (routing by cap height, the category filter, the per-family spread, and the non-lettering
 * exclusion). A synthetic index keeps the test fast and lets each branch be aimed at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/font-index.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/font-index.mjs");

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

// ─── constants and predicates ───────────────────────────────────────
check("INDEX_SIZES", port.INDEX_SIZES, ref.INDEX_SIZES);
check("ROUTE_CAP_PX", port.ROUTE_CAP_PX, ref.ROUTE_CAP_PX);
check("MIN_RANK_CAP_PX", port.MIN_RANK_CAP_PX, ref.MIN_RANK_CAP_PX);
check("CATEGORIES", port.CATEGORIES, ref.CATEGORIES);
check("GROSS_FEATURES", port.GROSS_FEATURES, ref.GROSS_FEATURES);
check("INDEX_FEATURES", port.INDEX_FEATURES, ref.INDEX_FEATURES);

for (const family of ["Inter", "Rubik Doodle", "Flow Block", "Redacted Script", "Barcode 39", "Inter Tight", "Zen Dots", "Fraunces"]) {
	check(`NON_TEXT_FAMILY(${family})`, port.NON_TEXT_FAMILY.test(family), ref.NON_TEXT_FAMILY.test(family));
}

// ─── packing ────────────────────────────────────────────────────────
const vectorCases = [
	{ advX: 0.42, stemW: 0.09, contrast: 1.8, xRatio: null, gap: 0, roundFrac: 46.7, advCV: -0.5 },
	{ advX: 1, advTall: 0.5 },
	{},
	{ advX: Number.NaN, stemW: Number.POSITIVE_INFINITY },
	{ advX: 0.123456, stemW: 0.0004 },
];
for (const [i, vector] of vectorCases.entries()) {
	const packedPort = port.packVector(vector);
	const packedRef = ref.packVector(vector);
	check(`packVector(#${i})`, packedPort, packedRef);
	check(`unpackVector(#${i})`, port.unpackVector(packedPort), ref.unpackVector(packedRef));
}
check("packVector(custom features)", port.packVector({ advX: 0.5, gap: 0.25 }, ["gap", "advX"]), ref.packVector({ advX: 0.5, gap: 0.25 }, ["gap", "advX"]));

// ─── size routing ───────────────────────────────────────────────────
for (const [capHeight, allCaps] of [[8, false], [14, false], [21, false], [22, false], [48, false], [100, false], [22, true], [48, true], [14, true]]) {
	check(`routeSize(${capHeight}, allCaps=${allCaps})`, port.routeSize(capHeight, port.INDEX_SIZES, { allCaps }), ref.routeSize(capHeight, ref.INDEX_SIZES, { allCaps }));
}
check("routeSize(custom sizes)", port.routeSize(30, [20, 40]), ref.routeSize(30, [20, 40]));
check("routeSize(no caps entry)", port.routeSize(30, [48, 14], { allCaps: true }), ref.routeSize(30, [48, 14], { allCaps: true }));

// ─── a synthetic index through the real loader ──────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-font-index-"));
const indexFile = path.join(dir, "font-index.json");

/** A face with a deliberate distance from a probe. */
const face = (family, weight, categoryIndex, vector48, vector14) => [family, weight, categoryIndex, 0, vector48, vector14];

const fp = { advX: 0.5, advTall: 0.5, advance: 0.5, stemW: 0.1, densTall: 0.4, densX: 0.35, gap: 0.08, xRatio: 0.5, contrast: 2, roundFrac: 0.3, advCV: 0.3, descRatio: 0.2, runDensity: 2, serif: 1 };

const near = port.packVector({ ...fp, advX: 0.52, stemW: 0.095 });
const far = port.packVector({ ...fp, advX: 0.9, stemW: 0.2, contrast: 1.1 });
const sample = port.packVector({ ...fp, advX: 0.5, stemW: 0.1 });
const empty = port.packVector({});

fs.writeFileSync(
	indexFile,
	JSON.stringify({
		schema: 1,
		text: "Hamburgefonstiv",
		sizes: [48, 14],
		features: port.INDEX_FEATURES,
		categories: ["sans", "serif", "display"],
		entries: [
			face("Inter", 400, 0, near, near),
			face("Inter", 700, 0, near, near),
			face("Inter", 900, 0, near, near),
			face("Fraunces", 400, 1, far, far),
			face("Rubik Doodle", 400, 2, sample, sample),
			face("Sparse", 400, 0, sample, ""),
		],
	}),
);

try {
	const indexPort = port.loadFontIndex(indexFile);
	const indexRef = ref.loadFontIndex(indexFile);
	check("loadFontIndex(shape)", { schema: indexPort.schema, text: indexPort.text, sizes: indexPort.sizes, features: indexPort.features, count: indexPort.entries.length }, { schema: indexRef.schema, text: indexRef.text, sizes: indexRef.sizes, features: indexRef.features, count: indexRef.entries.length });
	check("loadFontIndex(entries)", indexPort.entries, indexRef.entries);

	const probe = { ...fp, capHeightPx: 48 };
	for (const options of [{}, { n: 2 }, { perFamily: 1 }, { category: "sans" }, { category: "sans, serif" }, { category: "MONO" }, { includeNonText: true }, { n: 100 }]) {
		check(`candidatesFromIndex(${JSON.stringify(options)})`, port.candidatesFromIndex(probe, indexPort, options), ref.candidatesFromIndex(probe, indexRef, options));
	}

	// A small cap height routes to the 14px vectors, where the sparse entry has none.
	check("candidatesFromIndex(small crop)", port.candidatesFromIndex({ ...fp, capHeightPx: 12 }, indexPort), ref.candidatesFromIndex({ ...fp, capHeightPx: 12 }, indexRef));
	check("candidatesFromIndex(missing file)", port.candidatesFromIndex(probe, port.loadFontIndex(path.join(dir, "absent.json"))), ref.candidatesFromIndex(probe, ref.loadFontIndex(path.join(dir, "absent.json"))));
	check("candidatesFromIndex(null fp)", port.candidatesFromIndex(null, indexPort), ref.candidatesFromIndex(null, indexRef));
	check("candidatesFromIndex(null index)", port.candidatesFromIndex(probe, null), ref.candidatesFromIndex(probe, null));
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

// A cached load returns the same decoded index, which is a behaviour the ranking relies on.
const againA = port.loadFontIndex(path.join(os.tmpdir(), "definitely-missing.json"));
const againB = port.loadFontIndex(path.join(os.tmpdir(), "definitely-missing.json"));
check("loadFontIndex(missing) is null both times", [againA, againB], [null, null]);

// ─── the real index the skill ships ─────────────────────────────────
// The vendored skill carries a 1.1 MB index of ~3,000 faces. A synthetic fixture proves the format;
// this proves the decode against the bytes that actually ship, which is the only thing a caller runs.
const shipped = path.resolve("extensions/designer/skill/scripts/data/font-index.json");
if (fs.existsSync(shipped)) {
	check("the shipped index exists", true, true);
	const portIndex = port.loadFontIndex(shipped);
	const refIndex = ref.loadFontIndex(shipped);
	check("the shipped index decodes to the same entries", portIndex.entries.length, refIndex.entries.length);
	check("the shipped index agrees on schema and features", { schema: portIndex.schema, features: portIndex.features, sizes: portIndex.sizes }, { schema: refIndex.schema, features: refIndex.features, sizes: refIndex.sizes });
	check("the shipped index agrees entry for entry", portIndex.entries, refIndex.entries);

	// A probe at catalog scale: the ranking is what a caller sees, so it is compared whole.
	const probe = { advX: 0.62, advTall: 0.6, advance: 0.64, advCV: 0.3, gap: 0.07, xRatio: 0.5, descRatio: 0.2, stemW: 0.12, contrast: 1.9, serif: 1, roundFrac: 0.3, densTall: 0.44, densX: 0.4, runDensity: 2, capHeightPx: 48 };
	check("the shipped index ranks the same candidates", port.candidatesFromIndex(probe, portIndex), ref.candidatesFromIndex(probe, refIndex));
	check("the shipped index ranks the same candidates for a small crop", port.candidatesFromIndex({ ...probe, capHeightPx: 12 }, portIndex), ref.candidatesFromIndex({ ...probe, capHeightPx: 12 }, refIndex));
	check("the shipped index ranks the same candidates for caps", port.candidatesFromIndex({ ...probe, allCaps: true }, portIndex), ref.candidatesFromIndex({ ...probe, allCaps: true }, refIndex));
	check("a category filter reads the shipped index", port.candidatesFromIndex(probe, portIndex, { category: "serif", n: 5 }), ref.candidatesFromIndex(probe, refIndex, { category: "serif", n: 5 }));
	check("non-text faces are excluded from the shipped index", port.candidatesFromIndex(probe, portIndex).every((c) => !port.NON_TEXT_FAMILY.test(c.family)), true);
} else {
	check("the shipped index is present", false, true);
	
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} font-index comparisons failed`);
	process.exit(1);
}
console.log(`font-index parity: ${comparisons} comparisons match the reference`);
