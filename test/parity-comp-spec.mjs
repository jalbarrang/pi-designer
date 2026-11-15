/**
 * Parity check: the comp spec against the reference.
 *
 * Most of this file is refusal, so the comparisons are aimed at what it refuses: a note that names
 * painted material filed as chrome, a column passed off as one region, a plate boxed through its own
 * artwork, ink no region names. A refusal that stops firing is a build that fails four gates later
 * with no way to tell why.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/comp-spec.ts");
const ref = await import("../reference/impeccable-js/scripts/comp-spec.mjs");
const raster = await import("../extensions/designer/engine/lib/raster.ts");

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

const attempt = (fn) => {
	try {
		return fn();
	} catch (error) {
		return { error: String(error.message) };
	}
};
const withoutTime = (spec) => (spec && typeof spec === "object" ? { ...spec, createdAt: "pinned" } : spec);

// ─── constants and grid math ────────────────────────────────────────
check("BUILD_DIR", port.BUILD_DIR, ref.BUILD_DIR);
check("SPEC_PATH", port.SPEC_PATH, ref.SPEC_PATH);
check("GRID_PATH", port.GRID_PATH, ref.GRID_PATH);
check("PLATES_DIR", port.PLATES_DIR, ref.PLATES_DIR);
check("RASTER_KINDS", [...port.RASTER_KINDS].sort(), [...ref.RASTER_KINDS].sort());
check("KINDS", [...port.KINDS].sort(), [...ref.KINDS].sort());
check("MAX_CODE_REGION_AREA", port.MAX_CODE_REGION_AREA, ref.MAX_CODE_REGION_AREA);
check("EDGE_CONTACT_MIN", port.EDGE_CONTACT_MIN, ref.EDGE_CONTACT_MIN);

for (const span of ["A0:A0", "E0:J4", "J4:E0", "a1:b2", "C9:C9"]) {
	check(`gridToBox(${span})`, port.gridToBox(span), ref.gridToBox(span));
}
for (const span of ["bad", "K0:A0", "A0", "A0:B", "A10:B2"]) {
	check(`gridToBox(${JSON.stringify(span)}) throws`, attempt(() => port.gridToBox(span)), attempt(() => ref.gridToBox(span)));
}

for (const phrase of ["an exploded carburetor diagram", "chrome bar and a rule", "a watercolour wash", "hero image of a turbine", "a data table", "3d render of a chair"]) {
	check(`PAINTED_NOTE(${JSON.stringify(phrase)})`, port.PAINTED_NOTE.test(phrase), ref.PAINTED_NOTE.test(phrase));
}

// ─── comp fixtures ──────────────────────────────────────────────────
/** A page: paper ground, a dark hero plate on the left, a headline, a body column. */
function page(width, height) {
	const img = raster.createImage(width, height, [246, 242, 234, 255]);
	// A hero plate: a dark arch, with a margin of paper around it.
	raster.fillRect(img, 20, 40, Math.round(width * 0.4), Math.round(height * 0.5), [30, 30, 36, 255]);
	// A headline.
	raster.drawText(img, "HEADLINE", Math.round(width * 0.5), 50, [20, 20, 20, 255], 4);
	// Body copy: several short rows.
	for (let row = 0; row < 4; row++) raster.fillRect(img, Math.round(width * 0.5), 110 + row * 12, Math.round(width * 0.35), 4, [60, 60, 60, 255]);
	return img;
}
const comp = page(400, 300);

/** A plate whose artwork runs off its own right edge. */
function bleedingPlate(width, height) {
	const img = raster.createImage(width, height, [250, 250, 250, 255]);
	raster.fillRect(img, 0, 0, width, height, [25, 25, 30, 255]);
	return img;
}

check(
	"artworkTouchesEdges(bleeding)",
	port.artworkTouchesEdges(bleedingPlate(60, 40), { ground: 250 }),
	ref.artworkTouchesEdges(bleedingPlate(60, 40), { ground: 250 }),
);
check(
	"artworkTouchesEdges(margin)",
	port.artworkTouchesEdges(raster.crop(comp, 20, 40, 120, 120), { ground: 244 }),
	ref.artworkTouchesEdges(raster.crop(comp, 20, 40, 120, 120), { ground: 244 }),
);
check(
	"artworkTouchesEdges(default ground)",
	port.artworkTouchesEdges(raster.crop(comp, 20, 40, 120, 120)),
	ref.artworkTouchesEdges(raster.crop(comp, 20, 40, 120, 120)),
);

// ─── snapping ───────────────────────────────────────────────────────
// `medianGray` and `energyOf` are module-private upstream; they are covered through
// `snapBoxToInk` and `measureRegions`, which consume them.
const ground = port.medianGray(comp);
check("medianGray(in range)", ground > 0 && ground < 255, true);
for (const box of [
	{ x: 0.4, y: 0.1, w: 0.55, h: 0.3 },
	{ x: 0.05, y: 0.1, w: 0.5, h: 0.6 },
	{ x: 0, y: 0, w: 1, h: 1 },
	{ x: 0.0, y: 0.0, w: 0.01, h: 0.01 },
]) {
	check(`snapBoxToInk(${JSON.stringify(box)})`, port.snapBoxToInk(comp, box, ground), ref.snapBoxToInk(comp, box, ground));
}

// ─── the measured spec ──────────────────────────────────────────────
const regionsFile = {
	regions: [
		{ id: "hero", kind: "plate", grid: "A0:D4", note: "exploded carburetor drawing as the hero plate" },
		{ id: "headline", kind: "text", grid: "E0:J2", note: "the headline in a condensed grotesque" },
		{ id: "body", kind: "text", grid: "E2:J5", note: "four lines of running body copy" },
		{ id: "footer", kind: "band", grid: "A5:J9", note: "the footer band" },
	],
};

const specFile = path.join(os.tmpdir(), "comp-spec-fixture.json");
check(
	"measureRegions(full)",
	attempt(() =>
		withoutTime(
			(() => {
				const saved = [];
				for (let i = 0; i < 0; i++) saved.push(i);
				return port.measureRegions(comp, regionsFile, specFile);
			})(),
		),
	),
	attempt(() => withoutTime(ref.measureRegions(comp, regionsFile, specFile))),
);

const refusalCases = {
	noNote: { regions: [{ id: "chrome-bar", kind: "chrome" }] },
	shortNote: { regions: [{ id: "chrome-bar", kind: "chrome", note: "bar" }] },
	duplicateId: {
		regions: [
			{ id: "a", kind: "text", grid: "A0:B1", note: "one element here" },
			{ id: "a", kind: "text", grid: "C0:D1", note: "another element here" },
		],
	},
	noId: { regions: [{ kind: "text", grid: "A0:B1", note: "one element here" }] },
	paintedAsCode: { regions: [{ id: "art", kind: "chrome", grid: "A0:D4", note: "a detailed exploded carburetor diagram" }] },
	column: { regions: [{ id: "whole", kind: "text", grid: "A0:J9", note: "everything on the left column" }] },
	uncoveredInk: {
		regions: [{ id: "only-hero", kind: "plate", grid: "A0:D4", note: "exploded carburetor drawing as the hero plate" }],
	},
};

for (const [name, input] of Object.entries(refusalCases)) {
	check(`measureRegions(${name})`, attempt(() => port.measureRegions(comp, input, specFile)), attempt(() => ref.measureRegions(comp, input, specFile)));
}

// The escape hatches are recorded, not swallowed.
for (const [name, input] of Object.entries({
	codeDrawn: { regions: [{ id: "art", kind: "chrome", grid: "A0:D4", note: "a detailed exploded carburetor diagram", codeDrawn: true }] },
	container: { regions: [{ id: "whole", kind: "text", grid: "A0:J9", note: "everything on the left column", container: true }] },
	allowUncovered: { ...refusalCases.uncoveredInk, allowUncovered: true },
	bleedOverride: { regions: [{ id: "bleed-plate", kind: "plate", grid: "A0:D4", note: "a photograph that runs off the page", bleed: true }] },
})) {
	check(
		`measureRegions(${name}) warnings`,
		attempt(() => withoutTime(port.measureRegions(comp, input, specFile)).warnings),
		attempt(() => withoutTime(ref.measureRegions(comp, input, specFile)).warnings),
	);
}

// An explicit box skips snapping, and the grid stays on the record.
check(
	"measureRegions(explicit box)",
	attempt(() => {
		const spec = port.measureRegions(comp, { regions: [{ id: "boxed", kind: "text", box: { x: 0.5, y: 0.15, w: 0.4, h: 0.1 }, note: "the headline measured by hand" }] }, specFile);
		return spec.regions.map((r) => ({ id: r.id, box: r.box, coverBox: r.coverBox, grid: r.grid }));
	}),
	attempt(() => {
		const spec = ref.measureRegions(comp, { regions: [{ id: "boxed", kind: "text", box: { x: 0.5, y: 0.15, w: 0.4, h: 0.1 }, note: "the headline measured by hand" }] }, specFile);
		return spec.regions.map((r) => ({ id: r.id, box: r.box, coverBox: r.coverBox, grid: r.grid }));
	}),
);

// ─── grids, auto regions, prompts, printing ─────────────────────────
check("renderGrid", (() => {
	const a = port.renderGrid(comp);
	return { width: a.width, height: a.height, sum: a.data.reduce((n, v) => (n + v) % 1_000_003, 0) };
})(), (() => {
	const b = ref.renderGrid(comp);
	return { width: b.width, height: b.height, sum: b.data.reduce((n, v) => (n + v) % 1_000_003, 0) };
})());

check("autoRegions", port.autoRegions(comp), ref.autoRegions(comp));

const spec = port.measureRegions(comp, regionsFile, specFile);
check("printSpec", port.printSpec(spec), ref.printSpec(ref.measureRegions(comp, regionsFile, specFile)));

const hero = spec.regions.find((r) => r.id === "hero");
check("platePrompt(plate)", port.platePrompt(spec, hero), ref.platePrompt(ref.measureRegions(comp, regionsFile, specFile), ref.measureRegions(comp, regionsFile, specFile).regions.find((r) => r.id === "hero")));
for (const kind of ["texture", "image", "plate"]) {
	const sample = { ...hero, kind };
	check(`platePrompt(${kind})`, port.platePrompt(spec, sample), ref.platePrompt(ref.measureRegions(comp, regionsFile, specFile), sample));
}
check(
	"plateReference",
	(() => {
		const a = port.plateReference(comp, spec, hero);
		return { width: a.width, height: a.height, sum: a.data.reduce((n, v) => (n + v) % 1_000_003, 0) };
	})(),
	(() => {
		const refSpec = ref.measureRegions(comp, regionsFile, specFile);
		const b = ref.plateReference(comp, refSpec, refSpec.regions.find((r) => r.id === "hero"));
		return { width: b.width, height: b.height, sum: b.data.reduce((n, v) => (n + v) % 1_000_003, 0) };
	})(),
);

// ─── reading a spec from disk ───────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-compspec-"));
try {
	const specPath = path.join(dir, "spec.json");
	check("loadSpec(missing)", port.loadSpec(specPath), ref.loadSpec(specPath));
	fs.writeFileSync(specPath, JSON.stringify(spec));
	check("loadSpec(present)", port.loadSpec(specPath), ref.loadSpec(specPath));
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} comp-spec comparisons failed`);
	process.exit(1);
}
console.log(`comp-spec parity: ${comparisons} comparisons match the reference`);
