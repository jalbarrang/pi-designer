/**
 * The static HTML engine: build a computed style for every element from the page's own
 * CSS, then run the element and page rules against it. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The parser arrives as `HtmlModules` rather than being imported: pi's scan may be handed
 * one by its host, and a missing parser degrades to the text engine with a warning saying
 * the findings are an undercount — never a clean bill of health.
 */
import fs from "node:fs";
import path from "node:path";
import { OVERUSED_FONTS, primaryFontFace } from "../../core/shared/constants.ts";
import { isFullPage } from "../../core/shared/page.ts";
import { applyInlineIgnores } from "../../core/shared/inline-ignores.ts";
import { finding } from "../../core/findings.ts";
import { scopedIgnoreActive } from "../../core/checks/scoped-ignore.ts";
import { checkFlatTypeHierarchyFromDoc, checkLayoutInDoc, checkHeadingRhythm, checkTypographyInDoc } from "../../core/checks/page.ts";
import { checkKickersInDoc, checkNumberedSectionLabelsInDoc } from "../../core/checks/labels.ts";
import { collectRepeatedContainerTextFindings } from "../../core/checks/repeated-text.ts";
import { checkCreamPalette } from "../../core/checks/tells.ts";
import { checkPageQualityFromDoc } from "../../core/checks/quality.ts";
import { buildHtmlPatternCorpora, checkHtmlPatterns } from "../../core/checks/html-patterns.ts";
import {
	checkElementBordersInDoc,
	checkElementColorsInDoc,
	checkElementGlowInDoc,
	checkElementHeroEyebrowInDoc,
	checkElementHoverContrastInDoc,
	checkElementIconTileInDoc,
	checkElementItalicSerifInDoc,
	checkElementQualityInDoc,
} from "../../core/checks/doc-checks.ts";
import { checkElementMotionInDocStyle } from "../../core/checks/spotlight.ts";
import { checkElementClippedOverflowDOM } from "../../core/checks/overflow.ts";
import { checkElementGptBorderShadow } from "../../core/checks/tells.ts";
import { checkElementOversizedH1InDoc } from "../../core/checks/tells.ts";
import { checkElementRadialSpotlightInDoc } from "../../core/checks/spotlight.ts";
import { checkElementBlinkingCursorDOM, checkElementTextOverflowDOM } from "../../core/checks/text-visibility.ts";
import { checkSourceDesignSystem, collectStaticDesignSystemFindings, mergeDesignSystemFindings, type DesignSystem } from "../design-system.ts";
import { detectText, runTextContentAnalyzers } from "../text.ts";
import { buildStaticStyleMap, buildStaticWindow, collectStaticCssText, StaticDocument, type DomModules, type HtmlNode } from "./css-cascade.ts";
import type { CssStyle } from "../../dom.ts";
import type { Finding } from "../../types.ts";
import type { RuleHit } from "../../core/checks/rule-hit.ts";

/** What the HTML engine needs from a parser: the cascade's modules plus a document parse. */
export interface HtmlModules extends DomModules {
	parseDocument(html: string, options: { lowerCaseAttributeNames: boolean; lowerCaseTags: boolean }): HtmlNode;
}

/** The `window`-shaped object the checks read. */
export interface StaticWindow {
	getComputedStyle(el: unknown): CssStyle;
	getHoverStyle(el: unknown): CssStyle | null;
	hasAccentDashPseudo(el: unknown): boolean;
	getPseudoSurface(el: unknown): { r: number; g: number; b: number; a: number } | null;
	readonly document: StaticDocument;
}

/** The static document plus its style window, which is what the rules take. */
export interface StaticPage {
	readonly document: StaticDocument;
	readonly window: StaticWindow;
}

/**
 * The page's type usage: which faces actually paint text, and whether the hierarchy is
 * flat. Counted from computed styles rather than stylesheet rules, so a rule that applies
 * to nothing cannot report a font nobody sees.
 */
function checkStaticPageTypography(page: StaticPage, filePath: string): Finding[] {
	const findings: Finding[] = [];
	const fonts = new Set<string>();
	const overusedFound = new Set<string>();

	for (const el of Array.from(page.document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th, dd, blockquote, figcaption, a, button, label, span, div"))) {
		const hasText = (el.childNodes ?? []).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
		if (!hasText) continue;
		const primary = primaryFontFace(page.window.getComputedStyle(el).fontFamily ?? "");
		if (!primary) continue;
		fonts.add(primary);
		if (OVERUSED_FONTS.has(primary)) overusedFound.add(primary);
	}

	for (const font of overusedFound) findings.push(finding("overused-font", filePath, `Primary font: ${font}`));
	for (const hit of checkFlatTypeHierarchyFromDoc(page.document as never, (el) => page.window.getComputedStyle(el))) {
		findings.push(finding(hit.id, filePath, hit.snippet));
	}
	return findings;
}

/** An `<img>` whose src is missing, empty, or a bare `#`. */
function checkElementBrokenImage(el: { getAttribute?(name: string): string | null; attribs?: Record<string, string> }): RuleHit[] {
	const src = el.getAttribute?.("src") ?? el.attribs?.src;
	if (src === undefined || src === null) return [{ id: "broken-image", snippet: "<img> with no src attribute" }];
	const trimmed = String(src).trim();
	if (trimmed === "" || trimmed === "#") return [{ id: "broken-image", snippet: `<img src="${src}">` }];
	return [];
}

/** One element rule: a selector to gather elements, and the check to run on each. */
export type StaticElementRule = (el: StaticElementLike, tag: string, style: CssStyle, page: StaticPage) => RuleHit[];

/** The element surface the rules read, as the static document exposes it. */
type StaticElementLike = ReturnType<StaticDocument["wrap"]>;

/** The per-element rules, each with the selector that gathers its candidates. */
const STATIC_ELEMENT_RULES: ReadonlyArray<{ readonly id: string; readonly selector: string; readonly run: StaticElementRule }> = [
	{
		id: "border-rules",
		selector: "*",
		run: (el, tag, style, page) =>
			checkElementBordersInDoc(tag, style, null, resolveRadius(el, style), el),
	},
	{ id: "color-rules", selector: "*", run: (el, tag, style, page) => checkElementColorsInDoc(el, style, tag, page.window, null, false) },
	{ id: "hover-color-rules", selector: "*", run: (el, tag, style, page) => checkElementHoverContrastInDoc(el, style, tag, page.window) },
	{
		id: "dark-glow",
		selector: "*",
		run: (_el, tag, style, page) => checkElementGlowInDoc(tag, style, null),
	},
	{ id: "motion-rules", selector: "*", run: (_el, tag, style) => checkElementMotionInDocStyle(tag, style) },
	{ id: "icon-tile-stack", selector: "h1,h2,h3,h4,h5,h6", run: (el, tag, _style, page) => checkElementIconTileInDoc(el, tag, page.window) },
	{ id: "italic-serif-display", selector: "h1,h2", run: (el, _tag, style) => checkElementItalicSerifInDoc(el, style, el.tagName.toLowerCase()) },
	{ id: "hero-eyebrow-chip", selector: "h1", run: (el, tag, style, page) => checkElementHeroEyebrowInDoc(el, style, tag, page.window, null) },
	{ id: "broken-image", selector: "img", run: (el) => checkElementBrokenImage(el) },
	{ id: "quality-rules", selector: "*", run: (el, tag, style, page) => checkElementQualityInDoc(el, style, tag, page.window) },
	{ id: "oversized-h1", selector: "h1", run: (el, tag, _style, page) => checkElementOversizedH1InDoc(el, tag, page.window) },
	{
		id: "clipped-overflow-container",
		selector: "*",
		run: (el, _tag, style, page) => checkElementClippedOverflowDOM(el, page.window),
	},
	{ id: "gpt-thin-border-wide-shadow", selector: "*", run: (_el, _tag, style) => checkElementGptBorderShadow(style) },
	{ id: "radial-spotlight-glow", selector: "*", run: (el, _tag, style) => checkElementRadialSpotlightInDoc(el, style) },
	{ id: "text-overflow", selector: "*", run: (el, _tag, _style, page) => checkElementTextOverflowDOM(el, page.window) },
	{ id: "blinking-cursor", selector: "*", run: (el, _tag, _style, page) => checkElementBlinkingCursorDOM(el, page.window, { scrollY: 0 }) },
];

/** A radius resolved from declared width, for the border rule's rounded gate. */
function resolveRadius(el: StaticElementLike, style: CssStyle): number | null {
	const width = parseFloat(style.width ?? "") || 0;
	const raw = String(style.borderRadius ?? "").trim();
	if (!raw) return 0;
	const first = raw.split(/\s+/)[0];
	const num = parseFloat(first);
	if (Number.isNaN(num)) return 0;
	if (/%$/.test(first)) return width > 0 ? (num / 100) * width : num;
	void el;
	return num;
}

export interface DetectHtmlOptions {
	/** The parser modules. Absent means the text engine runs instead, with a warning. */
	readonly modules?: HtmlModules | null;
	readonly designSystem?: DesignSystem | null;
	readonly inlineIgnores?: boolean;
	/** Called once when no parser is available, so a caller can report the degradation. */
	readonly onDegraded?: (message: string) => void;
}

/**
 * Findings for one HTML file: compute every element's style from the page's own CSS, run
 * the element rules, then the design-system, then the page rules when the file is a whole
 * page, then the text-content analyzers the regex engine owns.
 *
 * Without a parser this degrades to `detectText`, and says so: a partial answer is still
 * an answer, but it is an undercount.
 */
async function detectHtml(filePath: string, options: DetectHtmlOptions = {}): Promise<Finding[]> {
	const html = fs.readFileSync(filePath, "utf-8");
	const modules = options.modules ?? null;

	if (!modules) {
		options.onDegraded?.(
			"impeccable detect: DEGRADED - no HTML parser modules supplied. Falling back to regex matching. Custom properties, selector matching and computed contrast are NOT evaluated; findings are an undercount, not a clean bill of health.",
		);
		return detectText(html, filePath, { designSystem: options.designSystem, inlineIgnores: options.inlineIgnores });
	}

	const resolvedPath = path.resolve(filePath);
	const fileDir = path.dirname(resolvedPath);
	const root = modules.parseDocument(html, { lowerCaseAttributeNames: false, lowerCaseTags: true });

	const warnings: string[] = [];
	const cssText = collectStaticCssText(root, fileDir, modules, (href, cssPath) => {
		warnings.push(`impeccable detect: could not read linked stylesheet ${href} (resolved to ${cssPath}); color and custom-property rules will be incomplete`);
	});
	for (const warning of warnings) options.onDegraded?.(warning);

	const document = new StaticDocument(root, modules);
	buildStaticStyleMap(root, document, cssText, modules);
	const window: StaticWindow = buildStaticWindow(document);
	const page: StaticPage = { document, window };

	const findings: Finding[] = [];
	for (const rule of STATIC_ELEMENT_RULES) {
		for (const el of document.querySelectorAll(rule.selector)) {
			const tag = el.tagName.toLowerCase();
			const style = window.getComputedStyle(el);
			for (const f of rule.run(el, tag, style, page)) {
				// Element-scoped waivers: an ignoring ancestor suppresses matching findings
				// for its subtree, same as the browser walk.
				if (scopedIgnoreActive(el as never, f.id)) continue;
				findings.push(finding(f.id, filePath, f.snippet));
			}
		}
	}

	if (options.designSystem) {
		const sourceDesignFindings = checkSourceDesignSystem(html, filePath, { designSystem: options.designSystem });
		const staticDesignFindings = collectStaticDesignSystemFindings(
			document as never,
			window as never,
			filePath,
			options.designSystem,
		);
		findings.push(...mergeDesignSystemFindings(staticDesignFindings, sourceDesignFindings));
	}

	if (isFullPage(html)) {
		findings.push(...checkStaticPageTypography(page, filePath));
		for (const f of checkKickersInDoc(document as never, (el) => window.getComputedStyle(el), resolveLength)) {
			findings.push(finding(f.id, filePath, f.snippet));
		}
		for (const f of checkNumberedSectionLabelsInDoc(document as never, (el) => window.getComputedStyle(el), resolveLength)) {
			findings.push(finding(f.id, filePath, f.snippet));
		}
		for (const f of collectRepeatedContainerTextFindings(document as never, (el) => window.getComputedStyle(el), {
			isVisible: (el) => String(window.getComputedStyle(el).display || "") !== "none",
		})) {
			findings.push(finding(f.id, filePath, f.snippet));
		}
		for (const f of checkLayoutInDoc(document as never, window as never)) findings.push(finding(f.id, filePath, f.snippet));
		for (const f of checkCreamPalette(document as never, window as never)) findings.push(finding(f.id, filePath, f.snippet));
		for (const f of checkPageQualityFromDoc(document as never)) findings.push(finding(f.id, filePath, f.snippet));

		// Scoped corpora for the pattern checks: a CSS-property regex must not fire on
		// prose ABOUT CSS. `cssText` already carries the style blocks and linked local
		// stylesheets; the attributes come from the parsed document, so an escaped sample
		// never contributes.
		const styleAttrParts: string[] = [];
		const classAttrParts: string[] = [];
		for (const el of document.querySelectorAll("*")) {
			const styleAttr = el.getAttribute("style");
			if (styleAttr) styleAttrParts.push(`style="${styleAttr}"`);
			const classAttr = el.getAttribute("class");
			if (classAttr) classAttrParts.push(classAttr);
		}
		const patternCorpora = { styleText: [cssText, ...styleAttrParts].join("\n"), classText: classAttrParts.join("\n") };

		for (const f of checkHtmlPatterns(html, patternCorpora)) {
			// The regex engine already owns these two; the page pass would duplicate them.
			if (f.id === "bounce-easing" || f.id === "layout-transition") continue;
			// Selector-backed findings honor scoped waivers: resolve the selector and drop
			// the finding when every match is covered. An unmatched selector keeps the
			// finding, because a static scan sees partial documents.
			if (f.selector) {
				let matches: StaticElementLike[] | null = null;
				try {
					matches = document.querySelectorAll(String(f.selector).replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "").trim());
				} catch {
					matches = null;
				}
				if (matches && matches.length > 0 && matches.every((el) => scopedIgnoreActive(el as never, f.id))) continue;
			}
			const item = finding(f.id, filePath, f.snippet);
			// A check may attach a per-finding severity (a pulsing dot in page chrome, say)
			// that overrides the registry default.
			findings.push(f.severity ? { ...item, severity: f.severity } : item);
		}

		// The text-content analyzers live in the regex engine; calling them here gives HTML
		// files the same coverage as CSS and TSX.
		for (const f of runTextContentAnalyzers(html, filePath, options)) {
			findings.push(finding(f.antipattern, filePath, f.snippet));
		}
	}

	// Static findings carry no line number, so only whole-file `impeccable-disable`
	// directives apply — exactly the standalone-document waiver this targets.
	return options.inlineIgnores === false ? findings : [...applyInlineIgnores(findings, html)];
}

/** The length resolver the label checks use for tracking and sizes. */
function resolveLength(value: string, fontSizePx: number): number | null {
	const num = parseFloat(value);
	if (Number.isNaN(num)) return null;
	if (value.endsWith("px")) return num;
	if (value.endsWith("rem")) return num * 16;
	if (value.endsWith("em")) return num * fontSizePx;
	if (value.endsWith("%")) return (num / 100) * fontSizePx;
	return num * fontSizePx;
}

export { checkElementBrokenImage, checkStaticPageTypography, detectHtml, STATIC_ELEMENT_RULES };
