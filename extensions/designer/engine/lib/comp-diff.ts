/**
 * Comp fidelity: comparing a build screenshot against its comp, per region. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The scores rank; the verdicts are what a build acts on. Four of them: `match`, `drift` (there, a
 * little off), `missing` (nothing drawn where the comp drew something), and `contradicted`
 * (something else is drawn there). The verdict rules are deliberately more careful than the mean:
 * a weighted average lets a busy wrong region pass on colour and energy, so structure and detail
 * floors override it.
 */
import fs from "node:fs";
import path from "node:path";
import { encodePng, loadRaster } from "./png.ts";
import { blit, createImage, crop, drawLabel, fillRect, fit, resize, strokeRect, type Image } from "./raster.ts";
import {
	bandScore,
	blurGray,
	colorScore,
	detailScore,
	diffMap,
	dominantColors,
	horizontalBands,
	ssimShifted,
	structureScore,
	toGray,
} from "./image-metrics.ts";

/** Read a raster file as an image. */
function readPng(file: string): Image {
	return loadRaster(file).image;
}

/**
 * Scale the build onto the comp: `top` takes the top comp-height rows, `stretch` squashes the
 * whole build onto the comp, `cover` scales to cover and centre-crops the way `object-fit: cover`
 * will show a plate whose aspect differs from its region.
 */
function alignBuild(comp: Image, build: Image, align = "top"): Image {
	if (align === "stretch") return resize(build, comp.width, comp.height);

	if (align === "cover") {
		const s = Math.max(comp.width / build.width, comp.height / build.height);
		const scaled = resize(build, build.width * s, build.height * s);
		return crop(scaled, (scaled.width - comp.width) / 2, (scaled.height - comp.height) / 2, comp.width, comp.height);
	}

	const scaled = build.width === comp.width ? build : resize(build, comp.width, Math.round((build.height / build.width) * comp.width));
	if (scaled.height === comp.height) return scaled;
	if (scaled.height > comp.height) return crop(scaled, 0, 0, comp.width, comp.height);

	// Shorter than the comp: pad with white, so a short page reads as missing content rather than as
	// a resize.
	const out = createImage(comp.width, comp.height, [255, 255, 255, 255]);
	blit(out, scaled, 0, 0);
	return out;
}

/** Per-kind weights: what a region is made of decides what losing it looks like. */
interface Weights {
	readonly structure: number;
	readonly color: number;
	readonly detail: number;
	readonly bands: number;
}

const WEIGHTS: Readonly<Record<string, Weights>> = {
	default: { structure: 0.35, color: 0.25, detail: 0.25, bands: 0.15 },
	plate: { structure: 0.25, color: 0.2, detail: 0.5, bands: 0.05 },
	image: { structure: 0.25, color: 0.2, detail: 0.5, bands: 0.05 },
	texture: { structure: 0.15, color: 0.35, detail: 0.5, bands: 0 },
	text: { structure: 0.5, color: 0.25, detail: 0.15, bands: 0.1 },
	control: { structure: 0.45, color: 0.35, detail: 0.2, bands: 0 },
};

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** The scores for one pair of crops. */
interface PairScore {
	readonly overall: number;
	readonly structure: number;
	readonly color: number;
	readonly colorIntersection: number;
	readonly paletteMatch: number;
	readonly detail: number;
	readonly detailRaw: number;
	readonly detailAdded: number;
	readonly bands: number;
}

/** Score two crops of the same size, weighted by what the region is made of. */
function scorePair(a: Image, b: Image, kind: string | null = null): PairScore & { _detail: ReturnType<typeof detailScore>; _bands: { comp: ReturnType<typeof horizontalBands>; build: ReturnType<typeof horizontalBands> } } {
	const structure = structureScore(a, b);
	const color = colorScore(a, b);
	const detail = detailScore(a, b);
	const bandsA = horizontalBands(a);
	const bandsB = horizontalBands(b);
	const bands = bandScore(bandsA, bandsB);
	const w = (kind && WEIGHTS[kind]) || WEIGHTS.default;
	const overall = w.structure * structure + w.color * color.score + w.detail * detail.score + w.bands * bands;

	return {
		overall: r4(overall),
		structure: r4(structure),
		color: r4(color.score),
		colorIntersection: r4(color.intersection),
		paletteMatch: r4(color.paletteMatch),
		detail: r4(detail.score),
		detailRaw: r4(detail.rawScore ?? detail.score),
		detailAdded: r4(detail.addedFraction),
		bands: r4(bands),
		_detail: detail,
		_bands: { comp: bandsA, build: bandsB },
	};
}

/** Kinds that carry the direction: a wrong one is the wrong page, whatever the mean says. */
const DIRECTION_KINDS: ReadonlySet<string> = new Set(["plate", "image", "text"]);

/** The best small global translation (build relative to comp), in pixels, by blurred-gray SSIM. */
function bestShift(comp: Image, build: Image, workWidth = 256): { dx: number; dy: number; score: number } {
	const h = Math.max(8, Math.round((comp.height / comp.width) * workWidth));
	const a = blurGray(toGray(resize(comp, workWidth, h)), 2);
	const b = blurGray(toGray(resize(build, workWidth, h)), 2);
	const maxShift = Math.max(2, Math.round(workWidth * 0.04));

	let best = { dx: 0, dy: 0, score: ssimShifted(a, b, 0, 0) };
	for (const dy of [-maxShift, -maxShift / 2, 0, maxShift / 2, maxShift]) {
		for (const dx of [-maxShift, -maxShift / 2, 0, maxShift / 2, maxShift]) {
			const score = ssimShifted(a, b, Math.round(dx), Math.round(dy));
			if (score > best.score + 0.01) best = { dx: Math.round(dx), dy: Math.round(dy), score };
		}
	}

	const scale = comp.width / workWidth;
	return { dx: Math.round(best.dx * scale), dy: Math.round(best.dy * scale), score: best.score };
}

/** One of the four things a region can be. */
type Verdict = "match" | "drift" | "missing" | "contradicted";

/**
 * What a region is, from its scores.
 *
 * The floors override the weighted mean on purpose. Structure is the one thing a wrong-but-busy
 * region cannot fake: noise, a mirrored crop, a swapped column and a tile shuffle all keep colour
 * and energy and lose structure.
 */
function verdictFor(s: PairScore, kind: string | null = null): Verdict {
	const painted = kind === "plate" || kind === "image" || kind === "texture";

	// Nothing drawn where the comp drew something is missing whatever the palette says: a footer
	// strip the build pushed below the fold read as drift on ground colour alone. detailRaw is 1
	// when the comp region itself is calm, so a low value already means the comp had material there.
	if (s.detailRaw != null && s.detailRaw < 0.15) return "missing";
	if (painted && s.detail < 0.5) return "missing";

	// For text, chrome and controls, "missing" means the build has nothing there, not that a thin
	// strip sits a few pixels off: require the build's own energy to be near zero relative to the
	// comp, before the added-detail penalty, and call a mere misalignment drift.
	if (!painted && s.detail < 0.35 && s.structure < 0.6) {
		if (s.detailRaw != null && s.detailRaw < 0.2) return "missing";
		// Low detail with structure and palette both holding is grain the build renders flatter, not a
		// different composition.
		if (s.structure >= 0.5 && s.color >= 0.5) return "drift";
		return "contradicted";
	}
	if (s.detail < 0.35 && s.structure < 0.6) return "missing";

	if (s.structure < 0.3) return "contradicted";
	if (painted && (s.structure < 0.45 || s.detailAdded > 0.4)) return "contradicted";

	// Text is set in a substitute face at a slightly different metric almost always, and blurred SSIM
	// reads glyph shape, so text with structure above the swap floor and its palette intact is drift
	// at worst. Chasing it past that point is what burned eight to thirteen hero attempts per build.
	if (kind === "text" && s.color >= 0.5) return s.overall >= 0.8 ? "match" : "drift";

	// Chrome and controls are thin strips whose "detail" is mostly ground grain, so when structure and
	// palette hold, low detail is drift, not contradiction.
	if ((kind === "chrome" || kind === "control") && s.structure >= 0.5 && s.color >= 0.5) return s.overall >= 0.8 ? "match" : "drift";

	if (s.overall >= 0.8) return "match";
	if (s.overall >= 0.6) return "drift";
	return "contradicted";
}

/** A resolved region: a normalized box plus the kind it was declared with. */
interface ResolvedRegion {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly kind: string | null;
}

/** The spec shape this reads, so it does not import the spec module. */
interface SpecLike {
	readonly regions?: ReadonlyArray<{ readonly id?: string; readonly kind?: string; readonly box?: { x: number; y: number; w: number; h: number } }>;
}

/**
 * Regions from a spec (normalized boxes) or derived from the comp's bands.
 *
 * A comp with fewer than two bands still needs something to compare, so the last resort is a top
 * and bottom half rather than no regions at all.
 */
function resolveRegions(comp: Image, spec: SpecLike | null): ResolvedRegion[] {
	const regions: ResolvedRegion[] = [];

	if (spec && Array.isArray(spec.regions) && spec.regions.length > 0) {
		for (const r of spec.regions) {
			const box = r.box;
			if (!box || [box.x, box.y, box.w, box.h].some((v) => typeof v !== "number")) continue;
			regions.push({ id: r.id || `region-${regions.length + 1}`, x: box.x, y: box.y, w: box.w, h: box.h, kind: r.kind || null });
		}
		if (regions.length > 0) return regions;
	}

	const bands = horizontalBands(comp).filter((b) => b.strength > 0.2);
	const cuts = [0, ...bands.map((b) => b.y), 1].filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.06);
	if (cuts[cuts.length - 1] !== 1) cuts.push(1);
	for (let i = 0; i + 1 < cuts.length; i++) {
		regions.push({ id: `band-${i + 1}`, x: 0, y: cuts[i], w: 1, h: cuts[i + 1] - cuts[i], kind: "band" });
	}

	if (regions.length < 2) {
		return [
			{ id: "top", x: 0, y: 0, w: 1, h: 0.5, kind: "band" },
			{ id: "bottom", x: 0, y: 0.5, w: 1, h: 0.5, kind: "band" },
		];
	}
	return regions;
}

/** The bounding box of ink within a crop, in pixels, or null when the crop is flat. */
function inkBox(img: Image): { x: number; y: number; w: number; h: number } | null {
	const g = toGray(img);

	// Ground is the median gray; ink is anything more than 48 away from it.
	const sample: number[] = [];
	for (let i = 0; i < g.data.length; i += Math.max(1, Math.floor(g.data.length / 4000))) sample.push(g.data[i]);
	sample.sort((p, q) => p - q);
	const ground = sample[Math.floor(sample.length / 2)] || 255;

	let x0 = img.width;
	let y0 = img.height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			if (Math.abs(g.data[y * img.width + x] - ground) > 48) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return null;
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Crop a normalized region, growing any axis thinner than 48px so a thin strip does not swing on noise. */
function regionCrop(img: Image, r: ResolvedRegion): Image {
	const minPx = 48;
	let x = r.x * img.width;
	let y = r.y * img.height;
	let w = r.w * img.width;
	let h = r.h * img.height;
	if (h < minPx) {
		y -= (minPx - h) / 2;
		h = minPx;
	}
	if (w < minPx) {
		x -= (minPx - w) / 2;
		w = minPx;
	}
	return crop(img, x, y, w, h);
}

const HEAT_LABEL: Readonly<Record<string, [number, number, number, number]>> = {
	match: [40, 160, 80, 255],
	drift: [220, 160, 30, 255],
	missing: [200, 40, 40, 255],
	contradicted: [200, 40, 40, 255],
};

/** The two images side by side, captioned with the scores a human needs to judge them. */
function renderSideBySide(comp: Image, build: Image, label: string, score: PairScore): Image {
	const gap = 24;
	const pad = 48;
	const targetW = Math.min(comp.width, 1400);
	const a = fit(comp, targetW, 100000);
	const b = resize(build, a.width, a.height);
	const out = createImage(a.width * 2 + gap + pad * 2, a.height + pad * 2 + 24, [24, 24, 28, 255]);

	blit(out, a, pad, pad + 24);
	blit(out, b, pad + a.width + gap, pad + 24);
	drawLabel(out, "COMP", pad, pad - 4, { scale: 2 });
	drawLabel(out, `BUILD ${label ? label.toUpperCase() : ""}`.trim(), pad + a.width + gap, pad - 4, { scale: 2 });

	const s = `OVERALL ${(score.overall * 100).toFixed(0)}%  STRUCT ${(score.structure * 100).toFixed(0)}%  COLOR ${(score.color * 100).toFixed(0)}%  DETAIL ${(score.detail * 100).toFixed(0)}%  BANDS ${(score.bands * 100).toFixed(0)}%`;
	drawLabel(out, s, pad, out.height - pad + 8, { scale: 2, bg: HEAT_LABEL[verdictFor(score)] });
	return out;
}

/** The build with its differences from the comp painted red. */
function renderHeatmap(comp: Image, build: Image): Image {
	const map = diffMap(comp, build);
	const base = resize(build, map.width, map.height);
	const out = { width: base.width, height: base.height, data: new Uint8Array(base.data) };

	for (let i = 0, p = 0; i < map.data.length; i++, p += 4) {
		const d = map.data[i];
		if (d < 0.12) {
			// Dim what matches, so what is wrong stands out.
			out.data[p] = out.data[p] * 0.55 + 255 * 0.45 * 0.2;
			out.data[p + 1] = out.data[p + 1] * 0.55;
			out.data[p + 2] = out.data[p + 2] * 0.55;
			continue;
		}
		const a = Math.min(1, (d - 0.12) / 0.5);
		out.data[p] = out.data[p] * (1 - a) + 235 * a;
		out.data[p + 1] = out.data[p + 1] * (1 - a) + 40 * a;
		out.data[p + 2] = out.data[p + 2] * (1 - a) + 40 * a;
	}

	const scaled = resize(out, comp.width, comp.height);
	drawLabel(scaled, "DIFF: RED = DIFFERS FROM COMP", 12, 12, { scale: 2 });
	return scaled;
}

/** One region's comp and build crops side by side, captioned with its verdict. */
function renderRegionPair(compCrop: Image, buildCrop: Image, id: string, score: PairScore): Image {
	const gap = 16;
	const pad = 12;
	const maxW = 700;
	const a = fit(compCrop, maxW, 700, true);
	const b = resize(buildCrop, a.width, a.height);
	const out = createImage(a.width * 2 + gap + pad * 2, a.height + pad * 2 + 30, [24, 24, 28, 255]);

	blit(out, a, pad, pad + 30);
	blit(out, b, pad + a.width + gap, pad + 30);
	const v = verdictFor(score);
	drawLabel(out, `${id.toUpperCase()}  COMP`, pad, pad, { scale: 2 });
	drawLabel(out, `BUILD  ${v.toUpperCase()} ${(score.overall * 100).toFixed(0)}%`, pad + a.width + gap, pad, { scale: 2, bg: HEAT_LABEL[v] });
	return out;
}

/** A region's measured result. */
interface RegionResult extends ResolvedRegion {
	readonly score: PairScore;
	readonly verdict: Verdict;
	readonly inkBox: { comp: ReturnType<typeof inkBox>; build: ReturnType<typeof inkBox> };
	readonly _a: Image;
	readonly _b: Image;
}

/** Everything one comparison found. */
interface CompareResult {
	readonly label: string;
	readonly align: string;
	readonly whole: PairScore;
	readonly regions: RegionResult[];
	readonly aligned: Image;
	readonly alignedShifted: Image;
	readonly shift: { dx: number; dy: number; score: number };
	readonly compPalette: ReturnType<typeof dominantColors>;
	readonly buildPalette: ReturnType<typeof dominantColors>;
}

function strip(s: PairScore & { _detail?: unknown; _bands?: unknown }): PairScore {
	const { _detail, _bands, ...rest } = s;
	return rest;
}

/**
 * Compare a build screenshot against its comp.
 *
 * Region crops are taken at fixed boxes, so a small global offset would read every thin region as
 * contradicted while the whole-image search forgives it. The best translation is found once and the
 * region crops read a shifted copy; the whole score above stays as measured, and the side-by-side
 * and heatmap show the build as captured, because a padded "letterbox" there read as a defect in
 * every human review.
 */
function compare({ comp, build, spec = null, align = "top", label = "", kind = null }: { readonly comp: Image; readonly build: Image; readonly spec?: SpecLike | null; readonly align?: string; readonly label?: string; readonly kind?: string | null }): CompareResult {
	const captured = alignBuild(comp, build, align);
	const whole = scorePair(comp, captured, kind);

	let aligned = captured;
	const shift = bestShift(comp, captured);
	if (shift.dx || shift.dy) {
		const shifted = createImage(captured.width, captured.height, [255, 255, 255, 255]);
		blit(shifted, captured, -shift.dx, -shift.dy);
		aligned = shifted;
	}

	const regions: RegionResult[] = resolveRegions(comp, spec).map((r) => {
		const a = regionCrop(comp, r);
		const b = regionCrop(aligned, r);
		const s = scorePair(a, b, r.kind);
		return { ...r, score: strip(s), verdict: verdictFor(s, r.kind), inkBox: { comp: inkBox(a), build: inkBox(b) }, _a: a, _b: b };
	});

	return {
		label,
		align,
		whole: strip(whole),
		regions,
		aligned: captured,
		alignedShifted: aligned,
		shift,
		compPalette: dominantColors(comp),
		buildPalette: dominantColors(aligned),
	};
}

/** Write the side-by-side, the heatmap and one pair per region; returns the paths written. */
function writeArtifacts(result: CompareResult, comp: Image, outDir: string): { sideBySide: string; heatmap: string; regionFiles: string[] } {
	fs.mkdirSync(path.join(outDir, "regions"), { recursive: true });

	const side = renderSideBySide(comp, result.aligned, result.label, result.whole);
	fs.writeFileSync(path.join(outDir, "side-by-side.png"), encodePng(side));
	fs.writeFileSync(path.join(outDir, "heatmap.png"), encodePng(renderHeatmap(comp, result.aligned)));

	const regionFiles: string[] = [];
	for (const r of result.regions) {
		const file = path.join(outDir, "regions", `${r.id}.png`);
		fs.writeFileSync(file, encodePng(renderRegionPair(r._a, r._b, r.id, r.score)));
		regionFiles.push(file);
	}

	return { sideBySide: path.join(outDir, "side-by-side.png"), heatmap: path.join(outDir, "heatmap.png"), regionFiles };
}

/** The report a build gate reads. */
interface DiffReport {
	readonly tool: string;
	readonly version: number;
	readonly createdAt: string;
	readonly [meta: string]: unknown;
	readonly align: string;
	readonly overall: number;
	readonly verdict: Verdict;
	readonly scores: PairScore;
	readonly palette: { comp: Array<{ hex: string; coverage: number }>; build: Array<{ hex: string; coverage: number }> };
	readonly regions: Array<Record<string, unknown>>;
	readonly files: { sideBySide: string; heatmap: string; regionFiles: string[] } | null;
}

function buildReport(
	result: CompareResult,
	files: { sideBySide: string; heatmap: string; regionFiles: string[] } | null,
	meta: Record<string, unknown>,
): DiffReport {
	return {
		tool: "comp-diff",
		version: 1,
		createdAt: new Date().toISOString(),
		...meta,
		align: result.align,
		overall: result.whole.overall,
		verdict: verdictFor(result.whole),
		scores: result.whole,
		palette: {
			comp: result.compPalette.map(({ hex, coverage }) => ({ hex, coverage })),
			build: result.buildPalette.map(({ hex, coverage }) => ({ hex, coverage })),
		},
		regions: result.regions.map(({ _a, _b, ...r }) => r as unknown as Record<string, unknown>),
		files,
	};
}

/** The compact report a session reads instead of the JSON. */
function summarize(report: DiffReport): string {
	const lines: string[] = [];
	lines.push(
		`COMP-DIFF ${report.label ? `[${report.label}] ` : ""}overall ${(report.overall * 100).toFixed(0)}% (${report.verdict}) structure ${(report.scores.structure * 100).toFixed(0)}% color ${(report.scores.color * 100).toFixed(0)}% detail ${(report.scores.detail * 100).toFixed(0)}% bands ${(report.scores.bands * 100).toFixed(0)}%`,
	);
	lines.push(`PALETTE comp ${report.palette.comp.slice(0, 5).map((c) => `${c.hex}(${Math.round(c.coverage * 100)}%)`).join(" ")}`);
	lines.push(`PALETTE build ${report.palette.build.slice(0, 5).map((c) => `${c.hex}(${Math.round(c.coverage * 100)}%)`).join(" ")}`);

	const regions = report.regions as Array<{ id: string; verdict: string; score: PairScore }>;
	for (const r of regions) {
		lines.push(
			`REGION ${r.id.padEnd(18)} ${r.verdict.padEnd(12)} ${(r.score.overall * 100).toFixed(0).padStart(3)}%  structure ${(r.score.structure * 100).toFixed(0).padStart(3)}%  color ${(r.score.color * 100).toFixed(0).padStart(3)}%  detail ${(r.score.detail * 100).toFixed(0).padStart(3)}%${r.score.detailAdded > 0.25 ? "  +invented detail" : ""}`,
		);
	}

	if (report.files) {
		lines.push(`FILES side-by-side ${report.files.sideBySide}`);
		lines.push(`FILES heatmap ${report.files.heatmap}`);
		lines.push(`FILES regions ${report.files.regionFiles.length} under ${path.dirname(report.files.regionFiles[0] || report.files.heatmap)}`);
	}

	const worst = [...regions].sort((a, b) => a.score.overall - b.score.overall).slice(0, 3);
	if (worst.length > 0) lines.push(`WORST ${worst.map((r) => `${r.id} (${r.verdict}, ${(r.score.overall * 100).toFixed(0)}%)`).join("; ")}`);
	lines.push("OPEN the side-by-side and the worst region pairs before deciding anything; the numbers rank, the crops decide.");
	return lines.join("\n");
}

/**
 * A whole comparison step for a host that already has the pixels: compare, optionally write the
 * artifacts, and return the report plus the text a session reads.
 */
function diffBuilds({
	comp,
	build,
	spec = null,
	align = "top",
	label = "",
	kind = null,
	outDir = null,
	meta = {},
}: {
	readonly comp: Image;
	readonly build: Image;
	readonly spec?: SpecLike | null;
	readonly align?: string;
	readonly label?: string;
	readonly kind?: string | null;
	readonly outDir?: string | null;
	readonly meta?: Record<string, unknown>;
}): { report: DiffReport; text: string } {
	const result = compare({ comp, build, spec, align, label, kind });
	const files = outDir ? writeArtifacts(result, comp, outDir) : null;
	const report = buildReport(result, files, { label, ...meta });
	return { report, text: summarize(report) };
}

export {
	alignBuild,
	bestShift,
	buildReport,
	compare,
	diffBuilds,
	DIRECTION_KINDS,
	HEAT_LABEL,
	inkBox,
	readPng,
	regionCrop,
	renderHeatmap,
	renderRegionPair,
	renderSideBySide,
	resolveRegions,
	scorePair,
	strip,
	summarize,
	verdictFor,
	WEIGHTS,
	writeArtifacts,
};
export type { CompareResult, DiffReport, PairScore, RegionResult, ResolvedRegion, SpecLike, Verdict, Weights };
