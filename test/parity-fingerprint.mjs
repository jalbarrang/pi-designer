/**
 * Parity check: lettering fingerprints and the distance against the reference.
 *
 * The fingerprint is what a comp's type is matched on, so every feature is compared, not just the
 * ones that move a ranking. The crops are drawn with the ported bitmap font at several sizes and
 * line counts, which gives real ink runs, real lines and real glyph columns: a single line, a
 * two-line headline with body copy beneath it (which exercises the isolation pass), a small crop
 * that must be upsampled, and non-lettering that must read as null.
 */
import * as port from "../extensions/designer/engine/lib/font-fingerprint.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/font-fingerprint.mjs";
import * as raster from "../extensions/designer/engine/lib/raster.ts";

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

/** Draw one or more lines of bitmap text, giving each line its own scale. */
function textImage(width, height, lines) {
	const img = raster.createImage(width, height, [255, 255, 255, 255]);
	let y = 4;
	for (const { text, scale } of lines) {
		raster.drawText(img, text, 6, y, [0, 0, 0, 255], scale);
		y += 7 * scale + 6;
	}
	return img;
}

const crops = {
	single: textImage(300, 50, [{ text: "HAMBURG", scale: 6 }]),
	mixed: textImage(340, 90, [{ text: "Hamburg", scale: 6 }, { text: "abcxyz", scale: 3 }]),
	headlineAndBody: textImage(360, 150, [
		{ text: "DISPLAY", scale: 7 },
		{ text: "the quick brown fox", scale: 2 },
	]),
	small: textImage(120, 24, [{ text: "HANDG", scale: 2 }]),
	tiny: textImage(80, 14, [{ text: "HANDG", scale: 1 }]),
	digits: textImage(220, 40, [{ text: "0123456789", scale: 5 }]),
	blank: raster.createImage(200, 40, [255, 255, 255, 255]),
	solidBar: raster.createImage(200, 40, [0, 0, 0, 255]),
	rule: (() => {
		const img = raster.createImage(200, 40, [255, 255, 255, 255]);
		raster.fillRect(img, 0, 18, 200, 3, [0, 0, 0, 255]);
		return img;
	})(),
	darkGround: (() => {
		const img = raster.createImage(300, 50, [20, 20, 24, 255]);
		raster.drawText(img, "NEGATIVE", 8, 10, [240, 240, 240, 255], 6);
		return img;
	})(),
};

for (const [name, img] of Object.entries(crops)) {
	check(`fingerprint(${name})`, port.fingerprint(img), ref.fingerprint(img));
	check(`fingerprint(${name}, no isolate)`, port.fingerprint(img, { isolate: false }), ref.fingerprint(img, { isolate: false }));
}

// The thresholds themselves are behaviour: a higher glyph floor can read a real crop as null.
for (const options of [{ minGlyphs: 1 }, { minGlyphs: 20 }, { minCap: 8 }, { minCap: 64 }]) {
	check(`fingerprint(mixed, ${JSON.stringify(options)})`, port.fingerprint(crops.mixed, options), ref.fingerprint(crops.mixed, options));
}

// The intermediate stages upstream keeps private (`binarize`, `findLines`, `measure`) are covered
// through `fingerprint` and `_debugLines`, which are the two entry points it does export.
check("FEATURES", port.FEATURES, ref.FEATURES);
for (const [name, img] of Object.entries({ single: crops.single, mixed: crops.mixed, small: crops.small, blank: crops.blank })) {
	check(`_debugLines(${name})`, port._debugLines(img), ref._debugLines(img));
}

// ─── distance ───────────────────────────────────────────────────────
check("STATS", port.STATS, ref.STATS);

const vectors = {
	condensed: { advX: 0.42, advTall: 0.4, advance: 0.44, advCV: 0.22, gap: 0.06, xRatio: 0.5, descRatio: 0.2, stemW: 0.09, contrast: 1.8, serif: 1.0, roundFrac: 0.2, densTall: 0.45, densX: 0.4, runDensity: 2.4 },
	wide: { advX: 1.1, advTall: 1.05, advance: 1.15, advCV: 0.3, gap: 0.12, xRatio: 0.52, descRatio: 0.22, stemW: 0.05, contrast: 1.1, serif: 1.0, roundFrac: 0.5, densTall: 0.28, densX: 0.25, runDensity: 1.4 },
	partial: { advX: 0.6, stemW: 0.07, contrast: 2.4, roundFrac: 0.1 },
};

for (const [aName, a] of Object.entries(vectors)) {
	for (const [bName, b] of Object.entries(vectors)) {
		check(`distance(${aName}, ${bName})`, port.distance(a, b), ref.distance(a, b));
		check(`distance(${aName}, ${bName}, p=2)`, port.distance(a, b, port.STATS, { p: 2 }), ref.distance(a, b, ref.STATS, { p: 2 }));
	}
}
check("distance(no gross)", port.distance(vectors.condensed, vectors.wide, port.STATS, { gross: false }), ref.distance(vectors.condensed, vectors.wide, ref.STATS, { gross: false }));
check("distance(zClip 1)", port.distance(vectors.condensed, vectors.wide, port.STATS, { zClip: 1 }), ref.distance(vectors.condensed, vectors.wide, ref.STATS, { zClip: 1 }));
check("distance(empty)", port.distance({}, {}), ref.distance({}, {}));
check("grossGap", port.grossGap(vectors.condensed, vectors.wide), ref.grossGap(vectors.condensed, vectors.wide));
check("grossGap(missing width)", port.grossGap({ stemW: 0.1 }, vectors.wide), ref.grossGap({ stemW: 0.1 }, vectors.wide));
check("GROSS_STD", { ...port.GROSS_STD }, { ...ref.GROSS_STD });
check("GROSS_W", port.GROSS_W, ref.GROSS_W);
check("Z_CLIP", port.Z_CLIP, ref.Z_CLIP);

// Real fingerprints, compared pairwise: this is the number a ranking actually sorts on.
const realPort = Object.fromEntries(Object.entries(crops).map(([name, img]) => [name, port.fingerprint(img)]));
const realRef = Object.fromEntries(Object.entries(crops).map(([name, img]) => [name, ref.fingerprint(img)]));
for (const aName of ["single", "mixed", "small"]) {
	for (const bName of ["single", "mixed", "digits"]) {
		const a = realPort[aName];
		const b = realPort[bName];
		if (!a || !b) continue;
		check(`distance(${aName}, ${bName}) on real crops`, port.distance(a, b), ref.distance(realRef[aName], realRef[bName]));
	}
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} font-fingerprint comparisons failed`);
	process.exit(1);
}
console.log(`font-fingerprint parity: ${comparisons} comparisons match the reference`);
