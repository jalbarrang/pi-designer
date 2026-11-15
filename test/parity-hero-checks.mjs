/**
 * Parity check: the hero checks against the reference.
 *
 * Each of these exists because a build the region scores let through failed a human review, so the
 * comparisons aim at the thresholds that fire: a cap height a fifth off, a block wrapping one line
 * longer, ink a different colour, a strip whose rule sits lower, a plate flush to an edge its comp
 * kept a margin from, and an SVG that is a drawing rather than an icon.
 */
import * as port from "../extensions/designer/engine/lib/hero-checks.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/hero-checks.mjs";
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

/** A text crop: bitmap lettering on paper, with a control over scale, ground and ink. */
function textCrop(width, height, { scale = 5, text = "HEADLINE", ground = [246, 242, 234, 255], ink = [22, 22, 24, 255], y = 4, lines = 1 } = {}) {
	const img = raster.createImage(width, height, ground);
	for (let i = 0; i < lines; i++) raster.drawText(img, text, 4, y + i * (7 * scale + 6), ink, scale);
	return img;
}

// ─── ink colour ─────────────────────────────────────────────────────
check("inkColor(paper and ink)", port.inkColor(textCrop(200, 60)), ref.inkColor(textCrop(200, 60)));
check("inkColor(flat)", port.inkColor(raster.createImage(40, 40, [200, 200, 200, 255])), ref.inkColor(raster.createImage(40, 40, [200, 200, 200, 255])));

// ─── text regions ───────────────────────────────────────────────────
const comp = textCrop(300, 80, { scale: 5 });
const region = { id: "headline", kind: "text", type: {} };

const textCases = {
	same: textCrop(300, 80, { scale: 5 }),
	smaller: textCrop(300, 80, { scale: 3 }),
	larger: textCrop(300, 80, { scale: 8 }),
	lower: textCrop(300, 80, { scale: 5, y: 26 }),
	shifted: (() => {
		const img = raster.createImage(300, 80, [246, 242, 234, 255]);
		raster.drawText(img, "HEADLINE", 60, 4, [22, 22, 24, 255], 5);
		return img;
	})(),
	recoloured: textCrop(300, 80, { scale: 5, ink: [168, 32, 24, 255] }),
	darkGround: textCrop(300, 80, { scale: 5, ground: [24, 24, 28, 255], ink: [240, 240, 240, 255] }),
	differentText: textCrop(300, 80, { scale: 5, text: "HANDG" }),
	empty: raster.createImage(300, 80, [246, 242, 234, 255]),
};

for (const [name, build] of Object.entries(textCases)) {
	check(`textRegionCheck(${name})`, port.textRegionCheck(region, comp, build), ref.textRegionCheck(region, comp, build));
}

// The tolerances themselves are behaviour.
for (const options of [{ capTol: 0.1 }, { capTol: 0.5 }, { minCap: 40 }, { minCap: 4 }]) {
	check(`textRegionCheck(smaller, ${JSON.stringify(options)})`, port.textRegionCheck(region, comp, textCases.smaller, options), ref.textRegionCheck(region, comp, textCases.smaller, options));
}

// A region whose spec names a ranked face quotes it in the finding.
check(
	"textRegionCheck(with a chosen face)",
	port.textRegionCheck({ ...region, type: { chosen: { family: "Inter", weight: 700, fontSizePx: 32 } } }, comp, textCases.smaller),
	ref.textRegionCheck({ ...region, type: { chosen: { family: "Inter", weight: 700, fontSizePx: 32 } } }, comp, textCases.smaller),
);

// Multi-line comps exercise the line-count and leading branches.
const multiComp = textCrop(300, 200, { scale: 4, lines: 3 });
for (const [name, build] of Object.entries({
	sameLines: textCrop(300, 200, { scale: 4, lines: 3 }),
	oneMore: textCrop(300, 200, { scale: 4, lines: 4 }),
	tighter: (() => {
		const img = raster.createImage(300, 200, [246, 242, 234, 255]);
		for (let i = 0; i < 3; i++) raster.drawText(img, "HEADLINE", 4, 4 + i * 20, [22, 22, 24, 255], 4);
		return img;
	})(),
})) {
	check(`textRegionCheck(multi: ${name})`, port.textRegionCheck(region, multiComp, build), ref.textRegionCheck(region, multiComp, build));
}

// ─── rules and chrome strips ────────────────────────────────────────
const strip = (() => {
	const img = raster.createImage(300, 50, [250, 250, 250, 255]);
	raster.fillRect(img, 0, 30, 300, 2, [20, 20, 20, 255]);
	return img;
})();
const stripLower = (() => {
	const img = raster.createImage(300, 50, [250, 250, 250, 255]);
	raster.fillRect(img, 0, 40, 300, 2, [20, 20, 20, 255]);
	return img;
})();

check("ruleRows(strip)", port.ruleRows(strip), ref.ruleRows(strip));
check("ruleRows(stripLower)", port.ruleRows(stripLower), ref.ruleRows(stripLower));
check("ruleRows(no rules)", port.ruleRows(textCrop(200, 40)), ref.ruleRows(textCrop(200, 40)));
for (const span of [0.2, 0.5, 0.9]) {
	check(`ruleRows(span ${span})`, port.ruleRows(strip, { span }), ref.ruleRows(strip, { span }));
}
for (const step of [8, 28, 80]) {
	check(`ruleRows(step ${step})`, port.ruleRows(strip, { step }), ref.ruleRows(strip, { step }));
}

for (const kind of ["chrome", "control", "band"]) {
	for (const [name, build] of Object.entries({ same: strip, lower: stripLower, text: textCrop(300, 50, { scale: 3 }) })) {
		check(`chromeStripCheck(${kind}, ${name})`, port.chromeStripCheck({ id: "masthead", kind }, strip, build), ref.chromeStripCheck({ id: "masthead", kind }, strip, build));
	}
}
// A tall crop is not a strip, so the check stays quiet.
check("chromeStripCheck(tall crop)", port.chromeStripCheck({ id: "panel", kind: "chrome" }, textCrop(200, 200), textCrop(200, 200)), ref.chromeStripCheck({ id: "panel", kind: "chrome" }, textCrop(200, 200), textCrop(200, 200)));

// ─── invented ink ───────────────────────────────────────────────────
const calm = raster.createImage(300, 300, [246, 242, 234, 255]);
const kicker = (() => {
	const img = raster.createImage(300, 300, [246, 242, 234, 255]);
	raster.fillRect(img, 20, 20, 120, 8, [20, 20, 20, 255]);
	return img;
})();
check("inventedInk(calm)", port.inventedInk(calm, calm), ref.inventedInk(calm, calm));
check("inventedInk(kicker)", port.inventedInk(calm, kicker), ref.inventedInk(calm, kicker));
check("inventedInk(same inked)", port.inventedInk(kicker, kicker), ref.inventedInk(kicker, kicker));
for (const options of [{ floor: 2 }, { floor: 40 }, { cols: 4, rows: 4 }, { ratio: 1.2 }]) {
	check(`inventedInk(kicker, ${JSON.stringify(options)})`, port.inventedInk(calm, kicker, options), ref.inventedInk(calm, kicker, options));
}

// ─── plate clipping ─────────────────────────────────────────────────
const plateWithMargin = (() => {
	const img = raster.createImage(200, 120, [250, 250, 250, 255]);
	raster.fillRect(img, 20, 20, 140, 80, [30, 30, 36, 255]);
	return img;
})();
const plateFlushLeft = (() => {
	const img = raster.createImage(200, 120, [250, 250, 250, 255]);
	raster.fillRect(img, 0, 20, 160, 80, [30, 30, 36, 255]);
	return img;
})();
const plateFlushAll = raster.createImage(200, 120, [30, 30, 36, 255]);

for (const [name, build] of Object.entries({ same: plateWithMargin, flushLeft: plateFlushLeft, flushAll: plateFlushAll })) {
	check(`plateClipCheck(${name})`, port.plateClipCheck({ id: "hero", kind: "plate" }, plateWithMargin, build), ref.plateClipCheck({ id: "hero", kind: "plate" }, plateWithMargin, build));
}
for (const margin of [1, 6, 20]) {
	check(`plateClipCheck(margin ${margin})`, port.plateClipCheck({ id: "hero" }, plateWithMargin, plateFlushLeft, { margin }), ref.plateClipCheck({ id: "hero" }, plateWithMargin, plateFlushLeft, { margin }));
}

// ─── SVG illustrations ──────────────────────────────────────────────
const svgCases = {
	icon: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
	sprite: '<svg><use href="#icon-arrow"/></svg>',
	diagram: `<svg viewBox="0 0 400 300"><path d="${"M0 0 L400 300 ".repeat(30)}"/><circle cx="10" cy="10" r="4"/></svg>`,
	manyShapes: `<svg width="300" height="200">${'<rect x="1" y="1" width="4" height="4"/>'.repeat(12)}</svg>`,
	bigWithPaths: '<svg viewBox="0 0 800 600"><path d="M0 0L800 600"/></svg>',
	tinyNoSize: '<svg><path d="M0 0L2 2"/></svg>',
	withText: '<svg viewBox="0 0 800 600"><text x="0" y="0">label</text></svg>',
	labelled: '<svg class="carburetor" viewBox="0 0 500 400"><path d="M0 0L500 400"/><path d="M0 400L500 0"/></svg>',
};
for (const [name, html] of Object.entries(svgCases)) {
	check(`svgIllustrations(${name})`, port.svgIllustrations(html), ref.svgIllustrations(html));
}
for (const options of [{ iconPx: 16 }, { iconPx: 400 }, { pathBudget: 10 }, { maxPaths: 2 }]) {
	check(`svgIllustrations(diagram, ${JSON.stringify(options)})`, port.svgIllustrations(svgCases.diagram, options), ref.svgIllustrations(svgCases.diagram, options));
}
check("svgIllustrations(empty)", port.svgIllustrations(""), ref.svgIllustrations(""));
check(
	"svgIllustrations(multi-element)",
	port.svgIllustrations(`${svgCases.icon}${svgCases.diagram}`),
	ref.svgIllustrations(`${svgCases.icon}${svgCases.diagram}`),
);

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} hero-checks comparisons failed`);
	process.exit(1);
}
console.log(`hero-checks parity: ${comparisons} comparisons match the reference`);
