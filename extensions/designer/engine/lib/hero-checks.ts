/**
 * Hero-gate checks that name a miss as a number a model can act on. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The region scores say a text block drifted; these say the headline renders at cap 78px where the
 * comp's is 103, wraps to four lines where the comp has three, sets #2a2a2a where the comp sets
 * #a72f1b, or starts sixty pixels lower in its box. Every one of those was a finding in a human
 * review of a build the region scores had already let through.
 *
 * Pure functions over decoded rasters, the spec and the artifact source; a caller wires them and
 * decides what vetoes.
 */
import { fingerprint, type Fingerprint } from "./font-fingerprint.ts";
import { crop, type Image } from "./raster.ts";
import { deltaE, detailGrid, dominantColors, type DominantColor } from "./image-metrics.ts";
import { inkBox } from "./comp-diff.ts";

/** The ink colour a reading found: the ground cluster and the heaviest cluster that is not it. */
interface InkColor {
	readonly ground: DominantColor;
	readonly ink: DominantColor | null;
}

/** Dominant ink colour of a crop: the heaviest cluster that is not the ground. */
function inkColor(img: Image): InkColor | null {
	const colors = dominantColors(img, 4);
	if (colors.length === 0) return null;
	const ground = colors[0];
	const ink = colors.find((c) => c !== ground && deltaE(c.lab, ground.lab) > 20) ?? null;
	return { ground, ink };
}

/** What a check found, and the numbers it found them with. */
interface CheckResult {
	readonly findings?: string[];
	readonly metrics?: Record<string, unknown> | null;
	readonly sides?: string[];
	readonly comp?: unknown;
	readonly build?: unknown;
}

/** A spec region, as these checks read it. */
interface CheckRegion {
	readonly id: string;
	readonly kind?: string;
	readonly type?: { readonly chosen?: { readonly family: string; readonly weight: number | string; readonly fontSizePx: number | string } };
}

/**
 * Compare one text region's build crop against the comp's own measurement.
 *
 * The comp is measured now rather than trusting the spec's stored reading: the spec may carry an
 * older fingerprint's numbers, and a check has to agree with itself on both sides.
 */
function textRegionCheck(region: CheckRegion, compCrop: Image, buildCrop: Image, { capTol = 0.22, minCap = 10 }: { readonly capTol?: number; readonly minCap?: number } = {}): CheckResult {
	const findings: string[] = [];
	const comp = fingerprint(compCrop);

	// Colour reads on any text region, measured or not: a spine set vertical came back white on red
	// where the comp had black on red, in five builds.
	const colourOnly = (): CheckResult => {
		const ca = inkColor(compCrop);
		const cb = inkColor(buildCrop);
		if (ca && cb && ca.ink && cb.ink && deltaE(ca.ink.lab, cb.ink.lab) > 22) {
			findings.push(`text ${region.id}: ink is ${cb.ink.hex} in the build, ${ca.ink.hex} in the comp; use the comp's colour`);
		}
		return { findings, metrics: null };
	};

	if (!comp || !comp.capHeightPx || (comp.capHeightPx as number) < minCap || (comp.glyphs as number) < 6) return colourOnly();
	// Rotated type reads as many short "lines" of one or two glyphs, and the fingerprint has nothing
	// to say about it.
	if ((comp.lines as number) >= 5 && (comp.glyphs as number) / (comp.lines as number) < 3) return colourOnly();
	// A cap taller than half the box is a drawing read as a glyph, not type.
	if ((comp.capHeightPx as number) > compCrop.height * 0.6) return colourOnly();

	const bfp = fingerprint(buildCrop);
	const metrics: Record<string, unknown> = {
		comp: { cap: comp.capHeightPx, lines: comp.lines, glyphs: comp.glyphs },
		build: bfp ? { cap: bfp.capHeightPx, lines: bfp.lines, glyphs: bfp.glyphs } : null,
	};
	if (!bfp || (bfp.glyphs as number) < 4) {
		// Nothing legible in the box: the region verdicts cover it.
		return { findings, metrics };
	}

	const capDelta = ((bfp.capHeightPx as number) - (comp.capHeightPx as number)) / (comp.capHeightPx as number);
	if (Math.abs(capDelta) > capTol) {
		const chosen = region.type?.chosen;
		findings.push(
			`text ${region.id}: cap height ${bfp.capHeightPx}px in the build, ${comp.capHeightPx}px in the comp (${capDelta > 0 ? "+" : ""}${Math.round(capDelta * 100)}%); set font-size so the cap height renders at ${comp.capHeightPx}px${chosen ? ` (font-match ranked ${chosen.family} ${chosen.weight} at ${chosen.fontSizePx}px)` : ""}`,
		);
	}

	if ((comp.lines as number) >= 2 && bfp.lines !== comp.lines && Math.abs((bfp.lines as number) - (comp.lines as number)) >= 1) {
		findings.push(
			`text ${region.id}: ${bfp.lines} line${bfp.lines === 1 ? "" : "s"} in the build, ${comp.lines} in the comp; the measure (max-width, font-size, letter-spacing) wraps it differently, so the block is a different shape`,
		);
	} else if ((comp.lines as number) >= 3 && bfp.lines === comp.lines && Math.abs(capDelta) <= capTol) {
		// Same lines at the same size: the leading is the remaining shape.
		const ba0 = inkBox(compCrop);
		const bb0 = inkBox(buildCrop);
		if (ba0 && bb0) {
			const pa = ba0.h / (comp.lines as number);
			const pb = bb0.h / (bfp.lines as number);
			const dp = (pb - pa) / pa;
			if (Math.abs(dp) > 0.2) {
				findings.push(
					`text ${region.id}: line pitch ${Math.round(pb)}px in the build, ${Math.round(pa)}px in the comp (${dp > 0 ? "+" : ""}${Math.round(dp * 100)}%); set line-height so ${comp.lines} lines stand ${Math.round(ba0.h)}px tall`,
				);
			}
		}
	}

	// Tracking: the gap between glyphs in cap units, when both sides read it.
	if (comp.gap != null && bfp.gap != null && Math.abs(capDelta) <= capTol && (comp.glyphs as number) >= 8 && (bfp.glyphs as number) >= 8) {
		const dg = (bfp.gap as number) - (comp.gap as number);
		if (Math.abs(dg) > Math.max(0.03, (comp.gap as number) * 0.5)) {
			findings.push(
				`text ${region.id}: letter-spacing is ${dg > 0 ? "wider" : "tighter"} than the comp's (gap ${(bfp.gap as number).toFixed(3)} vs ${(comp.gap as number).toFixed(3)} of the cap height); set letter-spacing to ${dg > 0 ? "close" : "open"} it by about ${Math.abs(Math.round(dg * (comp.capHeightPx as number)))}px`,
			);
		}
	}

	// Weight: ink density of tall glyphs, only when both sides have it and the sizes agree, because
	// density at a different cap is a different reading.
	if (comp.densTall != null && bfp.densTall != null && Math.abs(capDelta) <= capTol) {
		const r = (bfp.densTall as number) / (comp.densTall as number);
		if (r > 1.25) {
			findings.push(`text ${region.id}: the face renders ${Math.round((r - 1) * 100)}% heavier than the comp's (ink density ${(bfp.densTall as number).toFixed(2)} vs ${(comp.densTall as number).toFixed(2)}); drop a weight step or use the ranked face`);
		} else if (r < 0.75) {
			findings.push(`text ${region.id}: the face renders ${Math.round((1 - r) * 100)}% lighter than the comp's (ink density ${(bfp.densTall as number).toFixed(2)} vs ${(comp.densTall as number).toFixed(2)}); raise a weight step or use the ranked face`);
		}
	}

	// Colour: the dominant ink of each crop. Small type on a ruled or grainy ground has no reliable
	// ink cluster, and the reading fired both ways on neighbouring rows of one list.
	if ((comp.capHeightPx as number) >= 16) {
		const ca = inkColor(compCrop);
		const cb = inkColor(buildCrop);
		if (ca && cb && ca.ink && cb.ink && deltaE(ca.ink.lab, cb.ink.lab) > 22) {
			findings.push(`text ${region.id}: ink is ${cb.ink.hex} in the build, ${ca.ink.hex} in the comp; use the comp's colour`);
		}
	}

	// Vertical placement inside the box: the top of the ink.
	const ba = inkBox(compCrop);
	const bb = inkBox(buildCrop);
	if (ba && bb) {
		const dy = bb.y - ba.y;
		if (Math.abs(dy) > Math.max(12, compCrop.height * 0.15)) {
			findings.push(
				`text ${region.id}: its first line starts ${Math.abs(Math.round(dy))}px ${dy > 0 ? "lower" : "higher"} than in the comp (${bb.y}px vs ${ba.y}px into the region box); the spacing above it is ${dy > 0 ? "too large" : "too small"}`,
			);
		}
		const dx = bb.x - ba.x;
		if (Math.abs(dx) > Math.max(12, compCrop.width * 0.15)) {
			findings.push(`text ${region.id}: it starts ${Math.abs(Math.round(dx))}px ${dx > 0 ? "further right" : "further left"} than in the comp`);
		}
	}

	metrics.capDelta = Number(capDelta.toFixed(3));
	return { findings, metrics };
}

/** Rows of a crop that carry a horizontal rule, sorted top to bottom. */
function ruleRows(img: Image, { span = 0.5, step = 28 }: { readonly span?: number; readonly step?: number } = {}): number[] {
	const W = img.width;
	const H = img.height;
	const gray = (x: number, y: number) => {
		const i = (y * W + x) * 4;
		return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
	};

	const rows: number[] = [];
	for (let y = 1; y < H - 1; y++) {
		let strong = 0;
		for (let x = 0; x < W; x++) {
			const d = Math.max(Math.abs(gray(x, y) - gray(x, y - 1)), Math.abs(gray(x, y) - gray(x, y + 1)));
			if (d > step) strong++;
		}
		if (strong >= W * span) rows.push(y);
	}

	// Collapse adjacent rows into one edge.
	const out: number[] = [];
	for (const y of rows) if (out.length === 0 || y - out[out.length - 1] > 3) out.push(y);
	return out;
}

/**
 * A thin chrome region — a masthead, a nav bar, a footer strip — has a height, and its height is
 * where its rule sits. Compare the first horizontal rule's row; fall back to the ink extents when
 * neither has a rule.
 */
function chromeStripCheck(region: CheckRegion, compCrop: Image, buildCrop: Image): CheckResult {
	const findings: string[] = [];
	const strip = compCrop.height <= compCrop.width * 0.35;
	if (!strip) return { findings };

	// A control that is one link or one button, not a bar across its box, has no strip height to
	// compare: its underline once read as a "rule" for twenty-seven attempts in one session.
	if (region.kind === "control") {
		const ib = inkBox(compCrop);
		if (!ib || ib.w < compCrop.width * 0.6) return { findings };
	}

	const ra = ruleRows(compCrop);
	const rb = ruleRows(buildCrop);
	if (ra.length > 0 && rb.length > 0) {
		// The rule that closes the strip is the first from the top; a grid row often carries the next
		// element's top edge lower down.
		const ya = ra[0];
		const yb = rb[0];
		const dy = yb - ya;
		if (Math.abs(dy) > Math.max(5, compCrop.height * 0.06)) {
			findings.push(
				`${region.kind} ${region.id}: its rule sits ${ya}px into the box in the comp and ${yb}px in the build (${dy > 0 ? "+" : ""}${dy}px), so the strip is ${dy > 0 ? "taller" : "shorter"} than the comp's; match the height, not only the position`,
			);
		}
		return { findings, comp: ya, build: yb };
	}

	const ba = inkBox(compCrop);
	const bb = inkBox(buildCrop);
	if (!ba || !bb) return { findings };
	if (ba.w >= compCrop.width * 0.6 && ba.h <= compCrop.height * 0.6) {
		const dh = bb.h - ba.h;
		if (Math.abs(dh) > Math.max(10, ba.h * 0.25)) {
			findings.push(`${region.kind} ${region.id}: its ink is ${bb.h}px tall in the build and ${ba.h}px in the comp (${dh > 0 ? "+" : ""}${dh}px); match the height, not only the position`);
		}
	}
	return { findings, comp: ba, build: bb };
}

/** One cell where the build has ink the comp does not. */
interface InventedCell {
	readonly col: number;
	readonly row: number;
	readonly label: string;
	readonly comp: number;
	readonly build: number;
}

/**
 * Cells of the frame where the build carries ink and the comp is calm.
 *
 * `floor` is the comp energy under which a cell counts as calm; `added` is the build energy over
 * which the build counts as inked.
 */
function inventedInk(comp: Image, build: Image, { cols = 10, rows = 10, floor = 10, added = 12, ratio = 2.5 }: { readonly cols?: number; readonly rows?: number; readonly floor?: number; readonly added?: number; readonly ratio?: number } = {}): { cells: InventedCell[]; fraction: number } {
	const a = detailGrid(comp, cols, rows, 512);
	const b = detailGrid(build, cols, rows, 512);
	const cells: InventedCell[] = [];

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const i = r * cols + c;
			// Calm in the comp (grain, flat ground) and inked in the build well past what grain would
			// give: a kicker over paper, a divider, a nav row.
			if (!(a.cells[i] < floor && b.cells[i] > Math.max(added, a.cells[i] * ratio))) continue;

			// The comp must be calm around the cell too: a hard edge one pixel over the cell boundary
			// in the build would otherwise read as invented.
			let neighbourhood = 0;
			let n = 0;
			for (let dr = -1; dr <= 1; dr++) {
				for (let dc = -1; dc <= 1; dc++) {
					const rr = r + dr;
					const cc = c + dc;
					if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
					neighbourhood += a.cells[rr * cols + cc];
					n++;
				}
			}
			if (neighbourhood / n >= floor * 2) continue;

			cells.push({ col: c, row: r, label: `${String.fromCharCode(65 + c)}${r}`, comp: Number(a.cells[i].toFixed(1)), build: Number(b.cells[i].toFixed(1)) });
		}
	}
	return { cells, fraction: cells.length / (cols * rows) };
}

/**
 * A plate cropped by its box: the comp's artwork keeps a margin inside the region on some side and
 * the build's ink runs flush to that edge.
 *
 * A cover arch cut off at the left and bottom passed a hero gate at 87% in one sweep, and the human
 * review called it a bug in one word.
 */
function plateClipCheck(region: CheckRegion, compCrop: Image, buildCrop: Image, { margin = 6 }: { readonly margin?: number } = {}): CheckResult {
	const a = inkBox(compCrop);
	const b = inkBox(buildCrop);
	if (!a || !b) return { sides: [] };

	const W = compCrop.width;
	const H = compCrop.height;
	const sides: string[] = [];
	const flush = (v: number) => v <= 1;

	if (a.x >= margin && flush(b.x)) sides.push("left");
	if (a.y >= margin && flush(b.y)) sides.push("top");
	if (W - (a.x + a.w) >= margin && flush(W - (b.x + b.w))) sides.push("right");
	if (H - (a.y + a.h) >= margin && flush(H - (b.y + b.h))) sides.push("bottom");
	return { sides, comp: a, build: b };
}

/** An inline SVG that is an illustration rather than an icon. */
interface SvgIllustration {
	readonly snippet: string;
	readonly label: string | null;
	readonly paths: number;
	readonly budget: number;
	readonly long: number;
}

/**
 * Inline SVG that is an illustration, not an icon.
 *
 * An icon is small, with a few paths. Anything with a real path budget is a drawing in code — a
 * diagram, a rack of carburetors, staff notation, leader lines with arrows — and those ship as
 * plates or as part of the plate they annotate.
 *
 * `pathBudget` counts characters of path data, points and polyline/polygon points across the element.
 */
function svgIllustrations(html: string, { iconPx = 64, pathBudget = 480, maxPaths = 8 }: { readonly iconPx?: number; readonly pathBudget?: number; readonly maxPaths?: number } = {}): SvgIllustration[] {
	const out: SvgIllustration[] = [];
	const re = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi;

	for (let m = re.exec(html); m !== null; m = re.exec(html)) {
		const attrs = m[1];
		const body = m[2];
		const paths = (body.match(/<path\b/gi) || []).length + (body.match(/<(polyline|polygon|line|circle|ellipse|rect)\b/gi) || []).length;

		let budget = 0;
		for (const d of body.matchAll(/\sd="([^"]*)"/g)) budget += d[1].length;
		for (const pts of body.matchAll(/\spoints="([^"]*)"/g)) budget += pts[1].length;

		const vb = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(attrs);
		const w = /\swidth="([\d.]+)(px)?"/.exec(attrs);
		const h = /\sheight="([\d.]+)(px)?"/.exec(attrs);
		const long = Math.max(vb ? Math.max(Number(vb[1]), Number(vb[2])) : 0, w ? Number(w[1]) : 0, h ? Number(h[1]) : 0);

		const iconSized = long > 0 && long <= iconPx && paths <= maxPaths;
		const uses = /<use\b/i.test(body) && paths === 0; // a sprite reference
		if (uses) continue;
		if (iconSized && budget <= pathBudget) continue;
		if (budget <= pathBudget && paths <= maxPaths && long === 0 && !/<(text|image)\b/i.test(body)) continue; // a tiny inline glyph with no size hint

		if (budget > pathBudget || paths > maxPaths || (long > iconPx && paths > 0)) {
			const id = /\b(id|class|aria-label|data-region)="([^"]+)"/i.exec(attrs);
			out.push({
				snippet: `<svg${attrs.slice(0, 80).replace(/\s+/g, " ")}...> (${paths} shapes, ${budget} chars of path data${long ? `, ${long}px` : ""})`,
				label: id ? id[2] : null,
				paths,
				budget,
				long,
			});
		}
	}
	return out;
}

export {
	chromeStripCheck,
	inkBox,
	inkColor,
	inventedInk,
	plateClipCheck,
	ruleRows,
	svgIllustrations,
	textRegionCheck,
};
export type { CheckRegion, CheckResult, InkColor, InventedCell, SvgIllustration };
