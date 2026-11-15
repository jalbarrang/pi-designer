/**
 * Parity check: the perceptual metrics against the reference.
 *
 * These scores decide whether a build passes its comp, so they are compared to floating point
 * equality on real image pairs: one identical, one shifted, one recoloured, one with the detail
 * replaced by a flat field. A metric that drifts silently would pass a build the comp rejects.
 */
import { createHash } from "node:crypto";
import * as port from "../extensions/designer/engine/lib/image-metrics.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/image-metrics.mjs";
import * as portRaster from "../extensions/designer/engine/lib/raster.ts";

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

const round = (value) => Number(value.toFixed(6));
const arrayDigest = (arr) => createHash("sha256").update(Buffer.from(new Float32Array(arr).buffer)).digest("hex").slice(0, 16);

/** A page-ish test image: bands, a solid block, and a textured run. */
function page(width, height, { recolor = null, flat = false, shift = 0 } = {}) {
	const img = portRaster.createImage(width, height, [250, 248, 244, 255]);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const band = Math.floor((y / height) * 4);
			const base = [250, 248, 244][band % 3] ?? 200;
			let v = base - band * 18;
			if (!flat && y > height * 0.5 && y < height * 0.7) v = (x * 7 + y * 13) % 200;
			const sx = (x + shift) % width;
			img.data[o] = Math.max(0, Math.min(255, recolor ? recolor[0] ?? v : v - (sx % 7)));
			img.data[o + 1] = Math.max(0, Math.min(255, recolor ? recolor[1] ?? v : v));
			img.data[o + 2] = Math.max(0, Math.min(255, recolor ? recolor[2] ?? v : v));
			img.data[o + 3] = 255;
		}
	}
	return img;
}

const comp = page(240, 180);
const same = page(240, 180);
const shifted = page(240, 180, { shift: 3 });
const recolored = page(240, 180, { recolor: [24, 40, 90] });
const flat = page(240, 180, { flat: true });

// ─── grayscale, blur, SSIM ──────────────────────────────────────────
for (const [name, img] of Object.entries({ comp, flat })) {
	check(`toGray(${name})`, arrayDigest(port.toGray(img).data), arrayDigest(ref.toGray(img).data));
	for (const r of [0, 1, 2, 5]) {
		check(`blurGray(${name}, r=${r})`, arrayDigest(port.blurGray(port.toGray(img), r).data), arrayDigest(ref.blurGray(ref.toGray(img), r).data));
	}
}

const grayA = port.toGray(comp);
const grayB = port.toGray(recolored);
check("ssim(identical)", round(port.ssim(grayA, port.toGray(same))), round(ref.ssim(ref.toGray(comp), ref.toGray(same))));
check("ssim(different)", round(port.ssim(grayA, grayB)), round(ref.ssim(ref.toGray(comp), ref.toGray(recolored))));
for (const win of [4, 8, 16]) {
	check(`ssim(win=${win})`, round(port.ssim(grayA, grayB, win)), round(ref.ssim(ref.toGray(comp), ref.toGray(recolored), win)));
}
check(
	"ssim(size mismatch throws)",
	(() => {
		try {
			return port.ssim(grayA, port.toGray(page(10, 10)));
		} catch (error) {
			return String(error.message);
		}
	})(),
	(() => {
		try {
			return ref.ssim(ref.toGray(comp), ref.toGray(page(10, 10)));
		} catch (error) {
			return String(error.message);
		}
	})(),
);

for (const [dx, dy] of [[0, 0], [3, 0], [0, 4], [-5, 2], [200, 0]]) {
	check(
		`ssimShifted(${dx},${dy})`,
		round(port.ssimShifted(grayA, port.toGray(shifted), dx, dy)),
		round(ref.ssimShifted(ref.toGray(comp), ref.toGray(shifted), dx, dy)),
	);
}

for (const [name, other] of Object.entries({ same, shifted, recolored, flat })) {
	check(`structureScore(${name})`, round(port.structureScore(comp, other)), round(ref.structureScore(comp, other)));
}
check("structureScore(workWidth 128)", round(port.structureScore(comp, recolored, 128)), round(ref.structureScore(comp, recolored, 128)));

// ─── colour ─────────────────────────────────────────────────────────
// `rgbToLab` is module-private upstream, so the Lab values it produces are exercised through
// `deltaE` and the dominant-colour palette, both of which are exported.
check(
	"deltaE(same-ish)",
	round(port.deltaE([50, 10, -20], [50, 10, -20])),
	round(ref.deltaE([50, 10, -20], [50, 10, -20])),
);
check(
	"deltaE(different)",
	round(port.deltaE(port.rgbToLab(24, 40, 90), port.rgbToLab(200, 190, 180))),
	round(ref.deltaE(port.rgbToLab(24, 40, 90), port.rgbToLab(200, 190, 180))),
);

for (const step of [1, 2, 3]) {
	check(`colorHistogram(step=${step})`, arrayDigest(port.colorHistogram(comp, step)), arrayDigest(ref.colorHistogram(comp, step)));
}
check(
	"histogramIntersection(self)",
	round(port.histogramIntersection(port.colorHistogram(comp), port.colorHistogram(comp))),
	round(ref.histogramIntersection(ref.colorHistogram(comp), ref.colorHistogram(comp))),
);
check(
	"histogramIntersection(cross)",
	round(port.histogramIntersection(port.colorHistogram(comp), port.colorHistogram(recolored))),
	round(ref.histogramIntersection(ref.colorHistogram(comp), ref.colorHistogram(recolored))),
);

for (const [name, img] of Object.entries({ comp, recolored, flat })) {
	for (const k of [3, 6]) {
		check(`dominantColors(${name}, k=${k})`, port.dominantColors(img, k), ref.dominantColors(img, k));
	}
}

check("toHex(pads)", port.toHex([0, 0, 0]), ref.toHex([0, 0, 0]));
check("toHex(clamps)", port.toHex([-10, 300, 128]), ref.toHex([-10, 300, 128]));
check(
	"paletteMatch(self)",
	round(port.paletteMatch(port.dominantColors(comp), port.dominantColors(comp))),
	round(ref.paletteMatch(ref.dominantColors(comp), ref.dominantColors(comp))),
);
check(
	"paletteMatch(cross)",
	round(port.paletteMatch(port.dominantColors(comp), port.dominantColors(recolored))),
	round(ref.paletteMatch(ref.dominantColors(comp), ref.dominantColors(recolored))),
);
check("paletteMatch(empty comp)", port.paletteMatch([], port.dominantColors(comp)), ref.paletteMatch([], ref.dominantColors(comp)));

for (const [name, other] of Object.entries({ same, recolored })) {
	const a = port.colorScore(comp, other);
	const b = ref.colorScore(comp, other);
	check(`colorScore(${name})`, { score: round(a.score), intersection: round(a.intersection), paletteMatch: round(a.paletteMatch) }, { score: round(b.score), intersection: round(b.intersection), paletteMatch: round(b.paletteMatch) });
}

// ─── detail ─────────────────────────────────────────────────────────
for (const [cols, rows] of [[12, 8], [4, 4], [2, 1]]) {
	const a = port.detailGrid(comp, cols, rows);
	const b = ref.detailGrid(comp, cols, rows);
	check(`detailGrid(${cols}×${rows})`, { cols: a.cols, rows: a.rows, cells: arrayDigest(a.cells) }, { cols: b.cols, rows: b.rows, cells: arrayDigest(b.cells) });
}

for (const [name, other] of Object.entries({ same, flat, recolored })) {
	const a = port.detailScore(comp, other);
	const b = ref.detailScore(comp, other);
	check(
		`detailScore(${name})`,
		{ score: round(a.score), rawScore: round(a.rawScore), addedFraction: round(a.addedFraction), ratios: arrayDigest(a.ratios) },
		{ score: round(b.score), rawScore: round(b.rawScore), addedFraction: round(b.addedFraction), ratios: arrayDigest(b.ratios) },
	);
}

// ─── diff map and bands ─────────────────────────────────────────────
for (const [name, other] of Object.entries({ same, shifted, recolored })) {
	check(`diffMap(${name})`, arrayDigest(port.diffMap(comp, other).data), arrayDigest(ref.diffMap(comp, other).data));
}

const bandsComp = port.horizontalBands(comp);
const bandsOther = port.horizontalBands(recolored);
check("horizontalBands(comp)", bandsComp, ref.horizontalBands(comp));
check("horizontalBands(recolored)", bandsOther, ref.horizontalBands(recolored));
for (const tol of [0.02, 0.04, 0.1]) {
	check(`bandScore(tol=${tol})`, round(port.bandScore(bandsComp, bandsOther, tol)), round(ref.bandScore(bandsComp, bandsOther, tol)));
}
check("bandScore(empty, empty)", port.bandScore([], []), ref.bandScore([], []));
check("bandScore(empty, some)", round(port.bandScore([], [{ y: 0.5, strength: 1 }])), round(ref.bandScore([], [{ y: 0.5, strength: 1 }])));

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} image-metrics comparisons failed`);
	process.exit(1);
}
console.log(`image-metrics parity: ${comparisons} comparisons match the reference`);
