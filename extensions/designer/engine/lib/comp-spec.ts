/**
 * The comp spec: turning a comp image plus a regions file into the measured record every later build
 * gate reads. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * Most of this file is refusal. A regions file that omits the comp's callouts, files a drawing as
 * chrome, covers a third of the page as one "section", or boxes a plate through its own artwork is
 * a spec that was never wrong on paper — it is a build that fails four gates later with no way to
 * tell why. Each of those is caught here, where the fix is one word.
 */
import fs from "node:fs";
import path from "node:path";
import { crop, drawLabel, fillRect, resize, type Image } from "./raster.ts";
import { detailGrid, dominantColors, horizontalBands } from "./image-metrics.ts";

const BUILD_DIR = path.join(".impeccable", "build");
const SPEC_PATH = path.join(BUILD_DIR, "spec.json");
const GRID_PATH = path.join(BUILD_DIR, "comp-grid.png");
const PLATES_DIR = path.join("assets", "plates");

/** Kinds that ship as a raster asset rather than as drawn code. */
const RASTER_KINDS: ReadonlySet<string> = new Set(["plate", "image", "texture"]);

/** Every kind a region can declare. */
const KINDS: ReadonlySet<string> = new Set(["plate", "image", "texture", "text", "control", "chrome", "band"]);

const COLS = "ABCDEFGHIJ";

/** Words in a region note that name painted material rather than code-drawn UI. */
const PAINTED_NOTE =
	/\b(diagram|drawing|drawn|illustration|illustrations|illustrated|figure|schematic|exploded|photo|photos|photograph\w*|picture|painting|painted|render|rendered|rendering|artwork|engraving|etching|linework|line art|texture|textured|textures|grain|fabric|halftone|watercolou?r|sketch|sketched|blueprint|geometry|leader lines?|callout lines?|thumbnail|silhouette|product shot|hero image|3d)\b/i;

/** A text, control or chrome region larger than this fraction of the comp is a column, not an element. */
const MAX_CODE_REGION_AREA = 0.25;

/** Fraction of an edge's length the artwork's dark mass has to touch to count as running off the box. */
const EDGE_CONTACT_MIN = 0.35;

/** A normalized box on the comp. */
interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A box in pixels. */
interface Px {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A palette entry with its share of the crop. */
interface PaletteEntry {
	readonly hex: string;
	readonly coverage: number;
}

/** "E0:J4" into a normalized box (an inclusive cell span on a 10×10 grid). */
function gridToBox(span: string): Box {
	const m = /^([A-J])(\d):([A-J])(\d)$/i.exec(String(span).trim());
	if (!m) throw new Error(`grid span "${span}" is not <colrow>:<colrow>, e.g. E0:J4`);

	const c0 = COLS.indexOf(m[1].toUpperCase());
	const r0 = Number(m[2]);
	const c1 = COLS.indexOf(m[3].toUpperCase());
	const r1 = Number(m[4]);
	const x0 = Math.min(c0, c1);
	const x1 = Math.max(c0, c1);
	const y0 = Math.min(r0, r1);
	const y1 = Math.max(r0, r1);
	return { x: x0 / 10, y: y0 / 10, w: (x1 - x0 + 1) / 10, h: (y1 - y0 + 1) / 10 };
}

/** The comp with a labeled 10×10 grid drawn over it, for naming regions by eye. */
function renderGrid(comp: Image): Image {
	const targetW = Math.min(1536, comp.width);
	const img = resize(comp, targetW, Math.round((comp.height / comp.width) * targetW));
	const cw = img.width / 10;
	const ch = img.height / 10;
	const line = [255, 40, 40, 200];

	for (let i = 1; i < 10; i++) {
		fillRect(img, Math.round(i * cw), 0, 1, img.height, line);
		fillRect(img, 0, Math.round(i * ch), img.width, 1, line);
	}
	for (let r = 0; r < 10; r++) {
		for (let c = 0; c < 10; c++) {
			drawLabel(img, `${COLS[c]}${r}`, Math.round(c * cw) + 3, Math.round(r * ch) + 3, { scale: 2, bg: [0, 0, 0, 170], fg: [255, 230, 120, 255] });
		}
	}
	return img;
}

function paletteOf(img: Image): PaletteEntry[] {
	return dominantColors(img, 5).map(({ hex, coverage }) => ({ hex, coverage }));
}

/**
 * Which edges of a plate crop the artwork touches.
 *
 * "Artwork" is the region's non-ground mass: pixels far from the crop's median gray. A margin of
 * paper along an edge means the shape ends inside the box; a long run of ink along it means the
 * shape continues past it.
 */
function artworkTouchesEdges(img: Image, { contact = EDGE_CONTACT_MIN, band = 2, ground = null }: { readonly contact?: number; readonly band?: number; readonly ground?: number | null } = {}): string[] {
	const W = img.width;
	const H = img.height;
	const gray = new Float32Array(W * H);
	for (let i = 0, j = 0; i < img.data.length; i += 4, j++) gray[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];

	// The ground is the page's, not the crop's: a region that is mostly a black arch on paper has a
	// mid-gray median and every edge would read as ink.
	let groundLevel = ground;
	if (groundLevel == null) {
		const sample: number[] = [];
		for (let i = 0; i < gray.length; i += Math.max(1, Math.floor(gray.length / 5000))) sample.push(gray[i]);
		sample.sort((a, b) => a - b);
		groundLevel = sample[Math.floor(sample.length / 2)];
	}

	const ink = (x: number, y: number) => Math.abs(gray[y * W + x] - groundLevel) > 60;
	const sides: string[] = [];

	// The longest contiguous run of ink along the edge, as a fraction of it: an arch cut by the box
	// leaves a long unbroken contact; grain, a rule crossing, or a line of small type leave short ones.
	const run = (n: number, at: (i: number) => boolean) => {
		let best = 0;
		let cur = 0;
		for (let i = 0; i < n; i++) {
			if (at(i)) {
				cur++;
				if (cur > best) best = cur;
			} else {
				cur = 0;
			}
		}
		return best / n;
	};

	if (run(H, (y) => { for (let x = 0; x < band; x++) if (ink(x, y)) return true; return false; }) >= contact) sides.push("left");
	if (run(H, (y) => { for (let x = W - band; x < W; x++) if (ink(x, y)) return true; return false; }) >= contact) sides.push("right");
	if (run(W, (x) => { for (let y = 0; y < band; y++) if (ink(x, y)) return true; return false; }) >= contact) sides.push("top");
	if (run(W, (x) => { for (let y = H - band; y < H; y++) if (ink(x, y)) return true; return false; }) >= contact) sides.push("bottom");
	return sides;
}

/**
 * Shrink a normalized box to the ink inside it, padded, never grown.
 *
 * The bounding box of all ink cannot shed a neighbour that shares the span — a spine at the left
 * edge, the next column's text at the right — so the largest connected ink mass wins instead. A
 * mass touching the span's left or right edge continues past it, and an inside mass is preferred
 * unless the edge mass is far heavier.
 */
function snapBoxToInk(comp: Image, box: Box, ground: number, { pad = 6, minShrink = 0.06 }: { readonly pad?: number; readonly minShrink?: number } = {}): Box | null {
	const px = { x: Math.round(box.x * comp.width), y: Math.round(box.y * comp.height), w: Math.round(box.w * comp.width), h: Math.round(box.h * comp.height) };
	if (px.w < 8 || px.h < 8) return null;

	const c = crop(comp, px.x, px.y, px.w, px.h);
	const W = c.width;
	const H = c.height;
	let x0 = W;
	let y0 = H;
	let x1 = -1;
	let y1 = -1;

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const g = 0.299 * c.data[i] + 0.587 * c.data[i + 1] + 0.114 * c.data[i + 2];
			if (Math.abs(g - ground) > 60) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return null;

	const cell = Math.max(6, Math.round(Math.min(W, H) / 40));
	const cw = Math.ceil(W / cell);
	const ch = Math.ceil(H / cell);
	const on = new Uint8Array(cw * ch);
	const cnt = new Uint16Array(cw * ch);

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const g = 0.299 * c.data[i] + 0.587 * c.data[i + 1] + 0.114 * c.data[i + 2];
			if (Math.abs(g - ground) > 60) cnt[Math.floor(y / cell) * cw + Math.floor(x / cell)]++;
		}
	}
	for (let i = 0; i < on.length; i++) on[i] = cnt[i] >= cell * cell * 0.04 ? 1 : 0;

	// Dilate by one cell so the letters of a word and the lines of a block join into one mass; a
	// neighbouring column a few cells away stays apart.
	const mask = new Uint8Array(on.length);
	for (let y = 0; y < ch; y++) {
		for (let x = 0; x < cw; x++) {
			if (!on[y * cw + x]) continue;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) mask[ny * cw + nx] = 1;
				}
			}
		}
	}

	const label = new Int32Array(cw * ch).fill(-1);
	let best: { n: number; bx0: number; by0: number; bx1: number; by1: number; touchesSide: boolean } | null = null;

	for (let s0 = 0; s0 < on.length; s0++) {
		if (!mask[s0] || label[s0] >= 0) continue;

		const stack = [s0];
		label[s0] = s0;
		let n = 0;
		let bx0 = cw;
		let by0 = ch;
		let bx1 = -1;
		let by1 = -1;

		while (stack.length) {
			const k = stack.pop() as number;
			const kx = k % cw;
			const ky = (k / cw) | 0;
			if (on[k]) {
				n += cnt[k];
				if (kx < bx0) bx0 = kx;
				if (kx > bx1) bx1 = kx;
				if (ky < by0) by0 = ky;
				if (ky > by1) by1 = ky;
			}
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = kx + dx;
					const ny = ky + dy;
					if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
					const nk = ny * cw + nx;
					if (mask[nk] && label[nk] < 0) {
						label[nk] = s0;
						stack.push(nk);
					}
				}
			}
		}

		const touchesSide = bx0 === 0 || bx1 === cw - 1;
		const cand = { n, bx0, by0, bx1, by1, touchesSide };
		if (!best) best = cand;
		else if (best.touchesSide && !cand.touchesSide && cand.n * 3 >= best.n) best = cand;
		else if (!best.touchesSide && cand.touchesSide && cand.n < best.n * 3) {
			// Keep the inside mass.
		} else if (cand.n > best.n) best = cand;
	}

	if (best) {
		x0 = best.bx0 * cell;
		y0 = best.by0 * cell;
		x1 = Math.min(W - 1, (best.bx1 + 1) * cell - 1);
		y1 = Math.min(H - 1, (best.by1 + 1) * cell - 1);
	}

	const nx0 = Math.max(0, x0 - pad);
	const ny0 = Math.max(0, y0 - pad);
	const nx1 = Math.min(W, x1 + 1 + pad);
	const ny1 = Math.min(H, y1 + 1 + pad);
	const shrink = 1 - ((nx1 - nx0) * (ny1 - ny0)) / (W * H);
	if (shrink < minShrink) return null;

	return { x: (px.x + nx0) / comp.width, y: (px.y + ny0) / comp.height, w: (nx1 - nx0) / comp.width, h: (ny1 - ny0) / comp.height };
}

/** The page's ground level, sampled rather than averaged. */
function medianGray(img: Image): number {
	const sample: number[] = [];
	const step = Math.max(1, Math.floor((img.width * img.height) / 6000));
	for (let j = 0; j < img.width * img.height; j += step) {
		const i = j * 4;
		sample.push(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]);
	}
	sample.sort((a, b) => a - b);
	return sample[Math.floor(sample.length / 2)];
}

function energyOf(img: Image): number {
	const g = detailGrid(img, 4, 4, 256);
	let s = 0;
	for (const v of g.cells) s += v;
	return s / g.cells.length;
}

/** A region as the regions file declares it. */
interface RegionInput {
	readonly id?: string;
	readonly kind?: string;
	readonly note?: string;
	readonly grid?: string;
	readonly box?: Box;
	readonly snap?: boolean;
	readonly codeDrawn?: boolean;
	readonly container?: boolean;
	readonly bleed?: boolean;
	readonly medium?: string;
	readonly plate?: string;
	readonly text?: string;
}

/** A region as the spec records it. */
interface SpecRegion {
	readonly id: string;
	readonly kind: string;
	readonly note: string | null;
	readonly grid: string | null;
	readonly codeDrawn?: true;
	readonly container?: true;
	readonly bleed?: true;
	readonly snap?: false;
	readonly coverBox?: Box;
	readonly box: Box;
	readonly px: Px;
	readonly aspect: number;
	readonly palette: PaletteEntry[];
	readonly detail: { energy: number };
	readonly medium: string;
	readonly clipped?: string[];
	readonly plate: string | null;
	readonly text: string | null;
}

/** The measured spec. */
interface CompSpec {
	readonly tool: string;
	readonly version: number;
	readonly createdAt: string;
	readonly comp: string;
	readonly warnings: string[];
	readonly uncoveredInkCells: string[];
	readonly compSize: { width: number; height: number };
	readonly aspect: number;
	readonly orientation: "landscape" | "portrait";
	readonly palette: PaletteEntry[];
	readonly bands: Array<{ y: number; strength: number }>;
	readonly regions: SpecRegion[];
}

/**
 * Grid cells that carry ink the regions do not name.
 *
 * A regions file that omits the comp's callouts, a notes block or a parts table makes those elements
 * invisible to every later gate — they are never "missing" if they were never named. Texture and
 * band regions do not cover, because a full-bleed paper texture names the ground, not the drawing on
 * it.
 */
function uncoveredInkCells(comp: Image, regions: ReadonlyArray<{ readonly kind: string; readonly box: Box; readonly coverBox?: Box }>): string[] {
	const grid = detailGrid(comp, 10, 10, 512);
	const cells: string[] = [];

	// The ground's own energy (paper grain, a gradient) is the quietest tenth of cells; ink is
	// anything clearly above that. A median-relative threshold fails on textured comps where every
	// cell carries grain.
	const energies = [...grid.cells].sort((a, b) => a - b);
	const ground = energies[Math.floor(energies.length * 0.1)] || 0;
	const threshold = Math.max(4, ground * 2.2, ground + 12);

	for (let r = 0; r < 10; r++) {
		for (let c = 0; c < 10; c++) {
			const e = grid.cells[r * 10 + c];
			if (e < threshold) continue;
			const cx = (c + 0.5) / 10;
			const cy = (r + 0.5) / 10;
			const covered = regions.some((reg) => {
				const b = reg.coverBox ?? reg.box;
				return reg.kind !== "texture" && reg.kind !== "band" && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
			});
			if (!covered) cells.push(`${COLS[c]}${r}`);
		}
	}
	return cells;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Measure every region against the comp, or refuse.
 *
 * Each refusal names the region and what to do about it, because the person reading it is one word
 * away from a spec that builds.
 */
function measureRegions(comp: Image, regionsInput: { regions?: readonly RegionInput[]; allowUncovered?: boolean }, compPath: string): CompSpec {
	const regions: SpecRegion[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();
	const pageGround = medianGray(comp);

	for (const raw of regionsInput.regions || []) {
		if (!raw.id) throw new Error("every region needs an id");
		if (seen.has(raw.id)) throw new Error(`duplicate region id ${raw.id}`);
		seen.add(raw.id);

		const kind = raw.kind && KINDS.has(raw.kind) ? raw.kind : "band";

		// Every region says what it is. The note drives the plate prompt and the gate messages, and a
		// drawing named as chrome is only caught by what its note says.
		if (kind !== "band" && !(raw.note && String(raw.note).trim().length >= 8)) {
			throw new Error(
				`region ${raw.id} has no note. Say in a few words what the comp shows there (the element, its material, its role): the note drives the plate prompt and the gate's messages, and a drawing named as chrome is only caught by what its note says.`,
			);
		}

		// A note that names painted material filed under a code kind is a plate about to be redrawn in
		// SVG. Refuse here, where the fix is one word, not at the hero gate.
		for (const key of ["codeDrawn", "container", "bleed"] as const) {
			if (raw[key]) {
				warnings.push(
					`region ${raw.id}: "${key}": true set in the regions file${
						key === "codeDrawn"
							? " (the painted-material refusal is overridden: code draws this region)"
							: key === "container"
								? " (the region-size refusal is overridden: one undivided element)"
								: " (the clipped-artwork refusal is overridden: the page crops it there)"
					}`,
				);
			}
		}

		if (raw.note && !RASTER_KINDS.has(kind) && kind !== "band" && PAINTED_NOTE.test(raw.note) && !raw.codeDrawn) {
			throw new Error(
				`region ${raw.id} is kind "${kind}" but its note describes painted material ("${raw.note}"). Anything drawn, photographed, or textured ships as a raster plate: set kind to plate (illustration, diagram, figure), image (photograph), or texture (ground). If the note is wrong and code really draws it (a table, a rule, a chrome bar), reword the note or set "codeDrawn": true on the region.`,
			);
		}

		let box: Box = raw.box && typeof raw.box.x === "number" ? raw.box : gridToBox(raw.grid as string);

		// A grid span over-covers, and every measurement downstream inherits the slop. Text and control
		// regions snap to the ink inside their span; plates, textures, chrome, and any region given an
		// explicit box are left as drawn. The grid stays on the record.
		let coverBox: Box | null = null;
		if (!raw.box && raw.grid && (kind === "text" || kind === "control") && raw.snap !== false) {
			const snapped = snapBoxToInk(comp, box, pageGround);
			if (snapped) {
				coverBox = box;
				box = snapped;
			}
		}

		// A code region is one element the page draws. One covering a third of the comp is a column,
		// and a column scored as one region hides everything inside it.
		const area = box.w * box.h;
		if (!RASTER_KINDS.has(kind) && kind !== "band" && area > MAX_CODE_REGION_AREA && !raw.container) {
			throw new Error(
				`region ${raw.id} (${kind}) covers ${Math.round(area * 100)}% of the comp; a code region is one element (a headline, a table, a control, a rule, a bar), and one this large is a column holding several. Name each element inside it as its own region (every illustration or photo as a plate), or set "container": true on the region if it truly is one undivided element.`,
			);
		}

		const px = { x: Math.round(box.x * comp.width), y: Math.round(box.y * comp.height), w: Math.round(box.w * comp.width), h: Math.round(box.h * comp.height) };
		const c = crop(comp, px.x, px.y, px.w, px.h);
		const energy = energyOf(c);
		const raster = RASTER_KINDS.has(kind);

		// A plate box that cuts through its own artwork is a plate the page will crop, and sides on the
		// comp's own edge do not count because the comp crops there too.
		const atCompEdge = {
			left: px.x <= 1,
			top: px.y <= 1,
			right: px.x + px.w >= comp.width - 1,
			bottom: px.y + px.h >= comp.height - 1,
		};
		const clipped = raster && kind !== "texture" && !raw.bleed
			? artworkTouchesEdges(c, { ground: pageGround }).filter((side) => !(atCompEdge as Record<string, boolean>)[side])
			: [];
		if (clipped.length > 0) {
			warnings.push(
				`region ${raw.id}: the artwork runs off the box on the ${clipped.join(" and ")} (its ink reaches the edge over ${EDGE_CONTACT_MIN * 100}% of that side). Widen the region so the box holds the whole shape with a margin; a plate placed with object-fit: cover on this box would be cut there.`,
			);
		}

		regions.push({
			id: raw.id,
			kind,
			note: raw.note || null,
			grid: raw.grid || null,
			codeDrawn: raw.codeDrawn ? true : undefined,
			container: raw.container ? true : undefined,
			bleed: raw.bleed ? true : undefined,
			snap: raw.snap === false ? false : undefined,
			coverBox: coverBox ? { x: r4(coverBox.x), y: r4(coverBox.y), w: r4(coverBox.w), h: r4(coverBox.h) } : undefined,
			box: { x: r4(box.x), y: r4(box.y), w: r4(box.w), h: r4(box.h) },
			px,
			aspect: r4(px.w / px.h),
			palette: paletteOf(c),
			detail: { energy: r4(energy) },
			medium: raw.medium || (raster ? "raster" : "semantic"),
			clipped: clipped.length > 0 ? clipped : undefined,
			plate: raster ? raw.plate || path.join(PLATES_DIR, `${raw.id}.png`) : null,
			text: raw.text || null,
		});
	}

	const uncovered = uncoveredInkCells(comp, regions);
	if (uncovered.length > 3 && !regionsInput.allowUncovered) {
		throw new Error(
			`grid cells ${uncovered.join(", ")} carry ink no region names. Every element the comp shows must be in a region (text, control, chrome, or a plate) so its absence in the build can be measured; add regions for them, or set "allowUncovered": true in the regions file after confirming those cells are empty ground.`,
		);
	}

	return {
		tool: "comp-spec",
		version: 1,
		createdAt: new Date().toISOString(),
		comp: compPath,
		warnings,
		uncoveredInkCells: uncovered,
		compSize: { width: comp.width, height: comp.height },
		aspect: r4(comp.width / comp.height),
		orientation: comp.width >= comp.height ? "landscape" : "portrait",
		palette: paletteOf(comp),
		bands: horizontalBands(comp)
			.filter((b) => b.strength > 0.2)
			.map((b) => ({ y: r4(b.y), strength: r4(b.strength) })),
		regions,
	};
}

/** Propose regions from the comp's bands when no regions file exists yet. */
function autoRegions(comp: Image): { regions: Array<{ id: string; kind: string; box: Box }> } {
	const bands = horizontalBands(comp).filter((b) => b.strength > 0.2);
	const cuts = [0, ...bands.map((b) => b.y), 1].filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.06);
	if (cuts[cuts.length - 1] !== 1) cuts.push(1);

	const regions: Array<{ id: string; kind: string; box: Box }> = [];
	for (let i = 0; i + 1 < cuts.length; i++) regions.push({ id: `band-${i + 1}`, kind: "band", box: { x: 0, y: cuts[i], w: 1, h: cuts[i + 1] - cuts[i] } });
	return { regions };
}

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
	return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/**
 * The comp crop of a raster region, with every overlapping semantic region painted out in the
 * crop's own ground colour.
 *
 * The plate prompt tells the generator to remove UI text and chrome, so a plate has to be scored
 * against a crop that has them removed too; otherwise it loses structure points for obeying the spec.
 */
function plateReference(comp: Image, spec: CompSpec, region: SpecRegion): Image {
	const c = crop(comp, region.px.x, region.px.y, region.px.w, region.px.h);
	const ground = (region.palette?.[0] && hexToRgb(region.palette[0].hex)) || [255, 255, 255];

	for (const other of spec.regions || []) {
		if (other.id === region.id || RASTER_KINDS.has(other.kind) || other.kind === "band") continue;
		const ox = Math.max(0, other.px.x - region.px.x);
		const oy = Math.max(0, other.px.y - region.px.y);
		const ox2 = Math.min(region.px.w, other.px.x + other.px.w - region.px.x);
		const oy2 = Math.min(region.px.h, other.px.y + other.px.h - region.px.y);
		if (ox2 <= ox || oy2 <= oy) continue;
		fillRect(c, ox, oy, ox2 - ox, oy2 - oy, [...ground, 255]);
	}
	return c;
}

/** The regeneration prompt for a raster region. */
function platePrompt(spec: CompSpec, region: SpecRegion): string {
	const world = spec.palette.slice(0, 3).map((c) => c.hex).join(", ");
	const kindLine =
		region.kind === "texture"
			? "This is a seamless surface texture. Output a tileable texture plate with no objects, no text, no vignette."
			: region.kind === "image"
				? "This is a photographic or illustrated image region. Output the same subject, same framing, same lighting."
				: "This is a designed illustration plate. Output the same drawing, same style, same line weight and shading.";

	return [
		"Use the provided crop as the approved visual reference and recreate it as a clean production asset at the target aspect ratio.",
		kindLine,
		`Preserve silhouette, composition, perspective, palette (${world}), lighting, material, and texture exactly.`,
		"Remove every piece of UI text, label, caption, button, and interface chrome that is not part of the artwork itself.",
		"Remove letterboxing, borders, card corners, drop shadows, and any layout background that the page will draw in code.",
		"Do not add objects. Do not change the concept. Do not restyle. The artwork fills the whole frame edge to edge at the same scale as the reference; no margins, no border, no background band.",
		region.note ? `Region: ${region.note}.` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** The compact spec a session reads instead of the JSON. */
function printSpec(spec: CompSpec): string {
	const lines: string[] = [];
	lines.push(`SPEC comp ${spec.comp} ${spec.compSize.width}x${spec.compSize.height} ${spec.orientation}`);
	lines.push(`PALETTE ${spec.palette.map((c) => `${c.hex}(${Math.round(c.coverage * 100)}%)`).join(" ")}`);
	lines.push(`BANDS ${spec.bands.map((b) => `${Math.round(b.y * 100)}%`).join(" ") || "none"}`);

	for (const r of spec.regions) {
		const b = r.box;
		lines.push(
			`REGION ${r.id.padEnd(18)} ${r.kind.padEnd(8)} ${r.medium.padEnd(8)} box x${Math.round(b.x * 100)}% y${Math.round(b.y * 100)}% w${Math.round(b.w * 100)}% h${Math.round(b.h * 100)}% (${r.px.w}x${r.px.h}px, ${r.aspect}:1) palette ${r.palette.slice(0, 3).map((c) => c.hex).join(" ")}${r.plate ? ` plate ${r.plate}` : ""}${r.note ? `  # ${r.note}` : ""}`,
		);
	}

	const plates = spec.regions.filter((r) => r.medium === "raster");
	lines.push(`PLATES ${plates.length} to produce: ${plates.map((r) => r.id).join(", ") || "none"}`);
	for (const w of spec.warnings || []) lines.push(`WARN ${w}`);
	lines.push("RULE anything not in this list does not exist on the page: no borders, rules, chrome, or containers the comp does not show. Every raster region ships as its plate, never as CSS.");
	return lines.join("\n");
}

/** Read a spec, or null when there is none yet. */
function loadSpec(specPath: string = SPEC_PATH): CompSpec | null {
	if (!fs.existsSync(specPath)) return null;
	return JSON.parse(fs.readFileSync(specPath, "utf8")) as CompSpec;
}

export {
	artworkTouchesEdges,
	autoRegions,
	BUILD_DIR,
	EDGE_CONTACT_MIN,
	energyOf,
	GRID_PATH,
	gridToBox,
	hexToRgb,
	KINDS,
	loadSpec,
	MAX_CODE_REGION_AREA,
	measureRegions,
	medianGray,
	PAINTED_NOTE,
	PLATES_DIR,
	platePrompt,
	plateReference,
	printSpec,
	RASTER_KINDS,
	renderGrid,
	r4,
	snapBoxToInk,
	SPEC_PATH,
	uncoveredInkCells,
};
export type { Box, CompSpec, PaletteEntry, Px, RegionInput, SpecRegion };
