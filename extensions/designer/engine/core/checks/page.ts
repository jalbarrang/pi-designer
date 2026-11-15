/**
 * Page-level checks: type hierarchy, typography inventory, nested cards, and
 * heading rhythm. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These reason about a whole page, so they take the document and a style source
 * rather than reaching for `document` and `getComputedStyle`.
 */
import { parseAnyColor } from "../shared/color.ts";
import { OVERUSED_FONTS, SAFE_TAGS, isBrandFontOnOwnDomain, primaryFontFace } from "../shared/constants.ts";
import { extractGoogleFontFamilies } from "../shared/fonts.ts";
import { isCardLikeFromProps } from "./colors.ts";
import { resolveBorderRadiusPx } from "./background.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** The document surface these checks read. Stylesheets and `documentElement` are optional. */
export interface PageSource {
	querySelectorAll(selector: string): ArrayLike<DomElement>;
	readonly body?: DomElement | null;
	readonly styleSheets?: ArrayLike<StyleSheetLike>;
	readonly documentElement?: { outerHTML?: string } | null;
}

/** The slice of a stylesheet the typography inventory reads. */
export interface StyleSheetLike {
	readonly cssRules?: ArrayLike<StyleRuleLike>;
	readonly rules?: ArrayLike<StyleRuleLike>;
}

export interface StyleRuleLike {
	readonly type?: number;
	readonly style?: { fontFamily?: string } | null;
}

const TYPE_HIERARCHY_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,td,th,dd,blockquote,figcaption";
const TYPE_HIERARCHY_MIN_ROLES = 3;
const TYPE_HIERARCHY_MIN_STEP_RATIO = 1.25;

/** The role a text element plays in the hierarchy: its heading level, or `body`. */
function typeHierarchyRole(el: DomElement | null | undefined): string {
	const tag = String(el?.tagName || "").toLowerCase();
	return /^h[1-6]$/.test(tag) ? tag : "body";
}

function hasTextContent(el: DomElement | null | undefined): boolean {
	return String(el?.textContent || "").trim().length > 0;
}

/** False when the element or an ancestor is hidden by attribute, display, visibility, or opacity. */
function isRenderedTypeElement(el: DomElement, getStyle: (el: DomElement) => CssStyle): boolean {
	for (let current: DomElement | null = el; current; current = current.parentElement) {
		const hiddenAttr = typeof current.getAttribute === "function" && current.getAttribute("hidden") !== null;
		if ((current as { hidden?: boolean }).hidden || hiddenAttr) return false;
		const style = getStyle(current);
		if (!style) continue;
		const display = String(style.display || "").toLowerCase();
		const visibility = String(style.visibility || "").toLowerCase();
		const contentVisibility = String(style.contentVisibility || "").toLowerCase();
		if (display === "none" || visibility === "hidden" || visibility === "collapse" || contentVisibility === "hidden") return false;
		const opacity = parseFloat(style.opacity ?? "");
		if (Number.isFinite(opacity) && opacity <= 0.01) return false;
	}
	return true;
}

/** The size a role most often resolves to, or null when two sizes tie for first. */
function dominantTypeRoleSize(samples: ReadonlyArray<{ size: number }>): number | null {
	const counts = new Map<number, number>();
	for (const sample of samples) counts.set(sample.size, (counts.get(sample.size) || 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
	return ranked[0]?.[0] ?? null;
}

/**
 * The flat-hierarchy tell: three or more roles whose sizes never step up by 1.25x,
 * which leaves heading and body text visually interchangeable.
 */
function checkFlatTypeHierarchySamples(samples: ReadonlyArray<{ role?: string; size?: number }> | null | undefined): RuleHit[] {
	const byRole = new Map<string, Array<{ role: string; size: number }>>();
	for (const sample of samples || []) {
		const role = String(sample?.role || "");
		const size = Math.round(Number(sample?.size) * 10) / 10;
		if (!role || !Number.isFinite(size) || size < 8 || size >= 200) continue;
		const list = byRole.get(role);
		if (list) list.push({ role, size });
		else byRole.set(role, [{ role, size }]);
	}

	const roles = [...byRole.entries()]
		.map(([role, roleSamples]) => ({ role, size: dominantTypeRoleSize(roleSamples) }))
		.filter((item): item is { role: string; size: number } => item.size !== null);

	if (roles.length < TYPE_HIERARCHY_MIN_ROLES) return [];

	const sorted = roles.slice().sort((a, b) => a.size - b.size || a.role.localeCompare(b.role));
	let largestStep = 1;
	for (let i = 1; i < sorted.length; i++) {
		largestStep = Math.max(largestStep, sorted[i].size / sorted[i - 1].size);
	}
	if (largestStep >= TYPE_HIERARCHY_MIN_STEP_RATIO) return [];

	const roleSizes = sorted.map((item) => `${item.role} ${item.size}px`).join(", ");
	return [
		{
			id: "flat-type-hierarchy",
			snippet: `Role sizes: ${roleSizes} (largest adjacent step ${largestStep.toFixed(2)}:1; target ${TYPE_HIERARCHY_MIN_STEP_RATIO}:1)`,
		},
	];
}

/** Collect rendered text samples under `root` and judge the hierarchy. */
function checkFlatTypeHierarchyFromDoc(
	root: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: (el: DomElement) => CssStyle,
	options: { readonly skipElement?: (el: DomElement) => boolean } = {},
): RuleHit[] {
	const samples: Array<{ role: string; size: number }> = [];
	for (const el of Array.from(root.querySelectorAll(TYPE_HIERARCHY_SELECTOR))) {
		if (options.skipElement?.(el)) continue;
		if (!hasTextContent(el) || !isRenderedTypeElement(el, getStyle)) continue;
		const fontSize = parseFloat(getStyle(el)?.fontSize ?? "");
		if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize >= 200) continue;
		samples.push({ role: typeHierarchyRole(el), size: fontSize });
	}
	return checkFlatTypeHierarchySamples(samples);
}

/** Selectors for the detector's own injected UI, which must never be audited. */
const OVERLAY_SELECTOR = ".impeccable-overlay, .impeccable-label, .impeccable-banner, .impeccable-tooltip";

/**
 * Font usage by computed style: which face actually paints the page, and whether it
 * is one of the overused monoculture faces. Counting rendered elements rather than
 * stylesheet rules ignores rules that apply to nothing.
 */
function checkTypographyInDoc(
	doc: PageSource,
	dom: DomAdapter,
	opts: { readonly ownDomainHost?: string | null } = {},
): RuleHit[] {
	const findings: RuleHit[] = [];

	const fontUsage = new Map<string, number>();
	let totalTextElements = 0;
	for (const el of Array.from(doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, td, th, dd, blockquote, figcaption, a, button, label, span"))) {
		if (el.closest?.(OVERLAY_SELECTOR)) continue;
		const hasText = (el.childNodes ?? []).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
		if (!hasText) continue;
		const ff = dom.getComputedStyle(el).fontFamily;
		if (!ff) continue;
		const primary = primaryFontFace(ff);
		if (!primary) continue;
		fontUsage.set(primary, (fontUsage.get(primary) || 0) + 1);
		totalTextElements++;
	}

	if (totalTextElements >= 20) {
		// A face is "primary" when it paints at least 15% of the page's text.
		const PRIMARY_THRESHOLD = 0.15;
		for (const [font, count] of fontUsage) {
			const share = count / totalTextElements;
			if (share < PRIMARY_THRESHOLD) continue;
			if (!OVERUSED_FONTS.has(font)) continue;
			if (isBrandFontOnOwnDomain(font, opts.ownDomainHost ?? null)) continue;
			findings.push({ id: "overused-font", snippet: `Primary font: ${font} (${Math.round(share * 100)}% of text)` });
		}
	}

	findings.push(
		...checkFlatTypeHierarchyFromDoc(doc, (el) => dom.getComputedStyle(el), {
			skipElement: (el) => !!el.closest?.(`${OVERLAY_SELECTOR}, [id^="impeccable-live-"]`),
		}),
	);

	return findings;
}

/**
 * A card shape in a live DOM: a non-inline element with an elevation or border, plus
 * a radius or a background. Class hints count, because a shadow utility can land in
 * a stylesheet the computed style does not reflect.
 */
function isCardLikeInDoc(el: DomElement, dom: DomAdapter): boolean {
	const tag = el.tagName.toLowerCase();
	if (SAFE_TAGS.has(tag) || ["input", "select", "textarea", "img", "video", "canvas", "picture"].includes(tag)) return false;

	const style = dom.getComputedStyle(el);
	const rawStyle = el.getAttribute?.("style") || "";
	const cls = el.getAttribute?.("class") || "";

	const hasShadow = (!!style.boxShadow && style.boxShadow !== "none") || /\bshadow(?:-sm|-md|-lg|-xl|-2xl)?\b/.test(cls) || /box-shadow/i.test(rawStyle);
	const hasBorder = /\bborder\b/.test(cls);
	const widthPx = parseFloat(style.width ?? "") || 0;
	const hasRadius = resolveBorderRadiusPx(style, widthPx) > 0 || /\brounded(?:-sm|-md|-lg|-xl|-2xl|-full)?\b/.test(cls) || /border-radius/i.test(rawStyle);
	const hasBg = /\bbg-(?:white|gray-\d+|slate-\d+)\b/.test(cls) || /background(?:-color)?\s*:\s*(?!transparent)/i.test(rawStyle);

	return isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg);
}

/** Nested cards: a card inside a card, reported once for the innermost element. */
function checkLayoutInDoc(doc: PageSource, dom: DomAdapter): RuleHit[] {
	const findings: RuleHit[] = [];
	const flagged = new Set<DomElement>();

	for (const el of Array.from(doc.querySelectorAll("*"))) {
		if (!isCardLikeInDoc(el, dom) || flagged.has(el)) continue;
		const tag = el.tagName.toLowerCase();
		const cls = el.getAttribute?.("class") || "";
		const rawStyle = el.getAttribute?.("style") || "";

		if (["pre", "code"].includes(tag)) continue;
		if (/\b(?:absolute|fixed)\b/.test(cls) || /position\s*:\s*(?:absolute|fixed)/i.test(rawStyle)) continue;
		if ((el.textContent?.trim().length || 0) < 10) continue;
		if (/\b(?:dropdown|popover|tooltip|menu|modal|dialog)\b/i.test(cls)) continue;

		for (let parent = el.parentElement; parent; parent = parent.parentElement) {
			if (isCardLikeInDoc(parent, dom)) {
				flagged.add(el);
				break;
			}
		}
	}

	// Only the innermost card of a nest is reported: the outer one's finding would
	// say the same thing twice.
	for (const el of flagged) {
		let isAncestorOfFlagged = false;
		for (const other of flagged) {
			if (other !== el && el.contains?.(other)) {
				isAncestorOfFlagged = true;
				break;
			}
		}
		if (!isAncestorOfFlagged) findings.push({ id: "nested-cards", snippet: `Card inside card (${el.tagName.toLowerCase()})` });
	}

	return findings;
}

/**
 * The static twin of the typography inventory: reads families from the stylesheets
 * and the raw HTML, since a parsed document has no computed text to count.
 */
function checkPageTypography(
	doc: PageSource,
	getStyle: (el: DomElement) => CssStyle,
	opts: { readonly ownDomainHost?: string | null } = {},
): RuleHit[] {
	const findings: RuleHit[] = [];
	const overusedFound = new Set<string>();

	for (const sheet of Array.from(doc.styleSheets ?? [])) {
		let rules: ArrayLike<StyleRuleLike> | null = null;
		try {
			rules = sheet.cssRules || sheet.rules || null;
		} catch {
			continue;
		}
		if (!rules) continue;
		for (const rule of Array.from(rules)) {
			if (rule.type !== 1) continue;
			const ff = rule.style?.fontFamily;
			if (!ff) continue;
			const primary = primaryFontFace(ff);
			if (primary && OVERUSED_FONTS.has(primary)) overusedFound.add(primary);
		}
	}

	const html = doc.documentElement?.outerHTML || "";
	for (const f of extractGoogleFontFamilies(html)) {
		if (OVERUSED_FONTS.has(f)) overusedFound.add(f);
	}

	// Some parsers expose only part of the CSSOM, so also read raw declarations.
	const ffRe = /font-family\s*:\s*([^;}]+)/gi;
	for (let fm = ffRe.exec(html); fm !== null; fm = ffRe.exec(html)) {
		const primary = primaryFontFace(fm[1]);
		if (primary && OVERUSED_FONTS.has(primary)) overusedFound.add(primary);
	}

	for (const font of overusedFound) {
		if (isBrandFontOnOwnDomain(font, opts.ownDomainHost ?? null)) continue;
		findings.push({ id: "overused-font", snippet: `Primary font: ${font}` });
	}

	findings.push(...checkFlatTypeHierarchyFromDoc(doc, getStyle));
	return findings;
}

/**
 * Heading rhythm: a heading binds to the content it introduces, so its space above
 * must exceed its space below. Margins cannot be trusted (collapsing, flex rows,
 * section padding), so this measures the actual rect gaps to the nearest content.
 *
 * Two or more violations are required: a single one is noise.
 */
function checkHeadingRhythm(doc: PageSource, dom: DomAdapter): RuleHit[] {
	const MIN_VIOLATIONS = 2;
	const CARD_EXEMPT_HEIGHT = 200;
	const MAX_BELOW_PX = 160;
	const MIN_DEFICIT_PX = 12;

	const body = doc.body ?? null;
	const rectOf = (el: DomElement): Rect => el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };

	function isVisibleFlow(el: DomElement): boolean {
		const style = dom.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden") return false;
		if (parseFloat(style.opacity || "1") <= 0.05) return false;
		if (style.position === "absolute" || style.position === "fixed" || style.position === "sticky") return false;
		const rect = rectOf(el);
		return rect.width >= 1 && rect.height >= 1;
	}

	// Edges only count when they share the heading's column: grid layouts put
	// content beside a heading, and a far-away element says nothing about rhythm.
	function overlapsX(a: Rect, b: Rect): boolean {
		return Math.min(a.right, b.right) - Math.max(a.left, b.left) >= 8;
	}

	// A container with its own top boundary (background, top border, shadow) is the
	// separator above the heading, so raw whitespace is not the gap.
	function hasOwnTopBoundary(el: DomElement): boolean {
		const style = dom.getComputedStyle(el);
		const bg = parseAnyColor(style.backgroundColor || "");
		if (bg && bg.a > 0.05) return true;
		if ((parseFloat(style.borderTopWidth ?? "") || 0) > 0) return true;
		if (style.boxShadow && style.boxShadow !== "none") return true;
		return false;
	}

	// Eyebrows, kickers, and index labels directly on top of a heading belong to the
	// heading's own cluster, so space above is measured from the cluster's top.
	function clusterTop(h: DomElement, rect: Rect): { topEl: DomElement; top: number } {
		const headingFontSize = parseFloat(dom.getComputedStyle(h).fontSize ?? "") || 16;
		let topEl: DomElement = h;
		let top = rect.top;
		for (let i = 0; i < 3; i++) {
			const sib = topEl.previousElementSibling;
			if (!sib || !isVisibleFlow(sib)) break;
			const sr = rectOf(sib);
			if (!overlapsX(sr, rect)) break;
			const gap = top - sr.bottom;
			if (gap < 0 || gap >= 28 || sr.height > 60) break;
			const text = (sib.textContent || "").trim();
			const sibFontSize = parseFloat(dom.getComputedStyle(sib).fontSize ?? "") || 16;
			const labelLike = sibFontSize < headingFontSize * 0.75 || text.length <= 40;
			if (!labelLike || text.length > 80) break;
			topEl = sib;
			top = sr.top;
		}
		return { topEl, top };
	}

	// The nearest content edge strictly above the cluster. Returns null at the top of
	// the page or at a visually bounded container's edge.
	function edgeAbove(startEl: DomElement, top: number, rect: Rect): number | null {
		let node: DomElement | null = startEl;
		while (node && node !== body) {
			for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
				if (isVisibleFlow(sib)) {
					const sr = rectOf(sib);
					if (sr.bottom <= top + 2 && overlapsX(sr, rect)) return sr.bottom;
				}
			}
			const parent: DomElement | null = node.parentElement;
			if (!parent || parent === body) return null;
			if (hasOwnTopBoundary(parent)) return null;
			node = parent;
		}
		return null;
	}

	// The nearest content edge strictly below, which is the block the heading
	// introduces. Wrappers are crossed freely.
	function edgeBelow(h: DomElement, rect: Rect): number | null {
		let node: DomElement | null = h;
		while (node && node !== body) {
			for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
				if (isVisibleFlow(sib)) {
					const sr = rectOf(sib);
					if (sr.top >= rect.bottom - 2 && overlapsX(sr, rect)) return sr.top;
				}
			}
			node = node.parentElement;
		}
		return null;
	}

	function insideSmallCard(h: DomElement): boolean {
		let cur: DomElement | null = h.parentElement;
		while (cur && cur !== body) {
			if (isCardLikeInDoc(cur, dom) && rectOf(cur).height < CARD_EXEMPT_HEIGHT) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	const candidates: Array<{ tag: string; text: string; above: number; below: number }> = [];
	for (const h of Array.from(doc.querySelectorAll("h2, h3, h4"))) {
		if (!isVisibleFlow(h)) continue;
		const text = (h.textContent || "").trim().replace(/\s+/g, " ");
		if (text.length < 3) continue;

		const rect = rectOf(h);
		const belowTop = edgeBelow(h, rect);
		if (belowTop == null) continue; // the heading introduces nothing measurable
		const { topEl, top } = clusterTop(h, rect);
		const aboveBottom = edgeAbove(topEl, top, rect);
		if (aboveBottom == null) continue; // first content, or a bounded container
		if (insideSmallCard(h)) continue;

		const above = Math.max(0, top - aboveBottom);
		const below = Math.max(0, belowTop - rect.bottom);
		if (below < 6 || below > MAX_BELOW_PX) continue;
		// Near-equal gaps are ambiguous rather than inverted, so they pass.
		if (above < below * 0.75 && below - above >= MIN_DEFICIT_PX) {
			candidates.push({ tag: h.tagName.toLowerCase(), text: text.slice(0, 60), above, below });
		}
	}

	if (candidates.length < MIN_VIOLATIONS) return [];
	return candidates.map((c) => ({
		id: "heading-rhythm",
		snippet: `${c.tag} "${c.text}" has ${Math.round(c.above)}px above vs ${Math.round(c.below)}px below — it reads as bound to the block above (${candidates.length} headings on page)`,
	}));
}

export {
	checkFlatTypeHierarchyFromDoc,
	checkFlatTypeHierarchySamples,
	checkHeadingRhythm,
	checkLayoutInDoc,
	checkPageTypography,
	checkTypographyInDoc,
	dominantTypeRoleSize,
	isCardLikeInDoc,
	isRenderedTypeElement,
	TYPE_HIERARCHY_MIN_ROLES,
	TYPE_HIERARCHY_MIN_STEP_RATIO,
	TYPE_HIERARCHY_SELECTOR,
	typeHierarchyRole,
};
