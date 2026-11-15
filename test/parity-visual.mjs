/**
 * Checks for the pixel-contrast engine: the pure clip clamp against the reference, and the
 * measurement's decision logic against a fake page.
 *
 * The in-page callbacks are real browser code, so this drives them through a stub whose
 * `evaluate` answers the way the page would. That keeps the part worth testing here — when
 * a measurement becomes a finding, and whether the page is left as it was found.
 */
import * as port from "../extensions/designer/engine/detect/visual/contrast.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/engines/visual/screenshot-contrast.mjs";

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     port: ${a}\n     ref:  ${e}`);
}

function assert(name, ok, detail = "") {
	comparisons++;
	if (ok) return;
	failures++;
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

// ─── Clip clamping (direct oracle) ─────────────────────────────────────────

const clips = [
	null,
	{ x: 10, y: 20, width: 300, height: 100 },
	{ x: -5, y: -5, width: 300.4, height: 99.6 },
	{ x: 0, y: 0, width: 0, height: 0 },
	{ x: 0, y: 0, width: 5000, height: 5000 },
	{ x: 1.9, y: 2.9, width: 12.1, height: 400 },
	{},
];
for (const clip of clips) {
	for (const viewport of [null, { width: 390, height: 844 }, { width: 1600, height: 900 }]) {
		check(
			`sanitizeScreenshotClip(${JSON.stringify(clip)}, ${JSON.stringify(viewport)})`,
			port.sanitizeScreenshotClip(clip, viewport),
			ref.sanitizeScreenshotClip(clip, viewport),
		);
	}
}

// ─── Measurement decision logic (stub page) ────────────────────────────────

function fakePage({ metrics = null, applied = true } = {}) {
	const calls = { evaluate: 0, screenshot: 0, cleanup: 0 };
	const page = {
		calls,
		async evaluate(fn, arg) {
			calls.evaluate++;
			const source = String(fn);
			if (source.includes("getImageData")) return metrics;
			if (source.includes("removeAttribute")) {
				calls.cleanup++;
				return undefined;
			}
			if (source.includes("data-impeccable-visual-contrast-target")) return applied;
			return undefined;
		},
		async screenshot() {
			calls.screenshot++;
			return "before-or-after";
		},
	};
	return page;
}

const candidate = {
	selector: ".hero-title",
	clip: { x: 0, y: 0, width: 400, height: 120 },
	text: "Headline over an image",
	textColor: { r: 250, g: 250, b: 250 },
	threshold: 4.5,
	reasons: ["photo", "gradient", "texture", "unused"],
};

const failingMetrics = { glyphPixels: 120, strongestDelta: 400, worstRatio: 1.2, p10Ratio: 2.4, medianRatio: 2.9 };
const passingMetrics = { glyphPixels: 120, strongestDelta: 400, worstRatio: 6.1, p10Ratio: 7.2, medianRatio: 8.0 };
const thinMetrics = { glyphPixels: 3, strongestDelta: 400, worstRatio: 1.2, p10Ratio: 2.4, medianRatio: 2.9 };

{
	const page = fakePage({ metrics: failingMetrics });
	const finding = await port.captureVisualContrastCandidate(page, candidate, { width: 1280, height: 800 });
	assert("a failing measurement becomes a finding", !!finding, String(finding));
	check("finding id", finding?.id, "low-contrast");
	check(
		"finding snippet names the ratio, the need, three reasons and the text",
		finding?.snippet,
		'pixel contrast 2.4:1 median 2.9:1 (need 4.5:1) on photo, gradient, texture "Headline over an image"',
	);
	check("two captures were taken", page.calls.screenshot, 2);
	assert("the page was restored", page.calls.cleanup === 1, String(page.calls.cleanup));
}

{
	const page = fakePage({ metrics: passingMetrics });
	const finding = await port.captureVisualContrastCandidate(page, candidate, null);
	check("a passing measurement reports nothing", finding, null);
}

{
	const page = fakePage({ metrics: thinMetrics });
	const finding = await port.captureVisualContrastCandidate(page, candidate, null);
	check("too few glyph pixels is not evidence", finding, null);
}

{
	const page = fakePage({ metrics: null });
	const finding = await port.captureVisualContrastCandidate(page, candidate, null);
	check("no metrics reports nothing", finding, null);
}

{
	const page = fakePage({ applied: false });
	const finding = await port.captureVisualContrastCandidate(page, candidate, null);
	check("an element that cannot be found reports nothing", finding, null);
	check("no capture when the glyphs could not be hidden", page.calls.screenshot, 1);
}

{
	const page = fakePage({ metrics: failingMetrics });
	const finding = await port.captureVisualContrastCandidate(page, { ...candidate, clip: null }, null);
	check("a missing clip reports nothing", finding, null);
	check("no work without a clip", page.calls.evaluate, 0);
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} visual-contrast comparisons failed`);
	process.exit(1);
}
console.log(`visual-contrast: ${comparisons} comparisons and decisions match the reference`);
