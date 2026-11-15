/**
 * Parity check: ported rules against the reference implementation in
 * `reference/impeccable-js/scripts/detector/rules/checks.mjs`.
 *
 * Cases are generated from a compact matrix so the comparison covers gates
 * (widths, chroma, radius, alpha, tag) rather than a happy path each.
 */
import * as background from "../extensions/designer/engine/core/checks/background.ts";
import * as borders from "../extensions/designer/engine/core/checks/borders.ts";
import * as colors from "../extensions/designer/engine/core/checks/colors.ts";
import * as cssScan from "../extensions/designer/engine/core/checks/css-scan.ts";
import * as rules from "../extensions/designer/engine/core/checks/css-rules.ts";
import * as docs from "../extensions/designer/engine/core/checks/doc-checks.ts";
import * as elements from "../extensions/designer/engine/core/checks/elements.ts";
import * as htmlPatterns from "../extensions/designer/engine/core/checks/html-patterns.ts";
import * as labels from "../extensions/designer/engine/core/checks/labels.ts";
import * as lengths from "../extensions/designer/engine/core/checks/lengths.ts";
import * as overflow from "../extensions/designer/engine/core/checks/overflow.ts";
import * as pages from "../extensions/designer/engine/core/checks/page.ts";
import * as quality from "../extensions/designer/engine/core/checks/quality.ts";
import * as repeated from "../extensions/designer/engine/core/checks/repeated-text.ts";
import * as labels2 from "../extensions/designer/engine/core/checks/repeated-text.ts";
import * as motion from "../extensions/designer/engine/core/checks/motion.ts";
import * as tells from "../extensions/designer/engine/core/checks/tells.ts";
import * as textVis from "../extensions/designer/engine/core/checks/text-visibility.ts";
import * as overlap from "../extensions/designer/engine/core/checks/overlap.ts";
import * as spotlight from "../extensions/designer/engine/core/checks/spotlight.ts";
import * as typography from "../extensions/designer/engine/core/checks/typography.ts";
import * as text from "../extensions/designer/engine/core/checks/text.ts";
import * as scoped from "../extensions/designer/engine/core/checks/scoped-ignore.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/rules/checks.mjs";

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

// ─── Borders ──────────────────────────────────────────────────────────────

const tags = ["div", "span", "a", "button", "label", "h2", "li"];
const widthSets = [
	{ Top: 0, Right: 0, Bottom: 0, Left: 0 },
	{ Top: 0, Right: 0, Bottom: 0, Left: 4 },
	{ Top: 0, Right: 0, Bottom: 0, Left: 2 },
	{ Top: 0, Right: 0, Bottom: 0, Left: 1 },
	{ Top: 4, Right: 4, Bottom: 4, Left: 4 },
	{ Top: 0, Right: 0, Bottom: 0, Left: 4.5 },
	{ Top: 3, Right: 3, Bottom: 3, Left: 3 },
	{ Top: 0, Right: 1, Bottom: 0, Left: 6 },
	{ Top: 0, Right: 0, Bottom: 0, Left: 40 },
];
const colorSets = [
	{ Top: "rgb(200, 20, 20)", Right: "rgb(200, 20, 20)", Bottom: "rgb(200, 20, 20)", Left: "rgb(200, 20, 20)" },
	{ Top: "rgb(20, 20, 20)", Right: "rgb(20, 20, 20)", Bottom: "rgb(20, 20, 20)", Left: "rgb(20, 20, 20)" },
	{ Top: "transparent", Right: "transparent", Bottom: "transparent", Left: "oklch(0.6 0.2 250)" },
	{ Top: "rgb(20, 20, 20)", Right: "rgb(20, 20, 20)", Bottom: "rgb(20, 20, 20)", Left: "rgb(0, 0, 255)" },
];
const radii = [0, 4, 12, 999];
const optSets = [{}, { badgeLike: true }, { statusContext: true }, { tabContext: true }, { badgeLike: true, tabContext: true }];

for (const tag of tags) {
	for (const widths of widthSets) {
		for (const colors4 of colorSets) {
			for (const radius of radii) {
				for (const opts of optSets) {
					check(
						`checkBorders(${tag}, ${JSON.stringify(widths)}, ${JSON.stringify(colors4)}, ${radius}, ${JSON.stringify(opts)})`,
						borders.checkBorders(tag, widths, colors4, radius, opts),
						ref.checkBorders(tag, widths, colors4, radius, opts),
					);
				}
			}
		}
	}
}

// ─── Colors ───────────────────────────────────────────────────────────────

const rgb = (r, g, b, a = 1) => ({ r, g, b, a });
const textColors = [rgb(20, 20, 20), rgb(255, 255, 255), rgb(140, 140, 140), rgb(120, 40, 200), rgb(255, 255, 255, 0.6), null];
const bgs = [null, rgb(255, 255, 255), rgb(30, 60, 200), rgb(200, 40, 40)];
const stops = [null, [rgb(10, 10, 10), rgb(240, 240, 240)], [rgb(160, 40, 40), rgb(170, 45, 45)]];
const sizes = [
	{ fontSize: 16, fontWeight: 400 },
	{ fontSize: 24, fontWeight: 700 },
	{ fontSize: 32, fontWeight: 400 },
	{ fontSize: 8, fontWeight: 400 },
];
const classLists = [null, "text-gray-400 bg-blue-500", "bg-clip-text bg-gradient-to-r from-purple-500 to-cyan-400", "text-violet-500 text-3xl", "text-sm"];

for (const tag of ["div", "span", "a", "button", "h1", "p"]) {
	for (const textColor of textColors) {
		for (const bgColor of bgs) {
			for (const effectiveBg of [bgs[1], null]) {
				for (const effectiveBgStops of stops) {
					for (const size of sizes) {
						for (const classList of classLists) {
							const opts = {
								tag,
								textColor,
								bgColor,
								effectiveBg,
								effectiveBgStops,
								fontSize: size.fontSize,
								fontWeight: size.fontWeight,
								hasDirectText: true,
								isEmojiOnly: false,
								bgClip: null,
								bgImage: null,
								classList,
							};
							check(
								`checkColors(${JSON.stringify(opts)})`,
								colors.checkColors({ ...opts, mode: "static" }),
								ref.checkColors(opts),
							);
						}
					}
				}
			}
		}
	}
}

for (const tag of ["div", "a", "span", "h2"]) {
	for (const textColor of textColors) {
		for (const bg of [rgb(20, 20, 20), rgb(255, 255, 255), null]) {
			for (const ownBgAlpha of [null, 0.2, 0.8]) {
				for (const size of sizes) {
					const opts = {
						tag,
						textColor,
						bg,
						ownBgAlpha,
						fontSize: size.fontSize,
						fontWeight: size.fontWeight,
						hasDirectText: true,
						isEmojiOnly: false,
					};
					check(`checkHoverContrast(${JSON.stringify(opts)})`, colors.checkHoverContrast(opts), ref.checkHoverContrast(opts));
				}
			}
		}
	}
}

for (const css of [
	"rgb(200, 20, 20)", "rgba(10, 10, 10)", "#c00", "#cccccc", "#1a1aff80",
	"oklch(0.43 0.15 34)", "oklch(43%.15 34)", "oklch(0.7 0.01 250)",
	"hsl(210, 50%, 40%)", "hsl(210, 5%, 40%)", "transparent", "var(--x)", "", null,
]) {
	check(`isAccentColor(${JSON.stringify(css)})`, colors.isAccentColor(css), ref.isAccentColor(css));
}

for (const [hasShadow, hasBorder, hasRadius, hasBg] of [
	[false, false, false, false], [true, false, false, false], [false, true, true, false], [true, true, false, true], [false, false, true, true],
]) {
	check(
		`isCardLikeFromProps(${hasShadow}, ${hasBorder}, ${hasRadius}, ${hasBg})`,
		colors.isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg),
		ref.isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg),
	);
}

// ─── Text ─────────────────────────────────────────────────────────────────

for (const input of ["😀", "😀🎉", "hello", "😀 hi", "", "  ", "→ done", "👨‍👩‍👧‍👦", "✅"]) {
	check(`isEmojiOnlyText(${JSON.stringify(input)})`, text.isEmojiOnlyText(input), ref.isEmojiOnlyText(input));
}

// ─── Scoped ignores ───────────────────────────────────────────────────────

function el(attributes, parent = null) {
	return {
		nodeType: 1,
		parentElement: parent,
		getAttribute(name) {
			return name in attributes ? attributes[name] : null;
		},
	};
}

const trees = [
	["side-tab", el({})],
	["side-tab", el({ "data-impeccable-ignore": "side-tab" })],
	["side-tab", el({ "data-impeccable-ignore": "low-contrast" })],
	["side-tab", el({ "data-impeccable-ignore": "" })],
	["side-tab", el({ "data-impeccable-ignore": "*" })],
	["side-tab", el({}, el({ "data-impeccable-ignore": "SIDE-TAB, other" }))],
	["side-tab", el({}, el({ "data-impeccable-ignore": "other" }))],
	["low-contrast", el({ "data-impeccable-ignore": "side-tab low-contrast" })],
];
for (const [rule, node] of trees) {
	check(`scopedIgnoreActive(${rule})`, scoped.scopedIgnoreActive(node, rule), ref.scopedIgnoreActive(node, rule));
}

// ─── Typography ───────────────────────────────────────────────────────────

for (const fontFamily of [
	"Inter, sans-serif", "'Playfair Display', serif", "Fraunces, serif", "Custom Face, serif",
	"Georgia, 'Times New Roman', serif", "serif", "system-ui, sans-serif", "", null,
]) {
	check(`resolveSerif(${JSON.stringify(fontFamily)})`, typography.resolveSerif(fontFamily), ref.resolveSerif(fontFamily));
}

for (const tag of ["h1", "h2", "h3", "div"]) {
	for (const fontStyle of ["italic", "normal"]) {
		for (const fontFamily of ["'Playfair Display', serif", "Inter, sans-serif"]) {
			for (const fontSize of [16, 40, 48, 72]) {
				const opts = { tag, fontStyle, fontFamily, fontSize, headingText: "A headline" };
				check(`checkItalicSerif(${JSON.stringify(opts)})`, typography.checkItalicSerif(opts), ref.checkItalicSerif(opts));
			}
		}
	}
}

for (const headingTag of ["h1", "h2", "p"]) {
	for (const siblingTag of [null, "h2", "div", "span"]) {
		for (const size of [16, 40, 64]) {
			for (const layout of [
				{ headingTop: 0, siblingBottom: 0 },
				{ headingTop: 300, siblingBottom: 200 },
				{ headingTop: 200, siblingBottom: 260 },
			]) {
				const opts = {
					headingTag, headingText: "Section", siblingTag,
					siblingWidth: size, siblingHeight: size,
					siblingBgColor: { r: 30, g: 30, b: 30, a: 1 }, siblingBgImage: "none",
					siblingBorderWidth: 0, siblingBorderRadius: 8,
					hasIconChild: true, iconChildWidth: 24,
					...layout,
				};
				check(`checkIconTile(${JSON.stringify(opts)})`, typography.checkIconTile(opts), ref.checkIconTile(opts));
			}
		}
	}
}

// `resolveHeroHeadingSizePx` is internal to the reference (not exported), so it has
// no direct oracle. It is exercised through checkHeroEyebrow above.

const eyebrowSiblings = [
	{ siblingTag: "div", siblingText: "NEW FEATURE", siblingTextTransform: "uppercase", siblingLetterSpacing: 2, siblingFontWeight: 400, siblingColor: "rgb(120,120,120)" },
	{ siblingTag: "p", siblingText: "New feature", siblingTextTransform: "none", siblingLetterSpacing: 0, siblingFontWeight: 700, siblingColor: "rgb(200,20,20)" },
	{ siblingTag: "p", siblingText: "New feature", siblingTextTransform: "none", siblingLetterSpacing: 0, siblingFontWeight: 400, siblingColor: "rgb(120,120,120)", siblingHasAccentDashPseudo: true },
	{ siblingTag: "p", siblingText: "Just copy", siblingTextTransform: "none", siblingLetterSpacing: 0, siblingFontWeight: 400, siblingColor: "rgb(20,20,20)" },
	{ siblingTag: "h2", siblingText: "Section", siblingTextTransform: "none", siblingLetterSpacing: 0, siblingFontWeight: 400, siblingColor: "rgb(20,20,20)" },
	{ siblingTag: null },
];
for (const sibling of eyebrowSiblings) {
	for (const headingFontSize of [32, 48, 72]) {
		for (const headingInApplicationContext of [false, true]) {
			const opts = {
				headingTag: "h1",
				headingText: "Headline",
				headingFontSize,
				headingInApplicationContext,
				siblingFontSize: 12,
				...sibling,
			};
			check(`checkHeroEyebrow(${JSON.stringify(opts)})`, typography.checkHeroEyebrow(opts), ref.checkHeroEyebrow(opts));
		}
	}
}

for (const candidates of [
	[],
	[{ kickerText: "FEATURES", headingTag: "h2", headingText: "Everything you need" }],
	[{ kickerText: "A", headingTag: "h1", headingText: "B" }, { kickerText: "C", headingTag: "h2", headingText: "D" }],
	"not-an-array",
]) {
	check(`checkKickerAboveHeading(${JSON.stringify(candidates)})`, typography.checkKickerAboveHeading({ candidates }), ref.checkKickerAboveHeading({ candidates }));
}

// ─── Motion ───────────────────────────────────────────────────────────────

for (const tag of ["div", "span", "a", "section"]) {
	for (const animationName of [null, "none", "bounce", "elastic-in", "fade-in", "springy"]) {
		for (const transitionProperty of [null, "all", "none", "width", "opacity", "width, height", "margin-top, opacity"]) {
			for (const timingFunctions of [null, "cubic-bezier(0.4, 0, 0.2, 1)", "cubic-bezier(0.34, 1.56, 0.64, 1)", "cubic-bezier(-0.2, 0.4, 0.6, 0.8)"]) {
				for (const classList of [null, "animate-bounce", "animate-fade"]) {
					const opts = { tag, animationName, transitionProperty, timingFunctions, classList };
					check(`checkMotion(${JSON.stringify(opts)})`, motion.checkMotion(opts), ref.checkMotion(opts));
				}
			}
		}
	}
}

// ─── Glow and CSS text scans ────────────────────────────────────────────

const shadowCases = [
	{ boxShadow: "0 0 20px rgb(120, 20, 200)" },
	{ boxShadow: "0 0 20px rgb(120, 20, 120)" },
	{ boxShadow: "0 2px 8px rgb(120, 20, 20)" },
	{ boxShadow: "0 0 3px rgb(120, 20, 20)" },
	{ boxShadow: "0 0 20px rgb(20, 20, 20)" },
	{ boxShadow: "0px 0px 20px #7c14c8" },
	{ boxShadow: "inset 0 0 24px oklch(0.6 0.2 250)" },
	{ boxShadow: "0 2px 8px #c01414, 0 0 30px #7c14c8" },
	{ boxShadow: "0 0 20px var(--glow)" },
	{ textShadow: "0 0 30px rgba(200, 20, 20, 0.8)" },
	{ textShadow: "1px 1px 0 #000" },
	{ boxShadow: "none" },
	{},
	{ boxShadow: "0 0 20px red", effectiveBg: { r: 10, g: 10, b: 10, a: 1 } },
	{ boxShadow: "0 4px 20px #c81414", effectiveBg: { r: 10, g: 10, b: 10, a: 1 } },
	{ boxShadow: "0 4px 20px #c81414", effectiveBg: { r: 245, g: 245, b: 245, a: 1 } },
];
for (const opts of shadowCases) {
	check(`checkGlow(${JSON.stringify(opts)})`, cssScan.checkGlow(opts), ref.checkGlow(opts));
}

const cssSamples = [
	"",
	".card { box-shadow: 0 0 20px rgb(120, 20, 200); }",
	":root { --glow: rgb(120, 20, 200); } .card { box-shadow: 0 0 20px var(--glow); }",
	":root { --accent: rgb(120, 20, 200); } body { background: #0b0b0f; } .card { box-shadow: 0 4px 20px var(--accent); }",
	"body { background: #ffffff; } .card { box-shadow: 0 4px 20px rgb(200, 20, 20); }",
	"body { background: rgb(8, 8, 12); } .halo { background: radial-gradient(circle at 50% 0%, rgb(120, 20, 200) 0%, transparent 70%); }",
	"body { background: #fff; } .halo { background: radial-gradient(circle, rgb(120, 20, 200), transparent); }",
	"body { background: #0b0b0f; } .halo { background: radial-gradient(circle, rgba(120,20,200,0.4), transparent); }",
	"body { background: #0b0b0f; } .halo { background: repeating-radial-gradient(circle, rgb(120,20,200), transparent 8px); }",
	"body { background: #0b0b0f; } .grid { background-image: linear-gradient(to right, #222 1px, transparent 1px), linear-gradient(to bottom, #222 1px, transparent 1px); background-size: 32px 32px; }",
	".one { background-image: linear-gradient(to right, #222 1px, transparent 1px); background-size: 32px 32px; }",
	".dots { background-image: radial-gradient(circle, #222 2px, transparent 2px); background-size: 16px 16px; }",
];
for (const content of cssSamples) {
	check(`scanCssTextForGlow(${JSON.stringify(content.slice(0, 40))})`, cssScan.scanCssTextForGlow(content), ref.scanCssTextForGlow(content));
	check(`scanCssTextForRadialHalo(${JSON.stringify(content.slice(0, 40))})`, cssScan.scanCssTextForRadialHalo(content), ref.scanCssTextForRadialHalo(content));
	check(`scanCssTextForGridBackground(${JSON.stringify(content.slice(0, 40))})`, cssScan.scanCssTextForGridBackground(content), ref.scanCssTextForGridBackground(content));
}
// `findShadowColor` and `extractShadowLengths` are internal to the reference, so they
// have no direct oracle. checkGlow and scanCssTextForGlow above exercise them.
for (const raw of ["var(--a)", "var(--a, 10px)", "var(--a, var(--b))", "var(--a, var(--b, red))", "solid var(--x) 2px"]) {
	check(`resolveVarRefs(${JSON.stringify(raw)})`, cssScan.resolveVarRefs(raw, new Map([["--a", "var(--b)"], ["--b", "rgb(1,2,3)"]])), ref.resolveVarRefs(raw, new Map([["--a", "var(--b)"], ["--b", "rgb(1,2,3)"]])));
}
for (const content of ["--a: 1px; --b: red;", ":root{--x: 10px;}", "--dup: 1; --dup: 2;"]) {
	check(`collectCssCustomProps(${JSON.stringify(content)})`, [...cssScan.collectCssCustomProps(content)], [...ref.collectCssCustomProps(content)]);
}

// ─── CSS rule-level scanners ───────────────────────────────────────

const ruleSamples = [
	"",
	".card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: rgb(200, 20, 20); }",
	".card::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 4px; background: rgb(200, 20, 20); }",
	".card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: rgb(20, 20, 20); }",
	".card::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 4px; background: #c81414; }",
	"a::after { content: ''; position: absolute; inset: auto 0 0 0; height: 3px; background: #c81414; }",
	".tab[aria-selected=\"true\"]::after { content: ''; position: absolute; inset: auto 0 0 0; height: 3px; background: #c81414; }",
	"/* .card::before { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: #c81414; } */",
	".item { box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	".item { box-shadow: inset 4px 0 8px rgb(200, 20, 20); }",
	".item { box-shadow: inset 0 4px 0 rgb(200, 20, 20); }",
	".item.active { box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	".logo { width: 24px; box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	"<marquee>hi</marquee>",
	"@keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } } .ticker { animation: ticker 20s linear infinite; }",
	"@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } } .dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }",
	"@keyframes spin { to { transform: rotate(360deg); } } .dot { width: 8px; height: 8px; border-radius: 50%; animation: spin 2s infinite; }",
	"@keyframes pulse { 0% { opacity: 1; } } @media (prefers-reduced-motion: reduce) { .dot { animation: none; } } .dot { width: 6px; height: 6px; border-radius: 50%; animation: pulse 1s infinite; }",
	"<header><span class=\".dot\"></span></header> @keyframes pulse { 0% { opacity: 1; } } .dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }",
	"<span class=\"w-2 h-2 rounded-full animate-ping\"></span>",
	"<header><span class=\"h-1.5 w-1.5 rounded-full animate-pulse\"></span></header>",
	".a, .b { width: 4px; } .a { height: 4px; border-radius: 50%; animation: pulse 1s infinite; }",
];
for (const content of ruleSamples) {
	check(`scanCssTextForPseudoStripe(${JSON.stringify(content.slice(0, 34))})`, rules.scanCssTextForPseudoStripe(content), ref.scanCssTextForPseudoStripe(content));
	check(`scanCssTextForInsetStripe(${JSON.stringify(content.slice(0, 34))})`, rules.scanCssTextForInsetStripe(content), ref.scanCssTextForInsetStripe(content));
	check(`scanCssTextForMarquee(${JSON.stringify(content.slice(0, 34))})`, rules.scanCssTextForMarquee(content), ref.scanCssTextForMarquee(content));
	check(`scanCssTextForPulsingDot(${JSON.stringify(content.slice(0, 34))})`, rules.scanCssTextForPulsingDot(content), ref.scanCssTextForPulsingDot(content));
	check(`collectMarqueeKeyframes(${JSON.stringify(content.slice(0, 34))})`, [...rules.collectMarqueeKeyframes(content)], [...ref.collectMarqueeKeyframes(content)]);
	// `collectPulseKeyframes` is internal to the reference; scanCssTextForPulsingDot above exercises it.
}
// `parseCssDeclBlock`, `isZeroOffset`, `infiniteAnimationNames`, `isRoundDotRadius`,
// `stripReducedMotionBlocks`, `landmarkSourceRanges` and `collectPulseKeyframes` are
// internal to the reference; the exported scans above exercise them.
for (const value of ["4px", "2rem", "3em", "1.5PX", "auto", null, ""]) {
	check(`cssLengthToPx(${JSON.stringify(value)})`, rules.cssLengthToPx(value), ref.cssLengthToPx(value));
}

// ─── HTML patterns ──────────────────────────────────────────────────

const htmlSamples = [
	"",
	"<div class=\"p-4 m-4 py-4\"></div>",
	"<style>.t { padding: 16px; margin: 16px; gap: 16px; }</style>",
	"<style>.t { padding: 16px; margin: 16px; gap: 16px; } .u { padding: 16px; margin: 16px; } .v { padding: 16px; gap: 16px; } .w { padding: 16px; margin: 16px; } .x { padding: 16px; }</style>",
	"<style>.h { background-clip: text; background-image: linear-gradient(red, blue); }</style>",
	"<p class=\"bg-clip-text bg-gradient-to-r\">x</p>",
	"<style>.p { color: #7c3aed; }</style>",
	"<style>.p { background: linear-gradient(#7c3aed, #667eea); color: #111; }</style>",
	"<style>.b { animation: bounce 1s infinite; }</style>",
	"<style>.b { transition: width 200ms ease; }</style>",
	"<style>.b { transition: all 200ms ease; }</style>",
	"<style>.s { background: repeating-linear-gradient(45deg, #eee 0 10px, #fff 10px 20px); }</style>",
	"<style>.g { background-image: linear-gradient(to right, #222 1px, transparent 1px), linear-gradient(to bottom, #222 1px, transparent 1px); background-size: 32px 32px; }</style>",
	"<style>.c { clip-path: polygon(0% 25%, 10% 18%, 22% 12%, 34% 9%, 46% 11%, 58% 16%, 70% 22%, 82% 33%, 90% 46%, 95% 60%, 96% 74%, 92% 86%, 84% 94%, 72% 98%, 58% 97%); }</style>",
	"<style>.c { clip-path: polygon(0 0, 50% 0, 100% 0, 100% 100%, 50% 100%, 0 100%); }</style>",
	"<style>.c { clip-path: path('M0 0 C 10 10, 20 20, 30 30 S 40 40 50 50 Q 60 60 70 70 T 80 80'); }</style>",
	"<style>.r { background-image: linear-gradient(rgba(255,255,255,0.95), rgba(250,250,250,0.92)), url(tex.png); }</style>",
	"<style>.r { background-image: linear-gradient(rgba(255,255,255,0.4), rgba(250,250,250,0.5)), url(tex.png); }</style>",
	"<style>.r { background-image: url(tex.png), linear-gradient(#000, #000); }</style>",
	"<style>.r { background-image: linear-gradient(#fff, #fff), url(tex.png); background-blend-mode: multiply; }</style>",
	"<p>This is the content theater of the page.</p>",
	"<style>img:hover { transform: scale(1.05); }</style>",
	"<img class=\"hover:scale-105\" src=\"a.png\">",
	"<svg width=\"400\" height=\"300\"><rect fill=\"#c00\"/><circle fill=\"#0c0\"/><ellipse fill=\"#00c\"/><rect fill=\"#c00\"/><circle fill=\"#0c0\"/><ellipse fill=\"#00c\"/><rect fill=\"#c00\"/><circle fill=\"#0c0\"/></svg>",
	"<svg width=\"24\" height=\"24\"><rect fill=\"#c00\"/><circle fill=\"#0c0\"/><ellipse fill=\"#00c\"/><rect/><circle/><ellipse/><rect/><circle/></svg>",
	"<code>background-clip: text</code><pre>.x { background-clip: text; background-image: linear-gradient(red, blue); }</pre>",
];
for (const html of htmlSamples) {
	check(`checkHtmlPatterns(${JSON.stringify(html.slice(0, 30))})`, htmlPatterns.checkHtmlPatterns(html), ref.checkHtmlPatterns(html));
	check(`buildHtmlPatternCorpora(${JSON.stringify(html.slice(0, 30))})`, htmlPatterns.buildHtmlPatternCorpora(html), ref.buildHtmlPatternCorpora(html));
	check(`scanCssTextForOrganicClipPath(${JSON.stringify(html.slice(0, 30))})`, htmlPatterns.scanCssTextForOrganicClipPath(html), ref.scanCssTextForOrganicClipPath(html));
	check(`scanCssTextForBuriedRaster(${JSON.stringify(html.slice(0, 30))})`, htmlPatterns.scanCssTextForBuriedRaster(html), ref.scanCssTextForBuriedRaster(html));
	check(`scanHtmlForShapeAssembledIllustration(${JSON.stringify(html.slice(0, 30))})`, htmlPatterns.scanHtmlForShapeAssembledIllustration(html), ref.scanHtmlForShapeAssembledIllustration(html));
}

// ─── Background resolution ──────────────────────────────────────

function fakeTree(spec) {
	// spec is a chain from the element upward: [{style}, {style}, ...]
	const styles = new Map();
	let parent = null;
	const nodes = [];
	for (const entry of [...spec].reverse()) {
		const node = {
			nodeType: 1,
			parentElement: parent,
			getAttribute: (name) => (name === "style" ? entry.inline ?? null : null),
		};
		styles.set(node, { backgroundColor: entry.bg ?? "rgba(0, 0, 0, 0)", backgroundImage: entry.image ?? "none", color: entry.color ?? "rgb(0, 0, 0)" });
		parent = node;
		nodes.unshift(node);
	}
	return { el: nodes[0], host: { getComputedStyle: (n) => styles.get(n) } };
}

const bgTrees = [
	[{ bg: "rgb(255, 255, 255)" }],
	[{ bg: "rgb(10, 10, 10)" }],
	[{ bg: "rgba(0, 0, 0, 0)" }, { bg: "rgb(20, 20, 20)" }],
	[{ bg: "oklch(0.6 0.2 250)" }],
	[{ bg: "rgba(0, 0, 0, 0)", image: "linear-gradient(rgb(10, 10, 10), rgb(40, 40, 40))" }],
	[{ bg: "rgba(0, 0, 0, 0)", image: "url(a.png), linear-gradient(rgb(10, 10, 10), rgb(40, 40, 40))" }],
	[{ bg: "rgba(0, 0, 0, 0)", image: "linear-gradient(rgb(10, 10, 10), rgb(40, 40, 40)), url(a.png)" }],
	[{ bg: "rgba(0, 0, 0, 0)", image: "linear-gradient(rgba(255,255,255,0.2), rgba(255,255,255,0.2)), url(a.png)" }],
	[{ bg: "rgba(0, 0, 0, 0.5)" }, { bg: "rgb(200, 200, 200)" }],
	[{ bg: "var(--surface)" }, { bg: "rgb(30, 30, 30)" }],
	[{ bg: "rgba(0, 0, 0, 0)", inline: "background: #123456" }],
	[{ bg: "currentcolor", color: "rgb(9, 9, 9)" }],
	[{ bg: "rgba(0, 0, 0, 0)", image: "none" }],
];
const tokenMap = new Map([["--surface", "rgb(45, 45, 45)"]]);
for (const spec of bgTrees) {
	const { el, host } = fakeTree(spec);
	const win = { getComputedStyle: host.getComputedStyle };
	const label = JSON.stringify(spec);
	check(`readOwnBackgroundColor(${label})`, background.readOwnBackgroundColor(el, host.getComputedStyle(el), "static"), ref.readOwnBackgroundColor(el, host.getComputedStyle(el)));
	// `readCascadeBackgroundColor` is internal to the reference; resolveBackgroundInfo below exercises it.
	check(`resolveBackgroundInfo(${label})`, background.resolveBackgroundInfo(el, host, tokenMap, "static"), ref.resolveBackgroundInfo(el, win, tokenMap));
	check(`resolveBackground(${label})`, background.resolveBackground(el, host, tokenMap, "static"), ref.resolveBackground(el, win, tokenMap));
	check(`resolveGradientStops(${label})`, background.resolveGradientStops(el, host, tokenMap, "static"), ref.resolveGradientStops(el, win, tokenMap));
}
for (const [value, width] of [["12px", 100], ["50%", 200], ["12px 4px", 100], ["50%", null], ["auto", 100], ["", 100], [null, 100]]) {
	check(`parseRadiusToPx(${JSON.stringify(value)}, ${width})`, background.parseRadiusToPx(value, width), ref.parseRadiusToPx(value, width));
}
for (const radius of ["8px", "50%", "auto", undefined]) {
	check(`resolveBorderRadiusPx(${JSON.stringify(radius)})`, background.resolveBorderRadiusPx({ backgroundColor: "", borderRadius: radius }, 200), ref.resolveBorderRadiusPx(null, { borderRadius: radius }, 200, null));
}

// ─── Element adapters ───────────────────────────────────────────

const defaultStyle = {
	visibility: "visible",
	display: "block",
	opacity: "1",
	backgroundColor: "rgba(0, 0, 0, 0)",
	backgroundImage: "none",
	color: "rgb(0, 0, 0)",
	borderRadius: "0px",
	borderTopWidth: "0px",
	borderRightWidth: "0px",
	borderBottomWidth: "0px",
	borderLeftWidth: "0px",
	borderTopColor: "rgb(0, 0, 0)",
	borderRightColor: "rgb(0, 0, 0)",
	borderBottomColor: "rgb(0, 0, 0)",
	borderLeftColor: "rgb(0, 0, 0)",
	fontSize: "16px",
	fontWeight: "400",
	fontStyle: "normal",
	fontFamily: "Inter, sans-serif",
};

function makeEl({ tag = "div", style = {}, pseudo = {}, text = "", children = [], attributes = {}, rect, closestMap = {}, previousElementSibling = null } = {}) {
	const el = {
		nodeType: 1,
		tagName: tag.toUpperCase(),
		parentElement: null,
		previousElementSibling,
		childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
		children,
		textContent: text,
		className: attributes.class ?? "",
		getAttribute: (name) => (name in attributes ? attributes[name] : null),
		closest: (selector) => closestMap[selector] ?? null,
		querySelector: () => children.find((c) => c.__isIcon) ?? null,
		getBoundingClientRect: () => rect ?? { width: 300, height: 120, top: 0, bottom: 120, left: 0, right: 300 },
		__styles: { "": { ...defaultStyle, ...style }, ...pseudo },
	};
	return el;
}

// The reference reads the ambient browser globals and snapshots that at module
// load, so the element adapters need a fresh module instance that saw a `window`.
const styleOf = (el, pseudo) => el?.__styles?.[pseudo ?? ""] ?? defaultStyle;
globalThis.getComputedStyle = styleOf;
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
const refBrowser = await import("../reference/impeccable-js/scripts/detector/rules/checks.mjs?browser");
const dom = { getComputedStyle: styleOf };

const statusRegion = makeEl({ tag: "div" });
const tabItem = makeEl({ tag: "li" });

const borderCases = [
	makeEl({ style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200, 20, 20)", borderRadius: "8px" } }),
	makeEl({ tag: "label", style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200, 20, 20)" } }),
	makeEl({ style: { borderTopWidth: "4px", borderTopColor: "#c81414" } }),
	makeEl({ style: { borderLeftWidth: "1px", borderLeftColor: "rgb(200, 20, 20)" } }),
	makeEl({ style: { borderLeftWidth: "4px", borderLeftColor: "rgb(20, 20, 20)" } }),
	makeEl({ style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200, 20, 20)", backgroundColor: "rgb(30,30,30)" }, closestMap: { '[role="status"], [role="alert"], [role="alertdialog"], [role="log"], [aria-live="polite"], [aria-live="assertive"]': statusRegion } }),
	makeEl({ style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200, 20, 20)" }, closestMap: { '[aria-selected="true"], [aria-current]:not([aria-current="false"])': tabItem } }),
	makeEl({ rect: { width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10 }, style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200, 20, 20)" } }),
];
borderCases.forEach((el, i) => {
	check(`checkElementBordersDOM(#${i})`, elements.checkElementBordersDOM(el, dom), refBrowser.checkElementBordersDOM(el));
});

const pseudoCases = [
	makeEl({ pseudo: { "::before": { ...defaultStyle, content: '""', position: "absolute", width: "4px", height: "120px", left: "0px", top: "0px", backgroundColor: "rgb(200, 20, 20)" } } }),
	makeEl({ pseudo: { "::before": { ...defaultStyle, content: '""', position: "absolute", width: "4px", height: "120px", left: "0px", top: "0px", backgroundColor: "rgb(20, 20, 20)" } } }),
	makeEl({ tag: "a", style: { borderRadius: "8px" }, pseudo: { "::after": { ...defaultStyle, content: '""', position: "absolute", width: "300px", height: "3px", left: "0px", bottom: "0px", backgroundColor: "#c81414" } } }),
	makeEl({ style: { borderRadius: "8px" }, pseudo: { "::after": { ...defaultStyle, content: '""', position: "absolute", width: "300px", height: "3px", left: "0px", bottom: "0px", backgroundColor: "#c81414" } } }),
	makeEl({ style: { display: "none" }, pseudo: { "::before": { ...defaultStyle, content: '""', position: "absolute", width: "4px", height: "120px", left: "0px", top: "0px", backgroundColor: "#c81414" } } }),
];
pseudoCases.forEach((el, i) => {
	check(`checkElementPseudoStripeDOM(#${i})`, elements.checkElementPseudoStripeDOM(el, dom), refBrowser.checkElementPseudoStripeDOM(el));
});

const colorCases = [
	makeEl({ text: "Hello", style: { color: "rgb(250, 250, 250)", backgroundColor: "rgb(240, 240, 240)" } }),
	makeEl({ text: "Hello", style: { color: "rgb(120, 120, 120)", backgroundColor: "rgb(20, 20, 20)" } }),
	makeEl({ tag: "h1", text: "Title", style: { color: "rgb(120, 40, 200)" } }),
	makeEl({ text: "Hi", style: { color: "oklch(0.9 0.02 250)", backgroundColor: "oklch(0.95 0.01 250)" } }),
	makeEl({ text: "Hi", style: { visibility: "hidden" } }),
	makeEl({ text: "Hi", style: { opacity: "0" } }),
	makeEl({ text: "Hi", attributes: { class: "text-gray-400 bg-blue-500" } }),
];
colorCases.forEach((el, i) => {
	check(`checkElementColorsDOM(#${i})`, elements.checkElementColorsDOM(el, dom, null, "browser"), refBrowser.checkElementColorsDOM(el));
});

const iconTileCases = [
	makeEl({
		tag: "h2",
		text: "Features",
		rect: { width: 300, height: 40, top: 200, bottom: 240, left: 0, right: 300 },
		previousElementSibling: makeEl({
			tag: "div",
			rect: { width: 64, height: 64, top: 100, bottom: 164, left: 0, right: 64 },
			style: { backgroundColor: "rgb(30, 30, 30)", borderRadius: "12px" },
			children: [{ __isIcon: true, getBoundingClientRect: () => ({ width: 24, height: 24 }) }],
		}),
	}),
	makeEl({ tag: "h2", text: "Features", previousElementSibling: makeEl({ tag: "h3", text: "Other" }) }),
	makeEl({ tag: "p", text: "Not a heading", previousElementSibling: makeEl({ tag: "div" }) }),
];
iconTileCases.forEach((el, i) => {
	check(`checkElementIconTileDOM(#${i})`, elements.checkElementIconTileDOM(el, dom), refBrowser.checkElementIconTileDOM(el));
});

const eyebrowCases = [
	makeEl({ tag: "h1", text: "Headline", style: { fontSize: "64px" }, previousElementSibling: makeEl({ tag: "p", text: "NEW FEATURE", style: { textTransform: "uppercase", fontSize: "12px", letterSpacing: "2px" } }) }),
	makeEl({ tag: "h1", text: "Headline", style: { fontSize: "32px" }, previousElementSibling: makeEl({ tag: "p", text: "NEW FEATURE", style: { textTransform: "uppercase", fontSize: "12px", letterSpacing: "2px" } }) }),
	makeEl({ tag: "h1", text: "Headline", style: { fontSize: "64px" }, previousElementSibling: makeEl({ tag: "p", text: "New feature", style: { fontWeight: "700", color: "rgb(200, 20, 20)", fontSize: "12px" } }) }),
	makeEl({ tag: "h1", text: "Headline", style: { fontSize: "64px" }, previousElementSibling: makeEl({ tag: "p", text: "Plain", style: { fontSize: "12px" } }) }),
	makeEl({ tag: "h2", text: "Headline", previousElementSibling: makeEl({ tag: "p", text: "NEW FEATURE" }) }),
];
eyebrowCases.forEach((el, i) => {
	check(`checkElementHeroEyebrowDOM(#${i})`, elements.checkElementHeroEyebrowDOM(el, dom), refBrowser.checkElementHeroEyebrowDOM(el));
});

const italicCases = [
	makeEl({ tag: "h1", text: "Title", style: { fontStyle: "italic", fontFamily: "'Playfair Display', serif", fontSize: "72px" } }),
	makeEl({ tag: "h1", text: "Title", style: { fontStyle: "italic", fontFamily: "Inter, sans-serif", fontSize: "72px" } }),
	makeEl({ tag: "h3", text: "Title", style: { fontStyle: "italic", fontFamily: "'Playfair Display', serif", fontSize: "72px" } }),
];
italicCases.forEach((el, i) => {
	check(`checkElementItalicSerifDOM(#${i})`, elements.checkElementItalicSerifDOM(el, dom), refBrowser.checkElementItalicSerifDOM(el));
});

// ─── Labels ──────────────────────────────────────────────────

const kickerSpecs = [
	{ level: 2, heading: "Features", size: 40, tag: "p", text: "FEATURES", track: 2, tsize: 12, transform: "uppercase" },
	{ level: 2, heading: "Features", size: 40, tag: "p", text: "FEATURES", track: 0.2, tsize: 12, transform: "uppercase" },
	{ level: 2, heading: "Features", size: 40, tag: "p", text: "Features", track: 2, tsize: 12, transform: "none" },
	{ level: 2, heading: "Features", size: 40, tag: "div", text: "STEP 2", track: 2, tsize: 11, transform: "uppercase" },
	{ level: 2, heading: "Track", size: 40, tag: "p", text: "2024", track: 2, tsize: 12, transform: "uppercase" },
	{ level: 2, heading: "Track", size: 40, tag: "p", text: "Section 4.2", track: 2, tsize: 12, transform: "uppercase" },
	{ level: 5, heading: "Features", size: 40, tag: "p", text: "NEW", track: 2, tsize: 12, transform: "uppercase" },
	{ level: 2, heading: "Features", size: 18, tag: "p", text: "NEW", track: 2, tsize: 12, transform: "uppercase" },
	{ level: 2, heading: "Features", size: 40, tag: "h3", text: "NEW", track: 2, tsize: 12, transform: "uppercase" },
];
kickerSpecs.forEach((s, i) => {
	const opts = {
		headingLevel: s.level,
		headingText: s.heading,
		headingFontSize: s.size,
		kickerTag: s.tag,
		kickerText: s.text,
		kickerTextTransform: s.transform,
		kickerFontVariant: "",
		kickerFontSize: s.tsize,
		kickerLetterSpacing: s.track,
	};
	check(`isKickerCandidate(#${i})`, labels.isKickerCandidate(opts), ref.isKickerCandidate(opts));
});

for (const text of ["01", "1", "12", "04 — Intro", "3 · Pricing", "Intro", "12345", "40 — Max", "41 — Over", ""] ) {
	check(`parseNumberedLabelText(${JSON.stringify(text)})`, labels.parseNumberedLabelText(text), ref.parseNumberedLabelText(text));
}

for (const [tag, text] of [["p", "— a long — page — full — of — dashes — everywhere — here — yes"], ["p", "short — one — dash"], ["p", "plain prose without dashes at all"]]) {
	check(`checkEmDashOveruse(${tag}:${text.slice(0, 20)})`, labels.checkEmDashOveruse(text), ref.checkEmDashOveruse(text));
}

const numberedSpecs = [
	{ headingTag: "h2", headingText: "Pricing", headingFontSize: 40, labelTag: "span", labelIndex: 1, labelText: "01", labelFontSize: 12, labelLetterSpacing: 0, labelFontWeight: "700", labelFontFamily: "Inter, sans-serif", labelTextTransform: "none", labelColor: "rgb(20,20,20)" },
	{ headingTag: "h2", headingText: "Pricing", headingFontSize: 40, labelTag: "span", labelIndex: 1, labelText: "01", labelFontSize: 18, labelLetterSpacing: 0, labelFontWeight: "700", labelFontFamily: "", labelTextTransform: "none", labelColor: "rgb(20,20,20)" },
	{ headingTag: "h5", headingText: "Pricing", headingFontSize: 40, labelTag: "span", labelIndex: 1, labelText: "01", labelFontSize: 12, labelLetterSpacing: 0, labelFontWeight: "400", labelFontFamily: "", labelTextTransform: "none", labelColor: "rgb(20,20,20)" },
	{ headingTag: "h2", headingText: "Pricing", headingFontSize: 12, labelTag: "span", labelIndex: 1, labelText: "01", labelFontSize: 12, labelLetterSpacing: 0, labelFontWeight: "700", labelFontFamily: "", labelTextTransform: "none", labelColor: "rgb(20,20,20)" },
	{ headingTag: "h2", headingText: "Pricing", headingFontSize: 40, labelTag: "span", labelIndex: 1, labelText: "01", labelFontSize: 12, labelLetterSpacing: 2, labelFontWeight: "400", labelFontFamily: "", labelTextTransform: "uppercase", labelColor: "rgb(20,20,20)" },
];
numberedSpecs.forEach((s, i) => {
	check(`isNumberedSectionLabelCandidate(#${i})`, labels.isNumberedSectionLabelCandidate(s), ref.isNumberedSectionLabelCandidate(s));
});

for (const candidates of [
	[{ index: 1, labelText: "01", headingTag: "h2", headingText: "A" }, { index: 2, labelText: "02", headingTag: "h2", headingText: "B" }],
	[{ index: 1, labelText: "01", headingTag: "h2", headingText: "A" }],
	[{ index: 1, labelText: "01", headingTag: "h2", headingText: "A" }, { index: 1, labelText: "01", headingTag: "h2", headingText: "B" }],
	"nope",
]) {
	check(`checkNumberedSectionLabels(${JSON.stringify(candidates).slice(0, 30)})`, labels.checkNumberedSectionLabels({ candidates }), ref.checkNumberedSectionLabels({ candidates }));
}

// ─── Repeated container text ──────────────────────────────────

function node({ tag = "div", cls = "", text = "", style = {}, children = [] } = {}) {
	const el = {
		nodeType: 1,
		tagName: tag.toUpperCase(),
		parentElement: null,
		previousElementSibling: null,
		children: [],
		className: cls,
		getAttribute: (name) => (name === "class" ? cls : null),
		closest: () => null,
		childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
		textContent: text,
		__styles: { "": { ...defaultStyle, ...style } },
	};
	el.children = children;
	children.forEach((c) => (c.parentElement = el));
	const all = [el];
	for (const c of children) all.push(...c.querySelectorAll("*"));
	el.querySelectorAll = (selector) => (selector === "*" ? all.slice(1) : []);
	return el;
}

const cardStyle = { boxShadow: "0 1px 2px rgba(0,0,0,0.2)", borderRadius: "12px", backgroundColor: "rgb(255,255,255)" };
const plainStyle = {};
const repeatedDoc = node({
	tag: "div",
	style: cardStyle,
	children: [
		node({ tag: "p", cls: "a", text: "Crafted with care", style: plainStyle }),
		node({ tag: "div", style: plainStyle, children: [node({ tag: "span", cls: "b", text: "Crafted with care", style: plainStyle })] }),
		node({ tag: "section", style: plainStyle, children: [node({ tag: "em", cls: "c", text: "Crafted with care", style: plainStyle })] }),
	],
});
const parallelDoc = node({
	tag: "div",
	style: cardStyle,
	children: [
		node({ tag: "p", cls: "same", text: "Crafted with care", style: plainStyle }),
		node({ tag: "p", cls: "same", text: "Crafted with care", style: plainStyle }),
		node({ tag: "p", cls: "same", text: "Crafted with care", style: plainStyle }),
	],
});
const sparseDoc = node({
	tag: "div",
	style: cardStyle,
	children: [
		node({ tag: "p", text: "Crafted with care", style: plainStyle }),
		node({ tag: "p", text: "Different copy here", style: plainStyle }),
	],
});

const repeatedStyleOf = (el) => el?.__styles?.[""] ?? defaultStyle;
for (const [label, doc] of [["distinct paths", repeatedDoc], ["parallel", parallelDoc], ["sparse", sparseDoc]]) {
	check(
		`collectRepeatedContainerTextFindings(${label})`,
		labels2.collectRepeatedContainerTextFindings(doc, repeatedStyleOf, {}),
		refBrowser.collectRepeatedContainerTextFindings(doc, repeatedStyleOf, {}),
	);
}
for (const style of [cardStyle, plainStyle, { borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px" }, { boxShadow: "none" }]) {
	check(`isRepeatedTextContainer(${JSON.stringify(style)})`, labels2.isRepeatedTextContainer(style), refBrowser.isRepeatedTextContainer(style));
}

// ─── Quality ─────────────────────────────────────────────────

function qualityEl({ tag = "div", style = {}, text = "", children = [], attributes = {}, rect = null, closest = {} } = {}) {
	return {
		nodeType: 1,
		tagName: tag.toUpperCase(),
		parentElement: null,
		childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
		children,
		textContent: text,
		className: attributes.class ?? "",
		getAttribute: (name) => (name in attributes ? attributes[name] : null),
		closest: (selector) => closest[selector] ?? null,
		matches: () => false,
		querySelectorAll: () => [],
		getBoundingClientRect: () => rect,
		__styles: { "": { ...defaultStyle, ...style } },
	};
}

const qualityCases = [
	qualityEl({ tag: "p", text: "A long paragraph of body copy that keeps going for a while.", style: { paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px", borderLeftWidth: "1px", borderRightWidth: "1px", borderTopWidth: "1px", borderBottomWidth: "1px", borderLeftColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderTopColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)" }, rect: { width: 400, height: 200, top: 0, bottom: 200, left: 0, right: 400 } }),
	qualityEl({ tag: "p", text: "x".repeat(400), style: {}, rect: { width: 1200, height: 100, top: 0, bottom: 100, left: 0, right: 1200 } }),
	qualityEl({ tag: "p", text: "Tiny body text that runs long enough to trip the floor.", style: { fontSize: "10px" }, rect: { width: 300, height: 100, top: 0, bottom: 100, left: 0, right: 300 } }),
	qualityEl({ tag: "span", text: "Home", style: { fontSize: "8px" }, closest: { 'a[href], button, summary, label, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [tabindex]': {} } }),
	qualityEl({ tag: "p", text: "Justified body copy that is long enough to matter.", style: { textAlign: "justify" } }),
	qualityEl({ tag: "p", text: "".padEnd(60, "a"), style: {}, rect: { width: 300, height: 60, top: 0, bottom: 60, left: 0, right: 300 } }),
	qualityEl({ tag: "p", text: "".padEnd(30, "b"), style: { letterSpacing: "2px" } }),
	qualityEl({ tag: "p", text: "".padEnd(30, "c"), style: { letterSpacing: "-2px" } }),
	qualityEl({ tag: "p", text: "".padEnd(40, "d"), style: { textTransform: "uppercase" } }),
	qualityEl({ tag: "p", text: "".padEnd(60, "e"), style: {}, rect: { width: 800, height: 80, top: 0, bottom: 80, left: 4, right: 804 } }),
	qualityEl({ tag: "img", text: "", style: { opacity: "0.05", backgroundImage: "url(x.png)" } }),
	qualityEl({ tag: "div", text: "", style: { opacity: "0.05", backgroundImage: "url(x.png)" } }),
	qualityEl({ tag: "p", text: "", style: { display: "none", fontSize: "9px" } }),
];

qualityCases.forEach((el, i) => {
	const style = el.__styles[""];
	const fontSize = parseFloat(style.fontSize) || 16;
	const lineHeightPx = lengths.resolveLengthPx(style.lineHeight ?? null, fontSize);
	const letterSpacingPx = lengths.resolveLengthPx(style.letterSpacing ?? null, fontSize);
	const textContent = el.textContent ?? "";
	const hasDirectText = el.childNodes.some((n) => n.nodeType === 3 && n.textContent.trim().length > 10);
	const shared = {
		el,
		tag: el.tagName.toLowerCase(),
		style,
		hasDirectText,
		textLen: textContent.trim().length,
		fontSize,
		lineHeightPx,
		letterSpacingPx,
		rect: el.getBoundingClientRect(),
		lineMax: 80,
		viewportWidth: 1000,
	};
	check(
		`checkQuality(#${i})`,
		quality.checkQuality({ ...shared, dom }),
		ref.checkQuality({ ...shared, win: null }),
	);
});

const headingDoc = {
	querySelectorAll: () => [
		{ tagName: "H1", textContent: "Title" },
		{ tagName: "H4", textContent: "Jumped" },
		{ tagName: "H2", textContent: "Next section" },
	],
};
check("checkPageQualityFromDoc", quality.checkPageQualityFromDoc(headingDoc), ref.checkPageQualityFromDoc(headingDoc));

// `cssColorIsTransparent` and `colorsNearlyMatch` are internal to the reference;
// checkQuality above exercises them.
for (const length of ["20px", "1.5rem", "1.5em", "120%", "1.5", "normal", "auto", "", null]) {
	check(`resolveLengthPx(${JSON.stringify(length)})`, lengths.resolveLengthPx(length, 16), ref.resolveLengthPx(length, 16));
}

// ─── Style-object element checks ─────────────────────────────

const docHost = {
	getComputedStyle: styleOf,
	getPseudoSurface: () => null,
	getHoverStyle: (el) => el.__hover ?? null,
	hasAccentDashPseudo: () => false,
};

const docStyleCases = [
	{ tag: "div", style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200,20,20)", borderRadius: "8px" } },
	{ tag: "label", style: { borderLeftWidth: "4px", borderLeftColor: "rgb(200,20,20)" } },
	{ tag: "div", style: { borderLeftWidth: "0px", borderLeftColor: "" }, overrides: { Left: { width: 4, color: "rgb(200,20,20)" } } },
	{ tag: "div", style: { borderLeftWidth: "4px", borderLeftColor: "var(--x)" }, overrides: { Left: { width: 4, color: "rgb(200,20,20)" } } },
];
docStyleCases.forEach((c, i) => {
	check(
		`checkElementBordersInDoc(#${i})`,
		docs.checkElementBordersInDoc(c.tag, c.style, c.overrides ?? null, null, null),
		refBrowser.checkElementBorders(c.tag, c.style, c.overrides ?? null, null, null),
	);
});

const docColorCases = [
	{ tag: "p", style: { color: "rgb(250,250,250)", backgroundColor: "rgb(240,240,240)" }, text: "Hello" },
	{ tag: "p", style: { color: "rgb(120,120,120)", backgroundColor: "rgb(20,20,20)" }, text: "Hello" },
	{ tag: "a", style: { color: "rgb(0,0,238)" }, text: "Link", anchorInherit: true },
	{ tag: "p", style: { visibility: "hidden" }, text: "Hidden" },
	{ tag: "p", style: { color: "oklch(0.9 0.02 250)", backgroundColor: "oklch(0.95 0.01 250)" }, text: "Hi" },
];
docColorCases.forEach((c, i) => {
	const el = makeEl({ tag: c.tag, style: c.style, text: c.text ?? "" });
	check(
		`checkElementColorsInDoc(#${i})`,
		docs.checkElementColorsInDoc(el, c.style, c.tag, docHost, null, !!c.anchorInherit, "browser"),
		refBrowser.checkElementColors(el, c.style, c.tag, docHost, null, !!c.anchorInherit),
	);
});

const hoverCases = [
	{ style: { backgroundColor: "rgb(30,30,30)", fontSize: "14px" }, hover: { color: "rgb(30,30,30)", backgroundColor: "rgb(25,25,25)" }, text: "Buy" },
	{ style: { backgroundColor: "rgb(255,255,255)", fontSize: "14px" }, hover: { color: "rgb(250,250,250)", backgroundColor: "rgb(255,255,255)" }, text: "Buy" },
	{ style: { backgroundColor: "rgb(255,255,255)" }, hover: { color: "rgb(0,0,0)", backgroundColor: "rgb(255,255,255)" }, text: "" },
];
hoverCases.forEach((c, i) => {
	const el = makeEl({ tag: "a", style: c.style, text: c.text });
	el.__hover = c.hover;
	check(
		`checkElementHoverContrastInDoc(#${i})`,
		docs.checkElementHoverContrastInDoc(el, c.style, "a", docHost),
		refBrowser.checkElementHoverContrast(el, c.style, "a", docHost),
	);
});

const tileEl = makeEl({
	tag: "h2",
	text: "Features",
	previousElementSibling: makeEl({ tag: "div", style: { width: "64px", height: "64px", backgroundColor: "rgb(30,30,30)", borderRadius: "12px" }, children: [{ __isIcon: true, tagName: "SVG", nodeType: 1, getAttribute: () => null, childNodes: [], children: [] }] }),
});
check("checkElementIconTileInDoc", docs.checkElementIconTileInDoc(tileEl, "h2", docHost), refBrowser.checkElementIconTile(tileEl, "h2", docHost));

const eyebrowEl = makeEl({ tag: "h1", text: "Headline", style: { fontSize: "64px" }, previousElementSibling: makeEl({ tag: "p", text: "NEW FEATURE", style: { textTransform: "uppercase", fontSize: "12px", letterSpacing: "2px" } }) });
check(
	"checkElementHeroEyebrowInDoc",
	docs.checkElementHeroEyebrowInDoc(eyebrowEl, eyebrowEl.__styles[""], "h1", docHost, null),
	refBrowser.checkElementHeroEyebrow(eyebrowEl, eyebrowEl.__styles[""], "h1", docHost, null),
);

for (const [i, c] of [
	{ tag: "h1", style: { fontStyle: "italic", fontFamily: "'Playfair Display', serif", fontSize: "72px" } },
	{ tag: "h3", style: { fontStyle: "italic", fontFamily: "'Playfair Display', serif", fontSize: "72px" } },
].entries()) {
	const el = makeEl({ tag: c.tag, text: "Title", style: c.style });
	check(`checkElementItalicSerifInDoc(#${i})`, docs.checkElementItalicSerifInDoc(el, c.style, c.tag), refBrowser.checkElementItalicSerif(el, c.style, c.tag));
}

for (const [i, style] of [
	{ transitionProperty: "width" },
	{ animationName: "bounce" },
	{ animationTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
	{ transitionProperty: "opacity" },
].entries()) {
	check(`checkElementMotionInDoc(#${i})`, docs.checkElementMotionInDoc("div", style), refBrowser.checkElementMotion("div", style));
}

for (const [i, style] of [
	{ boxShadow: "0 0 20px rgb(120,20,200)" },
	{ boxShadow: "0 4px 20px #c81414" },
	{ textShadow: "none", boxShadow: "none" },
].entries()) {
	check(`checkElementGlowInDoc(#${i})`, docs.checkElementGlowInDoc("div", style, { r: 10, g: 10, b: 10, a: 1 }), refBrowser.checkElementGlow("div", style, { r: 10, g: 10, b: 10, a: 1 }));
}

const qualityElDoc = qualityEl({ tag: "p", text: "Short copy", style: { fontSize: "10px" } });
check(
	"checkElementQualityInDoc",
	docs.checkElementQualityInDoc(qualityElDoc, qualityElDoc.__styles[""], "p", docHost, "browser"),
	refBrowser.checkElementQuality(qualityElDoc, qualityElDoc.__styles[""], "p", docHost),
);

// ─── Page-level checks ─────────────────────────────────────

for (const samples of [
	[],
	[{ role: "h1", size: 48 }, { role: "h2", size: 40 }, { role: "body", size: 16 }],
	[{ role: "h1", size: 24 }, { role: "h2", size: 22 }, { role: "body", size: 20 }],
	[{ role: "h1", size: 30 }, { role: "body", size: 16 }],
	[{ role: "h1", size: 30 }, { role: "h1", size: 32 }, { role: "body", size: 16 }, { role: "h2", size: 31 }],
	[{ role: "h1", size: 30 }, { role: "body", size: 16 }, { role: "h3", size: 29.6 }],
]) {
	check(`checkFlatTypeHierarchySamples(${JSON.stringify(samples)})`, pages.checkFlatTypeHierarchySamples(samples), refBrowser.checkFlatTypeHierarchySamples(samples));
}

// `typeHierarchyRole` is internal to the reference; the sample and document checks
// above exercise it.

const hierarchyDoc = {
	querySelectorAll: (selector) => {
		if (selector !== pages.TYPE_HIERARCHY_SELECTOR) return [];
		return [
			makeEl({ tag: "h1", text: "Title", style: { fontSize: "24px" } }),
			makeEl({ tag: "h2", text: "Section", style: { fontSize: "22px" } }),
			makeEl({ tag: "p", text: "Body copy", style: { fontSize: "20px" } }),
			makeEl({ tag: "p", text: "Hidden", style: { display: "none", fontSize: "9px" } }),
		];
	},
};
check(
	"checkFlatTypeHierarchyFromDoc",
	pages.checkFlatTypeHierarchyFromDoc(hierarchyDoc, styleOf),
	refBrowser.checkFlatTypeHierarchyFromDoc(hierarchyDoc, styleOf),
);

const cardDoc = {
	querySelectorAll: (selector) => {
		if (selector === "*") return cardEls;
		return [];
	},
};
const innerCard = makeEl({ tag: "div", attributes: { class: "card shadow rounded-lg bg-white" }, text: "Card body text here", style: { boxShadow: "0 1px 2px rgba(0,0,0,0.2)", borderRadius: "8px", width: "200px" } });
const outerCard = makeEl({ tag: "div", attributes: { class: "card shadow rounded-lg bg-white" }, text: "Outer card text here", style: { boxShadow: "0 1px 2px rgba(0,0,0,0.2)", borderRadius: "8px", width: "400px" } });
outerCard.contains = (other) => other === innerCard;
innerCard.parentElement = outerCard;
const cardEls = [outerCard, innerCard];
const mapLegacy = (findings) => findings.map((f) => ({ id: f.type, snippet: f.detail }));
check("checkLayoutInDoc", pages.checkLayoutInDoc(cardDoc, dom), refBrowser.checkPageLayout(cardDoc, dom));

const typographyDoc = {
	styleSheets: [],
	querySelectorAll: (selector) => {
		if (selector === "*") return [];
		return Array.from({ length: 20 }, () => makeEl({ tag: "p", text: "Text", style: { fontFamily: "Inter, sans-serif", fontSize: "24px" } }));
	},
	documentElement: { outerHTML: "<html><a href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400\"></a></html>" },
};
globalThis.document = typographyDoc;
check(
	"checkPageTypography",
	pages.checkPageTypography(typographyDoc, styleOf),
	refBrowser.checkPageTypography(typographyDoc, { getComputedStyle: styleOf }),
);
check("checkTypographyInDoc", pages.checkTypographyInDoc(typographyDoc, dom), mapLegacy(refBrowser.checkTypography()));
delete globalThis.document;

// ─── Tells: cream palette, oversized h1, thin border + wide shadow ─

for (const rgb of [
	{ r: 250, g: 245, b: 235, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, { r: 240, g: 230, b: 200, a: 1 },
	{ r: 200, g: 190, b: 180, a: 1 }, { r: 236, g: 240, b: 245, a: 1 }, null,
]) {
	check(`isCreamColor(${JSON.stringify(rgb)})`, tells.isCreamColor(rgb), refBrowser.isCreamColor(rgb));
}
// `creamFromClassList`, `shadowLayerAlpha` and `cssColorAlpha` are internal to the
// reference; the exported checks above exercise them.

const creamDoc = (bodyStyle, htmlStyle = {}) => {
	const body = makeEl({ tag: "body", style: bodyStyle, attributes: { class: bodyStyle.__class ?? "" } });
	const html = makeEl({ tag: "html", style: htmlStyle });
	return { body, documentElement: html, querySelector: () => body };
};
for (const [i, docSpec] of [
	[{ backgroundColor: "rgb(250, 245, 235)" }, {}],
	[{ backgroundColor: "rgb(255, 255, 255)" }, {}],
	[{ backgroundColor: "rgba(0, 0, 0, 0)", __class: "bg-amber-50" }, {}],
	[{ backgroundColor: "rgba(0, 0, 0, 0)" }, { backgroundColor: "rgb(252, 247, 240)" }],
].entries()) {
	const doc = creamDoc(docSpec[0], docSpec[1]);
	check(`checkCreamPalette(#${i})`, tells.checkCreamPalette(doc, dom), refBrowser.checkCreamPalette(doc, docHost));
}

for (const [i, opts] of [
	{ tag: "h1", fontSize: 96, headingText: "x".repeat(60), rect: { width: 900, height: 400, top: 0, bottom: 400, left: 0, right: 900 }, viewportWidth: 1200, viewportHeight: 800 },
	{ tag: "h1", fontSize: 96, headingText: "x".repeat(60), rect: { width: 400, height: 100, top: 0, bottom: 100, left: 0, right: 400 }, viewportWidth: 1200, viewportHeight: 800 },
	{ tag: "h1", fontSize: 96, headingText: "Short title" },
	{ tag: "h2", fontSize: 96, headingText: "x".repeat(60) },
	{ tag: "h1", fontSize: 40, headingText: "x".repeat(60) },
].entries()) {
	check(`checkOversizedH1(#${i})`, tells.checkOversizedH1(opts), refBrowser.checkOversizedH1(opts));
}

for (const [i, shadow] of [
	{ borderWidths: [1, 1, 1, 1], borderColors: ["rgb(0,0,0)", "rgb(0,0,0)", "rgb(0,0,0)", "rgb(0,0,0)"], boxShadow: "0 8px 32px rgba(0,0,0,0.2)" },
	{ borderWidths: [1, 1, 1, 1], borderColors: ["rgba(0,0,0,0.1)", "rgba(0,0,0,0.1)", "rgba(0,0,0,0.1)", "rgba(0,0,0,0.1)"], boxShadow: "0 8px 32px rgba(0,0,0,0.2)" },
	{ borderWidths: [1, 1, 0, 0], borderColors: ["rgb(0,0,0)", "rgb(0,0,0)", "", ""], boxShadow: "0 2px 4px rgba(0,0,0,0.2)" },
	{ borderWidths: [2, 2, 2, 2], borderColors: ["rgb(0,0,0)", "rgb(0,0,0)", "rgb(0,0,0)", "rgb(0,0,0)"], boxShadow: "0 8px 32px rgba(0,0,0,0.2)" },
].entries()) {
	check(`checkGptThinBorderWideShadow(#${i})`, tells.checkGptThinBorderWideShadow(shadow), refBrowser.checkGptThinBorderWideShadow(shadow));
}
for (const shadow of ["0 8px 32px rgba(0,0,0,0.2)", "inset 0 0 8px #000", "none", "0 0 0 1px rgba(0,0,0,0.1), 0 8px 32px hsla(0,0%,0%,0.3)"]) {
	check(`shadowMaxBlurPx(${JSON.stringify(shadow)})`, tells.shadowMaxBlurPx(shadow), refBrowser.shadowMaxBlurPx(shadow));
	check(`shadowMaxBlurPx(${JSON.stringify(shadow)}, 0.12)`, tells.shadowMaxBlurPx(shadow, { minAlpha: 0.12 }), refBrowser.shadowMaxBlurPx(shadow, { minAlpha: 0.12 }));
}

// ─── Clipped overflow ────────────────────────────────────────

function clippedEl({ tag = "div", style = {}, class: cls = "", children = [], rect = null } = {}) {
	const el = makeEl({ tag, style, attributes: { class: cls }, rect, children });
	el.querySelectorAll = (selector) => (selector === "*" ? children : []);
	return el;
}

const clipCases = [
	clippedEl({ style: { overflow: "hidden" }, children: [clippedEl({ tag: "div", style: { position: "absolute", top: "-10px" }, rect: { width: 10, height: 10, top: -10, bottom: 0, left: 0, right: 10 } })] }),
	clippedEl({ style: { overflowX: "hidden" }, children: [clippedEl({ tag: "div", style: { position: "absolute" }, rect: { width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10 } })] }),
	clippedEl({ style: { overflow: "auto" }, children: [clippedEl({ tag: "div", style: { position: "absolute", top: "-10px" } })] }),
	clippedEl({ style: { overflow: "hidden" }, class: "carousel", children: [clippedEl({ tag: "div", style: { position: "absolute" } })] }),
	clippedEl({ style: { overflow: "hidden" }, children: [clippedEl({ tag: "div", style: { position: "absolute", top: "100%" }, rect: { width: 10, height: 10, top: 200, bottom: 210, left: 0, right: 10 } })] }),
	clippedEl({ style: { overflow: "hidden" }, children: [clippedEl({ tag: "img", style: { position: "absolute", top: "-40px" } })] }),
	clippedEl({ style: { overflow: "visible" }, children: [] }),
];
clipCases.forEach((el, i) => {
	const style = el.__styles[""];
	check(`checkClippedOverflow(#${i})`, overflow.checkClippedOverflow(el, style, styleOf), refBrowser.checkClippedOverflow(el, style, styleOf));
});

// `clippedByInset`, `clippedByRect` and `positionedStyleImpliesEscape` are internal to
// the reference; checkClippedOverflow above exercises them.

// ─── Text visibility, spotlight, and overlap ─────────────────

globalThis.window = { innerWidth: 1200, innerHeight: 800, scrollY: 0, getComputedStyle: styleOf };

for (const [i, style] of [
	{ position: "absolute", width: "1px", height: "1px", overflow: "hidden" },
	{ position: "absolute", width: "10px", height: "10px", overflow: "hidden" },
	{ clip: "rect(0, 0, 0, 0)" },
	{ clipPath: "inset(50%)" },
	{ position: "static" },
].entries()) {
	check(
		`isScreenReaderOnlyTextStyle(#${i})`,
		textVis.isScreenReaderOnlyTextStyle(style, { width: 100, height: 20 }),
		refBrowser.isScreenReaderOnlyTextStyle(style, { width: 100, height: 20 }),
	);
}

for (const [i, m] of [
	{ totalChars: 0, hiddenChars: 0, hiddenSamples: [] },
	{ totalChars: 500, hiddenChars: 100, hiddenSamples: [] },
	{ totalChars: 500, hiddenChars: 200, hiddenSamples: ["Hello"] },
	{ totalChars: 1000, hiddenChars: 900, hiddenSamples: [] },
].entries()) {
	check(`checkContentHiddenAtRest(#${i})`, textVis.checkContentHiddenAtRest(m), refBrowser.checkContentHiddenAtRest(m));
}

for (const [i, cs] of [
	{ backgroundColor: "rgb(255,255,255)" },
	{ backgroundColor: "rgba(255,255,255,0.2)", borderTopWidth: "1px", borderTopColor: "rgb(0,0,0)", borderBottomWidth: "1px", borderBottomColor: "rgb(0,0,0)" },
	{ backgroundColor: "rgba(255,255,255,0.2)" },
].entries()) {
	check(`isOpaqueDecoratedBox(#${i})`, overlap.isOpaqueDecoratedBox(cs), refBrowser.isOpaqueDecoratedBox(cs));
}

for (const [i, opts] of [
	{ gradientValue: "radial-gradient(circle at 50% 40%, rgba(80,111,255,0.26), transparent 44%)", width: 800, height: 400, label: "hero" },
	{ gradientValue: "radial-gradient(circle, rgb(80,111,255), transparent 60%)", width: 800, height: 400 },
	{ gradientValue: "radial-gradient(circle, rgba(80,111,255,0.26), transparent)", width: 100, height: 100 },
	{ gradientValue: "radial-gradient(circle, rgba(120,120,120,0.2), transparent)", width: 800, height: 400 },
	{ gradientValue: "linear-gradient(red, blue)", width: 800, height: 400 },
	{ gradientValue: "repeating-radial-gradient(circle, rgba(80,111,255,0.2), transparent 8px)", width: 800, height: 400 },
].entries()) {
	check(`checkRadialSpotlight(#${i})`, spotlight.checkRadialSpotlight(opts), refBrowser.checkRadialSpotlight(opts));
}

const aiPaletteEl = makeEl({ tag: "div", style: { backgroundImage: "linear-gradient(135deg, #7c3aed, #06b6d4)" } });
check("checkElementAIPaletteDOM", spotlight.checkElementAIPaletteDOM(aiPaletteEl, dom), refBrowser.checkElementAIPaletteDOM(aiPaletteEl));

const motionEl = makeEl({ tag: "div", style: { animationName: "bounce", animationIterationCount: "infinite" }, attributes: { class: "animate-bounce" } });
check("checkElementMotionDOM", spotlight.checkElementMotionDOM(motionEl, dom), refBrowser.checkElementMotionDOM(motionEl));

const glowEl = makeEl({ tag: "div", style: { boxShadow: "0 0 20px rgb(120,20,200)" } });
check("checkElementGlowDOM", spotlight.checkElementGlowDOM(glowEl, dom), refBrowser.checkElementGlowDOM(glowEl));

const cursorEl = makeEl({ tag: "span", text: "_", style: { animationName: "blink", animationIterationCount: "infinite", display: "inline-block" }, rect: { width: 2, height: 18, top: 100, bottom: 118, left: 0, right: 2 } });
check("checkElementBlinkingCursorDOM", textVis.checkElementBlinkingCursorDOM(cursorEl, dom, { scrollY: 0 }), refBrowser.checkElementBlinkingCursorDOM(cursorEl));

// Occlusion: one text node, one opaque card covering it. The probe answers with the card.
const victimEl = makeEl({ tag: "p", text: "Readable paragraph text", style: {}, rect: { width: 200, height: 40, top: 100, bottom: 140, left: 0, right: 200 } });
victimEl.contains = (other) => other === victimEl;
victimEl.closest = () => null;
const occluderEl = makeEl({ tag: "div", style: { backgroundColor: "rgb(255,255,255)" }, rect: { width: 200, height: 40, top: 100, bottom: 140, left: 0, right: 200 } });
occluderEl.contains = (other) => other === occluderEl;
const probeDoc = {
	body: makeEl({ tag: "body" }),
	documentElement: makeEl({ tag: "html" }),
	styleSheets: [],
	querySelectorAll: (selector) => (selector === "body *" ? [victimEl, occluderEl] : []),
	elementFromPoint: () => occluderEl,
};
globalThis.document = probeDoc;
check(
	"checkTextOcclusion",
	overlap.checkTextOcclusion(probeDoc, dom, { width: 1200, height: 800, elementFromPoint: probeDoc.elementFromPoint }),
	refBrowser.checkTextOcclusionDOM().map((f) => ({ id: f.type, snippet: f.detail })),
);

const scrollerEl = makeEl({ tag: "div", style: { overflowX: "auto" }, rect: { width: 400, height: 200, top: 0, bottom: 200, left: 0, right: 400 } });
scrollerEl.scrollWidth = 900;
scrollerEl.clientWidth = 400;
scrollerEl.scrollLeft = 0;
scrollerEl.clientLeft = 0;
const flushCard = makeEl({ tag: "div", style: { backgroundColor: "rgb(255,255,255)" }, rect: { width: 100, height: 100, top: 0, bottom: 100, left: 300, right: 400 }, attributes: { class: "card" } });
flushCard.parentElement = scrollerEl;
scrollerEl.querySelectorAll = () => [flushCard];
const flushDoc = { body: makeEl({ tag: "body" }), documentElement: makeEl({ tag: "html" }), styleSheets: [], querySelectorAll: (s) => (s === "*" ? [scrollerEl] : []) };
globalThis.document = flushDoc;
check(
	"checkEdgeFlushCards",
	overlap.checkEdgeFlushCards(flushDoc, dom, { width: 1200, height: 800 }),
	refBrowser.checkEdgeFlushCardsDOM().map((f) => ({ id: f.type, snippet: f.detail })),
);

delete globalThis.document;

// ─── Custom property map (CSSOM) ─────────────────────────────

const fakeRule = (selectorText, props) => ({
	type: 1,
	selectorText,
	style: {
		length: props.length,
		...Object.fromEntries(props.map((p, i) => [i, p[0]])),
		getPropertyValue: (name) => (props.find((p) => p[0] === name) ?? [, ""])[1],
	},
});
const sheetCases = [
	{ cssRules: [fakeRule(":root", [["--a", "1px"], ["--b", "red"], ["color", "blue"]])] },
	{ cssRules: [fakeRule("html", [["--font-weight-bold", "700"]]), fakeRule(".x", [["--ignored", "1"]])] },
	{ cssRules: [{ type: 4, cssRules: [fakeRule(":root", [["--nested", "2rem"]])] }] },
	{ cssRules: [fakeRule(":host", [["--h", "3"]]), fakeRule(":root, .y", [["--multi", "4"]])] },
	{},
];
for (const [i, sheet] of sheetCases.entries()) {
	check(`buildCustomPropMap(#${i})`, [...cssScan.buildCustomPropMap([sheet])], [...refBrowser.buildCustomPropMap({ styleSheets: [sheet] })]);
}

// ─── Heading rhythm, hidden text, first-viewport columns ─────

const rhythmDoc = {
	body: makeEl({ tag: "body" }),
	documentElement: makeEl({ tag: "html" }),
	styleSheets: [],
	querySelectorAll: (selector) => (selector === "h2, h3, h4" ? rhythmHeadings : []),
};
const rhythmSiblingsAbove = [makeEl({ tag: "div", text: "Previous block", rect: { width: 400, height: 40, top: 0, bottom: 40, left: 0, right: 400 } })];
const rhythmSiblingsBelow = [makeEl({ tag: "div", text: "Following block", rect: { width: 400, height: 200, top: 100, bottom: 300, left: 0, right: 400 } })];
const rhythmHeadings = [
	makeEl({ tag: "h2", text: "First heading", rect: { width: 400, height: 30, top: 60, bottom: 90, left: 0, right: 400 } }),
	makeEl({ tag: "h2", text: "Second heading", rect: { width: 400, height: 30, top: 60, bottom: 90, left: 0, right: 400 } }),
];
for (const [i, h] of rhythmHeadings.entries()) {
	h.parentElement = rhythmDoc.body;
	h.previousElementSibling = rhythmSiblingsAbove[0];
	h.nextElementSibling = rhythmSiblingsBelow[0];
	h.children = [];
}
rhythmDoc.body.children = rhythmSiblingsAbove.concat(rhythmHeadings, rhythmSiblingsBelow);
globalThis.document = rhythmDoc;
check("checkHeadingRhythm", pages.checkHeadingRhythm(rhythmDoc, dom), mapLegacy(refBrowser.checkHeadingRhythmDOM()));

const hiddenDoc = {
	documentElement: makeEl({ tag: "html" }),
	styleSheets: [],
	querySelectorAll: (selector) => (selector === "body *" ? hiddenEls : []),
};
const hiddenEls = [
	makeEl({ tag: "p", text: "".padEnd(300, "a") }),
	makeEl({ tag: "p", text: "".padEnd(300, "b"), style: { opacity: "0" } }),
	makeEl({ tag: "script", text: "x".repeat(500) }),
	makeEl({ tag: "div", text: "hidden menu", style: { display: "none" } }),
];
globalThis.document = hiddenDoc;
check("measureHiddenText", textVis.measureHiddenText(hiddenDoc, dom), refBrowser.measureHiddenTextDOM());

const columnChildTall = makeEl({ tag: "div", style: { display: "block" }, rect: { width: 400, height: 300, top: 100, bottom: 400, left: 0, right: 400 } });
columnChildTall.querySelectorAll = () => [makeEl({ tag: "p", rect: { width: 400, height: 2000, top: 100, bottom: 2100, left: 0, right: 400 } })];
const columnChildShort = makeEl({ tag: "div", rect: { width: 400, height: 100, top: 100, bottom: 200, left: 400, right: 800 } });
columnChildShort.querySelectorAll = () => [];
const columnGrid = makeEl({ tag: "div", style: { display: "grid" }, rect: { width: 800, height: 2000, top: 100, bottom: 2100, left: 0, right: 800 } });
columnGrid.children = [columnChildTall, columnChildShort];
columnChildTall.parentElement = columnGrid;
columnChildShort.parentElement = columnGrid;
const columnDoc = { body: makeEl({ tag: "body" }), documentElement: makeEl({ tag: "html" }), styleSheets: [], querySelectorAll: (s) => (s === "body *" ? [columnGrid] : []) };
globalThis.document = columnDoc;
check(
	"checkFirstViewportColumnOverflow",
	overlap.checkFirstViewportColumnOverflow(columnDoc, dom, { width: 1200, height: 800 }),
	mapLegacy(refBrowser.checkFirstViewportColumnOverflowDOM()),
);

delete globalThis.document;

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} check parity comparisons failed`);
	process.exit(1);
}
console.log(`checks parity: ${comparisons} comparisons match the reference`);
