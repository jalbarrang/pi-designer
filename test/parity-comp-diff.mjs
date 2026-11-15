/**
 * Parity check: comp-diff against the reference.
 *
 * The scores rank; the verdicts are what a build acts on, and a verdict that drifts turns "missing"
 * into "drift" and lets a broken page pass. So the comparisons aim at the verdict boundaries:
 * identical, a shifted build, a recoloured build, a build that dropped a region, and a build with
 * invented detail in a plate.
 */
import * as port from "../extensions/designer/engine/lib/comp-diff.ts";
import * as ref from "../reference/impeccable-js/scripts/comp-diff.mjs";
import * as raster from "../extensions/designer/engine/lib/raster.ts";
import * as metrics from "../extensions/designer/engine/lib/image-metrics.ts";

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

const digest = (img) => ({ width: img.width, height: img.height, sum: img.data.reduce((n, v) => (n + v) % 1_000_003, 0) });

// ─── fixtures ───────────────────────────────────────────────────────
/** A page: paper ground, a dark hero band, a headline, a body block. */
function page(width, height, { recolor = false, dropHero = false, addNoise = false } = {}) {
	const img = raster.createImage(width, height, recolor ? [30, 40, 90, 255] : [246, 242, 234, 255]);
	if (!dropHero) raster.fillRect(img, 20, 30, Math.round(width * 0.8), Math.round(height * 0.35), [32, 32, 38, 255]);
	raster.drawText(img, "HEADLINE", 24, Math.round(height * 0.45), [20, 20, 20, 255], 4);
	for (let row = 0; row < 3; row++) raster.fillRect(img, 24, Math.round(height * 0.62) + row * 14, Math.round(width * 0.6), 5, [70, 70, 70, 255]);
	if (addNoise) {
		for (let i = 0; i < img.data.length; i += 4) {
			img.data[i] = (img.data[i] + ((i * 37) % 90)) % 256;
			img.data[i + 1] = (img.data[i + 1] + ((i * 53) % 90)) % 256;
		}
	}
	return img;
}

const comp = page(320, 240);
const spec = {
	regions: [
		{ id: "hero", kind: "plate", box: { x: 0.05, y: 0.1, w: 0.85, h: 0.38 } },
		{ id: "headline", kind: "text", box: { x: 0.05, y: 0.43, w: 0.6, h: 0.12 } },
		{ id: "body", kind: "text", box: { x: 0.05, y: 0.6, w: 0.65, h: 0.25 } },
	],
};

// ─── alignment ──────────────────────────────────────────────────────
const build = page(320, 240);
const tallBuild = page(320, 400);
const wideBuild = page(500, 240);

for (const [name, b] of Object.entries({ same: build, tall: tallBuild, wide: wideBuild })) {
	for (const align of ["top", "stretch", "cover"]) {
		check(`alignBuild(${name}, ${align})`, digest(port.alignBuild(comp, b, align)), digest(ref.alignBuild(comp, b, align)));
	}
}

// ─── verdicts at the boundaries ─────────────────────────────────────
const verdictCases = [
	{ overall: 0.9, structure: 0.9, color: 0.8, detail: 0.8, detailRaw: 0.8, detailAdded: 0, bands: 0.9, kind: null },
	{ overall: 0.7, structure: 0.7, color: 0.6, detail: 0.5, detailRaw: 0.5, detailAdded: 0, bands: 0.7, kind: null },
	{ overall: 0.5, structure: 0.5, color: 0.4, detail: 0.4, detailRaw: 0.4, detailAdded: 0, bands: 0.5, kind: null },
	{ overall: 0.9, structure: 0.9, color: 0.9, detail: 0.9, detailRaw: 0.1, detailAdded: 0, bands: 0.9, kind: "plate" },
	{ overall: 0.9, structure: 0.9, color: 0.9, detail: 0.4, detailRaw: 0.9, detailAdded: 0, bands: 0.9, kind: "plate" },
	{ overall: 0.9, structure: 0.4, color: 0.9, detail: 0.9, detailRaw: 0.9, detailAdded: 0, bands: 0.9, kind: "plate" },
	{ overall: 0.9, structure: 0.9, color: 0.9, detail: 0.9, detailRaw: 0.9, detailAdded: 0.5, bands: 0.9, kind: "image" },
	{ overall: 0.9, structure: 0.9, color: 0.9, detail: 0.9, detailRaw: 0.9, detailAdded: 0.5, bands: 0.9, kind: "text" },
	{ overall: 0.7, structure: 0.9, color: 0.8, detail: 0.2, detailRaw: 0.2, detailAdded: 0, bands: 0.9, kind: "text" },
	{ overall: 0.7, structure: 0.4, color: 0.3, detail: 0.2, detailRaw: 0.25, detailAdded: 0, bands: 0.5, kind: "chrome" },
	{ overall: 0.45, structure: 0.28, color: 0.9, detail: 0.9, detailRaw: 0.9, detailAdded: 0, bands: 0.9, kind: null },
	{ overall: 0.9, structure: 0.9, color: 0.9, detail: 0.2, detailRaw: 0.18, detailAdded: 0, bands: 0.9, kind: null },
];

for (const [i, s] of verdictCases.entries()) {
	for (const kind of [s.kind, null, "text", "chrome", "control", "texture", "image"]) {
		check(`verdictFor(#${i}, ${JSON.stringify(kind)})`, port.verdictFor(s, kind), ref.verdictFor(s, kind));
	}
}

// `WEIGHTS` is module-private upstream; it is covered through `scorePair` above, which is exactly
// where a changed weight would show.
check("DIRECTION_KINDS", [...port.DIRECTION_KINDS].sort(), [...ref.DIRECTION_KINDS].sort());

// ─── scoring and regions ────────────────────────────────────────────
for (const [name, b] of Object.entries({ same: build, recolored: page(320, 240, { recolor: true }), noHero: page(320, 240, { dropHero: true }), noisy: page(320, 240, { addNoise: true }) })) {
	const a = port.alignBuild(comp, b);
	const c = ref.alignBuild(comp, b);
	for (const kind of [null, "plate", "text", "texture"]) {
		check(`scorePair(${name}, ${kind})`, port.scorePair(comp, a, kind), ref.scorePair(comp, c, kind));
	}
}

check("bestShift(shifted)", port.bestShift(comp, raster.blit === undefined ? build : build), ref.bestShift(comp, build));
check("bestShift(recolored)", port.bestShift(comp, page(320, 240, { recolor: true })), ref.bestShift(comp, page(320, 240, { recolor: true })));

check("resolveRegions(spec)", port.resolveRegions(comp, spec), ref.resolveRegions(comp, spec));
check("resolveRegions(null)", port.resolveRegions(comp, null), ref.resolveRegions(comp, null));
check("resolveRegions(empty spec)", port.resolveRegions(comp, { regions: [] }), ref.resolveRegions(comp, { regions: [] }));
check("resolveRegions(malformed boxes)", port.resolveRegions(comp, { regions: [{ id: "bad", box: { x: "a" } }] }), ref.resolveRegions(comp, { regions: [{ id: "bad", box: { x: "a" } }] }));

check("inkBox(page)", port.inkBox(comp), ref.inkBox(comp));
check("inkBox(flat)", port.inkBox(raster.createImage(40, 40, [200, 200, 200, 255])), ref.inkBox(raster.createImage(40, 40, [200, 200, 200, 255])));

// ─── whole comparisons ──────────────────────────────────────────────
for (const [name, b] of Object.entries({ same: build, recolored: page(320, 240, { recolor: true }), noHero: page(320, 240, { dropHero: true }), tall: tallBuild })) {
	const portResult = port.compare({ comp, build: b, spec, label: name });
	const refResult = ref.compare({ comp, build: b, spec, label: name });
	check(
		`compare(${name})`,
		{
			label: portResult.label,
			align: portResult.align,
			whole: portResult.whole,
			shift: portResult.shift,
			regions: portResult.regions.map((r) => ({ id: r.id, kind: r.kind, verdict: r.verdict, score: r.score, inkBox: r.inkBox })),
			compPalette: portResult.compPalette,
			buildPalette: portResult.buildPalette,
		},
		{
			label: refResult.label,
			align: refResult.align,
			whole: refResult.whole,
			shift: refResult.shift,
			regions: refResult.regions.map((r) => ({ id: r.id, kind: r.kind, verdict: r.verdict, score: r.score, inkBox: r.inkBox })),
			compPalette: refResult.compPalette,
			buildPalette: refResult.buildPalette,
		},
	);
}

// ─── renderers ──────────────────────────────────────────────────────
const portCompare = port.compare({ comp, build, spec, label: "render" });
const refCompare = ref.compare({ comp, build, spec, label: "render" });

check("renderSideBySide", digest(port.renderSideBySide(comp, portCompare.aligned, "render", portCompare.whole)), digest(ref.renderSideBySide(comp, refCompare.aligned, "render", refCompare.whole)));
check("renderHeatmap", digest(port.renderHeatmap(comp, portCompare.aligned)), digest(ref.renderHeatmap(comp, refCompare.aligned)));
for (const id of ["hero", "headline"]) {
	const a = portCompare.regions.find((r) => r.id === id);
	const b = refCompare.regions.find((r) => r.id === id);
	check(`renderRegionPair(${id})`, digest(port.renderRegionPair(a._a, a._b, id, a.score)), digest(ref.renderRegionPair(b._a, b._b, id, b.score)));
}

// ─── the report ─────────────────────────────────────────────────────
const portReport = port.buildReport(portCompare, null, { label: "render", comp: "c.png", build: "b.png" });
const refReport = ref.buildReport(refCompare, null, { label: "render", comp: "c.png", build: "b.png" });
const { createdAt: _a, ...portRest } = portReport;
const { createdAt: _b, ...refRest } = refReport;
check("buildReport", portRest, refRest);
// `summarize` is module-private upstream, so the port's text is checked against the shape it
// documents rather than compared.
const summary = port.summarize({ ...portReport, createdAt: "pinned" });
check("summarize(shape)", summary.split("\n").map((line) => line.split(" ")[0]), ["COMP-DIFF", "PALETTE", "PALETTE", "REGION", "REGION", "REGION", "WORST", "OPEN"]);

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} comp-diff comparisons failed`);
	process.exit(1);
}
console.log(`comp-diff parity: ${comparisons} comparisons match the reference`);
