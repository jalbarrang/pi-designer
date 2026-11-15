/**
 * Perceptual measures for comparing a comp with a build screenshot. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Three families, because a build fails a comp in three separable ways:
 *
 * - structure: is the composition the same? SSIM over a blurred grayscale downsample, which
 *   forgives font hinting and a few pixels of drift and punishes a moved or invented region.
 * - color: is the palette and its distribution the same? Histogram intersection in a coarse
 *   quantized space plus dominant-color extraction, so a navy page built from a bone comp fails
 *   even when the shapes match.
 * - detail: is the material there? Local high-frequency energy per cell. A comp with a texture or
 *   photograph carries energy a flat CSS stand-in does not.
 *
 * Pure functions over RGBA images; no I/O.
 */
import { resize, type Image } from "./raster.ts";

/** A single-channel float image. */
export interface GrayImage {
	readonly width: number;
	readonly height: number;
	readonly data: Float32Array;
}

function toGray(img: Image): GrayImage {
	const data = new Float32Array(img.width * img.height);
	for (let i = 0, p = 0; i < data.length; i++, p += 4) {
		const a = img.data[p + 3] / 255;
		// Composited over white, so a transparent region reads as the page ground.
		const r = img.data[p] * a + 255 * (1 - a);
		const g = img.data[p + 1] * a + 255 * (1 - a);
		const b = img.data[p + 2] * a + 255 * (1 - a);
		data[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}
	return { width: img.width, height: img.height, data };
}

/** Separable box blur on a float gray image. */
function blurGray(gray: GrayImage, r: number): GrayImage {
	if (r <= 0) return gray;

	const { width, height, data } = gray;
	const tmp = new Float32Array(data.length);
	const out = new Float32Array(data.length);
	const win = 2 * r + 1;

	for (let y = 0; y < height; y++) {
		let acc = 0;
		for (let x = -r; x <= r; x++) acc += data[y * width + Math.min(width - 1, Math.max(0, x))];
		for (let x = 0; x < width; x++) {
			tmp[y * width + x] = acc / win;
			const outX = x - r;
			const inX = x + r + 1;
			acc += data[y * width + Math.min(width - 1, inX)] - data[y * width + Math.max(0, outX)];
		}
	}

	for (let x = 0; x < width; x++) {
		let acc = 0;
		for (let y = -r; y <= r; y++) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
		for (let y = 0; y < height; y++) {
			out[y * width + x] = acc / win;
			const outY = y - r;
			const inY = y + r + 1;
			acc += tmp[Math.min(height - 1, inY) * width + x] - tmp[Math.max(0, outY) * width + x];
		}
	}

	return { width, height, data: out };
}

/** Global SSIM between two same-size gray images over a window grid. */
function ssim(a: GrayImage, b: GrayImage, win = 8): number {
	if (a.width !== b.width || a.height !== b.height) throw new Error("ssim: size mismatch");

	const C1 = (0.01 * 255) ** 2;
	const C2 = (0.03 * 255) ** 2;
	let total = 0;
	let n = 0;

	for (let y = 0; y + win <= a.height; y += win) {
		for (let x = 0; x + win <= a.width; x += win) {
			let ma = 0;
			let mb = 0;
			for (let yy = 0; yy < win; yy++) {
				for (let xx = 0; xx < win; xx++) {
					const i = (y + yy) * a.width + x + xx;
					ma += a.data[i];
					mb += b.data[i];
				}
			}
			ma /= win * win;
			mb /= win * win;

			let va = 0;
			let vb = 0;
			let cov = 0;
			for (let yy = 0; yy < win; yy++) {
				for (let xx = 0; xx < win; xx++) {
					const i = (y + yy) * a.width + x + xx;
					const da = a.data[i] - ma;
					const db = b.data[i] - mb;
					va += da * da;
					vb += db * db;
					cov += da * db;
				}
			}
			va /= win * win - 1;
			vb /= win * win - 1;
			cov /= win * win - 1;

			total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
			n++;
		}
	}

	return n ? total / n : 1;
}

/** SSIM of `a` against `b` shifted by (dx, dy); the overlap is compared and the edges dropped. */
function ssimShifted(a: GrayImage, b: GrayImage, dx: number, dy: number, win = 8): number {
	const w = a.width - Math.abs(dx);
	const h = a.height - Math.abs(dy);
	if (w < win || h < win) return 0;

	const sa: GrayImage = { width: w, height: h, data: new Float32Array(w * h) };
	const sb: GrayImage = { width: w, height: h, data: new Float32Array(w * h) };
	const ax = Math.max(0, -dx);
	const ay = Math.max(0, -dy);
	const bx = Math.max(0, dx);
	const by = Math.max(0, dy);

	for (let y = 0; y < h; y++) {
		sa.data.set(a.data.subarray((y + ay) * a.width + ax, (y + ay) * a.width + ax + w), y * w);
		sb.data.set(b.data.subarray((y + by) * b.width + bx, (y + by) * b.width + bx + w), y * w);
	}

	return ssim(sa, sb, win);
}

/**
 * Structure score 0..1: SSIM over blurred grayscale at a fixed working width, taking the best of
 * a small translation search so a composition a few pixels off is not read as a different one.
 * Shifts up to about 4% of the width are forgiven; a moved region is not.
 */
function structureScore(imgA: Image, imgB: Image, workWidth = 256): number {
	const h = Math.max(8, Math.round((imgA.height / imgA.width) * workWidth));
	const a = blurGray(toGray(resize(imgA, workWidth, h)), 2);
	const b = blurGray(toGray(resize(imgB, workWidth, h)), 2);
	const win = Math.min(8, Math.max(2, Math.floor(Math.min(workWidth, h) / 8)));

	let best = ssim(a, b, win);
	const maxShift = Math.max(2, Math.round(workWidth * 0.04));
	for (const dy of [-maxShift, -maxShift / 2, 0, maxShift / 2, maxShift]) {
		for (const dx of [-maxShift, -maxShift / 2, 0, maxShift / 2, maxShift]) {
			if (!dx && !dy) continue;
			best = Math.max(best, ssimShifted(a, b, Math.round(dx), Math.round(dy), win));
		}
	}
	return Math.max(0, Math.min(1, best));
}

// ─── colour ────────────────────────────────────────────────────────────────

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const R = lin(r);
	const G = lin(g);
	const B = lin(b);
	const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
	const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
	const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = f(X);
	const fy = f(Y);
	const fz = f(Z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(lab1: readonly number[], lab2: readonly number[]): number {
	return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

/** A quantized colour histogram (4 bits per channel, 4096 bins), normalized. */
function colorHistogram(img: Image, sampleStep = 2): Float32Array {
	const bins = new Float32Array(4096);
	let n = 0;

	for (let y = 0; y < img.height; y += sampleStep) {
		for (let x = 0; x < img.width; x += sampleStep) {
			const p = (y * img.width + x) * 4;
			if (img.data[p + 3] < 16) continue;
			const key = ((img.data[p] >> 4) << 8) | ((img.data[p + 1] >> 4) << 4) | (img.data[p + 2] >> 4);
			bins[key]++;
			n++;
		}
	}

	if (n) for (let i = 0; i < bins.length; i++) bins[i] /= n;
	return bins;
}

function histogramIntersection(h1: Float32Array, h2: Float32Array): number {
	let s = 0;
	for (let i = 0; i < h1.length; i++) s += Math.min(h1[i], h2[i]);
	return s;
}

/** One dominant colour: its hex, its share of the covered palette, and its Lab value. */
export interface DominantColor {
	readonly hex: string;
	readonly coverage: number;
	readonly lab: readonly number[];
}

/** Merge histogram bins greedily by Lab distance into up to `k` clusters, sorted by coverage. */
function dominantColors(img: Image, k = 6, sampleStep = 3): DominantColor[] {
	const hist = colorHistogram(img, sampleStep);
	const entries: Array<{ key: number; w: number }> = [];
	for (let i = 0; i < hist.length; i++) if (hist[i] > 0.0005) entries.push({ key: i, w: hist[i] });
	entries.sort((a, b) => b.w - a.w);

	const clusters: Array<{ rgb: number[]; lab: number[]; w: number }> = [];
	for (const entry of entries) {
		const r = ((entry.key >> 8) & 15) * 16 + 8;
		const g = ((entry.key >> 4) & 15) * 16 + 8;
		const b = (entry.key & 15) * 16 + 8;
		const lab = rgbToLab(r, g, b);

		let best: (typeof clusters)[number] | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		for (const cluster of clusters) {
			const d = deltaE(cluster.lab, lab);
			if (d < bestD) {
				bestD = d;
				best = cluster;
			}
		}

		if (best && bestD < 14) {
			const tw = best.w + entry.w;
			best.rgb = [(best.rgb[0] * best.w + r * entry.w) / tw, (best.rgb[1] * best.w + g * entry.w) / tw, (best.rgb[2] * best.w + b * entry.w) / tw];
			best.lab = rgbToLab(best.rgb[0], best.rgb[1], best.rgb[2]);
			best.w = tw;
		} else {
			clusters.push({ rgb: [r, g, b], lab, w: entry.w });
		}
	}

	clusters.sort((a, b) => b.w - a.w);
	const top = clusters.slice(0, k);
	const covered = top.reduce((s, c) => s + c.w, 0) || 1;
	return top.map((c) => ({ hex: toHex(c.rgb), coverage: Number((c.w / covered).toFixed(4)), lab: c.lab }));
}

function toHex(rgb: readonly number[]): string {
	return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Palette match 0..1: coverage-weighted best Lab match, where dE 0 is 1 and dE 25 or more is 0. */
function paletteMatch(compColors: readonly DominantColor[], buildColors: readonly DominantColor[]): number {
	if (compColors.length === 0) return 1;

	let s = 0;
	let wsum = 0;
	for (const comp of compColors) {
		let best = Number.POSITIVE_INFINITY;
		for (const build of buildColors) best = Math.min(best, deltaE(comp.lab, build.lab));
		s += comp.coverage * Math.max(0, 1 - best / 25);
		wsum += comp.coverage;
	}
	return wsum ? s / wsum : 1;
}

/** Colour score 0..1: a blend of histogram intersection and dominant-palette match. */
function colorScore(imgA: Image, imgB: Image): { score: number; intersection: number; paletteMatch: number } {
	const intersection = histogramIntersection(colorHistogram(imgA), colorHistogram(imgB));
	const palette = paletteMatch(dominantColors(imgA), dominantColors(imgB));
	return { score: 0.35 * intersection + 0.65 * palette, intersection, paletteMatch: palette };
}

// ─── detail ────────────────────────────────────────────────────────────────

/** A grid of per-cell energy. */
export interface DetailGrid {
	readonly cols: number;
	readonly rows: number;
	readonly cells: Float32Array;
}

/** Mean absolute gradient per cell over a cols × rows grid. */
function detailGrid(img: Image, cols = 12, rows = 8, workWidth = 512): DetailGrid {
	const h = Math.max(rows, Math.round((img.height / img.width) * workWidth));
	const g = toGray(resize(img, workWidth, h));
	const cells = new Float32Array(cols * rows);
	const counts = new Float32Array(cols * rows);

	for (let y = 1; y < g.height - 1; y++) {
		const cy = Math.min(rows - 1, Math.floor((y / g.height) * rows));
		for (let x = 1; x < g.width - 1; x++) {
			const cx = Math.min(cols - 1, Math.floor((x / g.width) * cols));
			const i = y * g.width + x;
			const gx = Math.abs(g.data[i + 1] - g.data[i - 1]);
			const gy = Math.abs(g.data[i + g.width] - g.data[i - g.width]);
			cells[cy * cols + cx] += gx + gy;
			counts[cy * cols + cx]++;
		}
	}

	for (let i = 0; i < cells.length; i++) cells[i] = counts[i] ? cells[i] / counts[i] : 0;
	return { cols, rows, cells };
}

/**
 * Detail score 0..1 and per-cell ratio.
 *
 * Cells where the comp is nearly flat are ignored, since there is nothing to lose. The score is
 * the coverage-weighted mean of min(1, build/comp) over cells with comp energy, so extra detail
 * in the build — invented chrome — is reported separately as `added`.
 */
function detailScore(imgA: Image, imgB: Image, cols = 12, rows = 8): {
	score: number;
	rawScore: number;
	addedFraction: number;
	comp: DetailGrid;
	build: DetailGrid;
	ratios: Float32Array;
} {
	const a = detailGrid(imgA, cols, rows);
	const b = detailGrid(imgB, cols, rows);
	const floor = 1.5; // energy below this is a flat field at the 512px working width

	let s = 0;
	let w = 0;
	let added = 0;
	let addedW = 0;
	const ratios = new Float32Array(cols * rows);

	for (let i = 0; i < a.cells.length; i++) {
		const ca = a.cells[i];
		const cb = b.cells[i];
		ratios[i] = ca > floor ? cb / ca : cb > floor ? Number.POSITIVE_INFINITY : 1;

		// Signed: too much energy is as wrong as too little. Noise or a mosaic saturates a
		// one-sided ratio; a real plate does not.
		if (ca > floor) {
			s += Math.min(cb / ca, ca / cb) * ca;
			w += ca;
		}
		if (cb > ca * 1.8 && cb > floor * 2) added += 1;
		addedW += 1;
	}

	const addedFraction = addedW ? added / addedW : 0;
	const raw = w ? s / w : 1;
	return { score: Math.max(0, raw - 0.5 * addedFraction), rawScore: raw, addedFraction, comp: a, build: b, ratios };
}

// ─── pixel diff ────────────────────────────────────────────────────────────

/** A per-pixel difference map (0..1) at a working width, blurred a little. */
function diffMap(imgA: Image, imgB: Image, workWidth = 384): GrayImage {
	const h = Math.max(8, Math.round((imgA.height / imgA.width) * workWidth));
	const a = resize(imgA, workWidth, h);
	const b = resize(imgB, workWidth, h);
	const out = new Float32Array(workWidth * h);

	for (let i = 0, p = 0; i < out.length; i++, p += 4) {
		const dr = a.data[p] - b.data[p];
		const dg = a.data[p + 1] - b.data[p + 1];
		const db = a.data[p + 2] - b.data[p + 2];
		out[i] = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 200);
	}

	return blurGray({ width: workWidth, height: h, data: out }, 1);
}

// ─── bands ─────────────────────────────────────────────────────────────────

/** A horizontal band boundary: where it sits (0..1) and how strong the change is. */
export interface Band {
	y: number;
	strength: number;
}

/**
 * Horizontal band boundaries: rows where the mean colour changes sharply. This is the layout-grid
 * read of a page — header, hero, index, footer as bands.
 */
function horizontalBands(img: Image, workWidth = 128, minGap = 0.02): Band[] {
	const h = Math.max(16, Math.round((img.height / img.width) * workWidth));
	const s = resize(img, workWidth, h);
	const rowMean = new Float32Array(h * 3);

	for (let y = 0; y < h; y++) {
		let r = 0;
		let g = 0;
		let b = 0;
		for (let x = 0; x < workWidth; x++) {
			const p = (y * workWidth + x) * 4;
			r += s.data[p];
			g += s.data[p + 1];
			b += s.data[p + 2];
		}
		rowMean[y * 3] = r / workWidth;
		rowMean[y * 3 + 1] = g / workWidth;
		rowMean[y * 3 + 2] = b / workWidth;
	}

	const edges: Band[] = [];
	for (let y = 1; y < h; y++) {
		const d = Math.hypot(
			rowMean[y * 3] - rowMean[(y - 1) * 3],
			rowMean[y * 3 + 1] - rowMean[(y - 1) * 3 + 1],
			rowMean[y * 3 + 2] - rowMean[(y - 1) * 3 + 2],
		);
		if (d > 18) edges.push({ y: y / h, strength: Math.min(1, d / 120) });
	}

	// Close edges merge into one, keeping the stronger position.
	const merged: Band[] = [];
	for (const edge of edges) {
		const last = merged[merged.length - 1];
		if (last && edge.y - last.y < minGap) {
			if (edge.strength > last.strength) {
				last.y = edge.y;
				last.strength = edge.strength;
			}
		} else {
			merged.push({ ...edge });
		}
	}
	return merged;
}

/** Band agreement 0..1: how many comp bands have a build band nearby, and the reverse. */
function bandScore(bandsA: readonly Band[], bandsB: readonly Band[], tol = 0.04): number {
	if (bandsA.length === 0 && bandsB.length === 0) return 1;
	const match = (from: readonly Band[], to: readonly Band[]) => from.filter((a) => to.some((b) => Math.abs(a.y - b.y) <= tol)).length;
	const recall = bandsA.length ? match(bandsA, bandsB) / bandsA.length : 1;
	const precision = bandsB.length ? match(bandsB, bandsA) / bandsB.length : 1;
	return 0.6 * recall + 0.4 * precision;
}

export {
	bandScore,
	blurGray,
	colorHistogram,
	colorScore,
	deltaE,
	detailGrid,
	detailScore,
	diffMap,
	dominantColors,
	histogramIntersection,
	horizontalBands,
	paletteMatch,
	rgbToLab,
	ssim,
	ssimShifted,
	structureScore,
	toGray,
	toHex,
};
