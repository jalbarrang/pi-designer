/**
 * Element adapters: the bridge between a DOM element and the pure checks.
 * Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0;
 * see NOTICE).
 *
 * Each adapter reads what it needs from the element and the computed style, then
 * calls the pure check. Keeping the read here and the judgment there is what lets
 * the same rules run over a live page and a parsed file.
 */
import { parseAnyColor, parseRgb, type Color } from "../shared/color.ts";
import { BORDER_SAFE_TAGS } from "../shared/constants.ts";
import { isEmojiOnlyText } from "./text.ts";
import { checkBorders, type BorderSide } from "./borders.ts";
import { checkColors, checkHoverContrast, type ScanMode } from "./colors.ts";
import { checkIconTile, checkHeroEyebrow, checkItalicSerif, HEADING_TAGS } from "./typography.ts";
import {
	readOwnBackgroundColor,
	resolveBackgroundInfo,
	resolveGradientStops,
	type ElementLike,
	type StyleHost,
} from "./background.ts";
import type { DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

const SIDES: readonly BorderSide[] = ["Top", "Right", "Bottom", "Left"];

/** A readable `tag.class` label for a finding snippet, or just the tag. */
function classSelector(el: DomElement): string {
	const cls = (el.getAttribute ? el.getAttribute("class") : el.className) || "";
	const tokens = String(cls).trim().split(/\s+/).filter(Boolean);
	const tag = el.tagName ? el.tagName.toLowerCase() : "el";
	return tokens.length > 0 ? `${tag}.${tokens.join(".")}` : tag;
}

/** The text the element owns directly, ignoring descendant text. */
function directText(el: DomElement): string {
	return (el.childNodes ?? [])
		.filter((n) => n.nodeType === 3)
		.map((n) => n.textContent ?? "")
		.join("");
}

/** False when the element or an ancestor is hidden, collapsed, or fully transparent. */
function isRenderedForBrowserRule(el: DomElement, dom: DomAdapter): boolean {
	for (let cur: DomElement | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
		if (cur.getAttribute?.("aria-hidden") === "true") return false;
		const style = dom.getComputedStyle(cur);
		const visibility = String(style.visibility ?? "").toLowerCase();
		if (style.display === "none" || visibility === "hidden" || visibility === "collapse") return false;
		if ((parseFloat(style.opacity ?? "") || 0) <= 0.01) return false;
		if (String(style.contentVisibility ?? "").toLowerCase() === "hidden") return false;
	}
	return true;
}

/** Accumulated opacity up the tree; 0 when any layer makes the element invisible. */
function effectiveOpacity(el: DomElement, dom: DomAdapter): number {
	let o = 1;
	for (let cur: DomElement | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
		o *= parseFloat(dom.getComputedStyle(cur).opacity || "1");
		if (o <= 0.02) return 0;
	}
	return o;
}

/**
 * Selected-state context for accent stripes. Only an actual selection marker
 * exempts the stripe as the standard active-item indicator: `aria-selected="true"`,
 * `aria-current` (any non-false value), or an active/current/selected class hint.
 *
 * Tab-strip membership alone deliberately does not: a chromatic stripe repeated
 * on every tab in a group, or every menu item, is decoration, not state.
 */
function isTabContextElement(el: DomElement | null): boolean {
	if (!el) return false;
	try {
		if (el.closest?.('[aria-selected="true"], [aria-current]:not([aria-current="false"])')) return true;
	} catch {
		// Selector-engine differences: fall through to the class scan.
	}
	let cur: DomElement | null = el;
	let depth = 0;
	while (cur && cur.nodeType === 1 && depth < 6) {
		const cls = String(cur.getAttribute?.("class") || cur.className || "");
		if (/(?:^|[\s_-])(?:active|current|selected)(?:$|[\s_-])/i.test(cls)) return true;
		cur = cur.parentElement;
		depth++;
	}
	return false;
}

/**
 * Status-surface context for accent borders. On a live status or alert region a
 * colored single-edge border is the established severity-accent convention (a
 * toast, snackbar, or callout bar), not the decorative tell. The CSS-only scanners
 * never see this, because they have no role information.
 */
function isStatusContextElement(el: DomElement | null): boolean {
	if (!el) return false;
	try {
		return !!el.closest?.(
			'[role="status"], [role="alert"], [role="alertdialog"], [role="log"], [aria-live="polite"], [aria-live="assertive"]',
		);
	} catch {
		// Selector-engine differences: no status context.
		return false;
	}
}

/** The border tell for one element, with tab, status, and chip context resolved. */
function checkElementBordersDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (BORDER_SAFE_TAGS.has(tag)) return [];
	const rect = el.getBoundingClientRect?.();
	if (rect && (rect.width < 20 || rect.height < 20)) return [];

	const style = dom.getComputedStyle(el);
	const widths = {} as Record<BorderSide, number>;
	const colors = {} as Record<BorderSide, string>;
	for (const side of SIDES) {
		widths[side] = parseFloat(style[`border${side}Width`] ?? "") || 0;
		colors[side] = style[`border${side}Color`] ?? "";
	}
	const ownBg = parseRgb(style.backgroundColor) ?? parseAnyColor(style.backgroundColor);
	return checkBorders(tag, widths, colors, parseFloat(style.borderRadius ?? "") || 0, {
		tabContext: isTabContextElement(el),
		statusContext: isStatusContextElement(el),
		badgeLike: !!(ownBg && ownBg.a > 0.1),
	});
}

/**
 * The pseudo-element stripe, read from computed style instead of stylesheet text.
 * The text scanner cannot see a stripe whose color only exists at runtime (an
 * inline per-card custom property) or whose geometry resolves in layout; here the
 * browser has already resolved both.
 */
function checkElementPseudoStripeDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (BORDER_SAFE_TAGS.has(tag) || tag === "summary") return [];
	if (el.closest?.("nav, blockquote, pre")) return [];
	if (!isRenderedForBrowserRule(el, dom)) return [];

	const rect = el.getBoundingClientRect?.();
	const hostRect: Rect = rect ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	if (hostRect.width < 40 || hostRect.height < 20) return [];
	if (isTabContextElement(el)) return [];

	const findings: RuleHit[] = [];
	for (const which of ["::before", "::after"] as const) {
		let ps;
		try {
			ps = dom.getComputedStyle(el, which);
		} catch {
			continue;
		}
		if (!ps || ps.content === "none" || ps.content === "") continue;
		if (ps.position !== "absolute" && ps.position !== "fixed") continue;
		if ((parseFloat(ps.opacity ?? "") || 0) <= 0.01 || ps.display === "none") continue;
		const w = parseFloat(ps.width ?? "") || 0;
		const h = parseFloat(ps.height ?? "") || 0;
		if (!(w > 0 && h > 0)) continue;

		// Used values: for an absolutely-positioned box the browser resolves both
		// edge offsets after layout, so these are real distances, never "auto".
		const left = parseFloat(ps.left ?? "");
		const right = parseFloat(ps.right ?? "");
		const top = parseFloat(ps.top ?? "");
		const bottom = parseFloat(ps.bottom ?? "");
		const hugs = (v: number) => Number.isFinite(v) && v >= -2 && v <= 2;

		let edge: string | null = null;
		let thickness: number | null = null;
		// A vertical stripe: a narrow box spanning nearly the host's full height,
		// hugging an edge. "Nearly" tolerates the floating variant.
		if (w >= 3 && w <= 12 && h >= hostRect.height - 44 && h >= hostRect.height * 0.5) {
			edge = hugs(left) ? "left" : hugs(right) ? "right" : null;
			thickness = w;
		}
		// A horizontal stripe riding the top or bottom edge. Button- and
		// link-styled hosts keep their underline affordances.
		if (!edge && h >= 3 && h <= 12 && w >= hostRect.width - 44 && w >= hostRect.width * 0.5) {
			const cls = String(el.getAttribute?.("class") || el.className || "");
			if (!/(?:^|[\s_-])(?:btn|button|link)(?:$|[\s\w_-])/i.test(cls)) {
				edge = hugs(top) ? "top" : hugs(bottom) ? "bottom" : null;
				thickness = h;
			}
		}
		if (!edge) continue;

		const bg = parseRgb(ps.backgroundColor) ?? parseAnyColor(ps.backgroundColor);
		if (!bg || bg.a < 0.1) continue;
		if (Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b) < 30) continue;

		findings.push({
			id: "side-tab",
			snippet: `${classSelector(el)}${which} — absolute ${thickness}px pseudo-element stripe (${edge})`,
		});
	}
	return findings;
}

/**
 * A full-cover surface pseudo-element: an absolute or fixed `::before`/`::after`
 * that covers nearly the whole host with an opaque background. That pseudo is the
 * element's visible surface even though its own background-color reads transparent,
 * which is the nav-CTA construction that otherwise escapes every own-background
 * contrast gate.
 */
function readPseudoSurface(el: DomElement, rect: Rect, dom: DomAdapter): Color | null {
	for (const which of ["::before", "::after"] as const) {
		let ps;
		try {
			ps = dom.getComputedStyle(el, which);
		} catch {
			continue;
		}
		if (!ps || ps.content === "none" || ps.content === "") continue;
		if (ps.position !== "absolute" && ps.position !== "fixed") continue;
		if (ps.display === "none" || (parseFloat(ps.opacity ?? "") || 1) < 0.9) continue;
		const w = parseFloat(ps.width ?? "") || 0;
		const h = parseFloat(ps.height ?? "") || 0;
		if (w < rect.width - 4 || h < rect.height - 4) continue;
		const bg = parseRgb(ps.backgroundColor) ?? parseAnyColor(ps.backgroundColor);
		if (!bg || bg.a < 0.9) continue;
		return bg;
	}
	return null;
}

/** Contrast, palette, and gradient-text checks for one element. */
function checkElementColorsDOM(
	el: DomElement,
	dom: DomAdapter,
	customPropMap: Map<string, string> | null,
	mode: ScanMode,
): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	// No SAFE_TAGS bail here: checkColors does its own gating, including the
	// styled-control exception for an <a> or <button> with its own opaque surface.
	const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	if (rect.width < 10 || rect.height < 10) return [];

	const style = dom.getComputedStyle(el);
	// Hidden scene variants (opacity-0 carousels, swap decks) are not user-visible;
	// measuring their inherited colors against whatever sits behind the stack is
	// noise, not an audit.
	if (style.visibility === "hidden" || effectiveOpacity(el, dom) <= 0.02) return [];

	const text = directText(el);
	const hasDirectText = text.trim().length > 0;

	const host: StyleHost = { getComputedStyle: (node) => dom.getComputedStyle(node as DomElement) };
	const bgInfo = resolveBackgroundInfo(el as ElementLike, host, customPropMap, mode);
	let effectiveBg = bgInfo.color;
	let surfaceUnresolved = bgInfo.unresolved;

	let ownBg = readOwnBackgroundColor(el as ElementLike, { backgroundColor: style.backgroundColor ?? "" }, mode);
	if (!ownBg || ownBg.a <= 0.5) {
		const pseudoSurface = readPseudoSurface(el, rect, dom);
		if (pseudoSurface) {
			ownBg = pseudoSurface;
			effectiveBg = pseudoSurface;
			surfaceUnresolved = false;
		}
	}

	return checkColors({
		tag,
		// Some engines serialize colors in modern spaces as oklch()/oklab(); without
		// the parseAnyColor fallback the text color comes back null and the contrast
		// checks silently never run.
		textColor: parseRgb(style.color) ?? parseAnyColor(style.color),
		bgColor: ownBg,
		effectiveBg: surfaceUnresolved ? null : effectiveBg,
		effectiveBgStops: surfaceUnresolved || effectiveBg ? null : resolveGradientStops(el as ElementLike, host, customPropMap, mode),
		fontSize: parseFloat(style.fontSize ?? "") || 16,
		fontWeight: parseInt(style.fontWeight ?? "", 10) || 400,
		hasDirectText,
		isEmojiOnly: isEmojiOnlyText(text),
		bgClip: style.webkitBackgroundClip || style.backgroundClip || "",
		bgImage: style.backgroundImage || "",
		classList: el.getAttribute?.("class") || "",
		mode,
	});
}

/**
 * The icon-tile shape above a heading. The tile may contain an icon element, or
 * carry an emoji/symbol directly as its only text (the "card icon" pattern).
 */
function checkElementIconTileDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (!HEADING_TAGS.has(tag)) return [];
	const sibling = el.previousElementSibling;
	if (!sibling) return [];

	const sibRect = sibling.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	const headRect = el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
	const sibStyle = dom.getComputedStyle(sibling);

	const iconChild = sibling.querySelector?.('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]') ?? null;
	const iconRect = iconChild?.getBoundingClientRect?.();
	const sibText = directText(sibling);
	const hasInlineEmojiIcon = (sibling.children?.length ?? 0) === 0 && isEmojiOnlyText(sibText);

	return checkIconTile({
		headingTag: tag,
		headingText: el.textContent || "",
		headingTop: headRect.top,
		siblingTag: sibling.tagName.toLowerCase(),
		siblingWidth: sibRect.width,
		siblingHeight: sibRect.height,
		siblingBottom: sibRect.bottom,
		siblingBgColor: parseRgb(sibStyle.backgroundColor),
		siblingBgImage: sibStyle.backgroundImage || "",
		siblingBorderWidth: parseFloat(sibStyle.borderTopWidth ?? "") || 0,
		siblingBorderRadius: parseFloat(sibStyle.borderRadius ?? "") || 0,
		hasIconChild: !!iconChild || hasInlineEmojiIcon,
		iconChildWidth: iconRect?.width ?? 0,
	});
}

/** True when the element paints a short chromatic bar as a `::before`/`::after`. */
function hasAccentDashPseudo(el: DomElement, dom: DomAdapter): boolean {
	for (const which of ["::before", "::after"] as const) {
		let ps;
		try {
			ps = dom.getComputedStyle(el, which);
		} catch {
			continue;
		}
		if (!ps || ps.content === "none" || ps.content === "") continue;
		const w = parseFloat(ps.width ?? "") || 0;
		const h = parseFloat(ps.height ?? "") || 0;
		if (!(w >= 8 && w <= 80 && h >= 1 && h <= 6)) continue;
		const bg = parseRgb(ps.backgroundColor) ?? parseAnyColor(ps.backgroundColor);
		if (!bg || bg.a < 0.1) continue;
		if (Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b) >= 30) return true;
	}
	return false;
}

/** The label-above-hero-headline tell, with application context and dash prefixes resolved. */
function checkElementHeroEyebrowDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (tag !== "h1") return [];
	const sibling = el.previousElementSibling;
	if (!sibling) return [];

	const headStyle = dom.getComputedStyle(el);
	const sibStyle = dom.getComputedStyle(sibling);

	return checkHeroEyebrow({
		headingTag: tag,
		headingText: el.textContent || "",
		headingFontSize: parseFloat(headStyle.fontSize ?? "") || 0,
		headingInApplicationContext: !!el.closest?.('[role="tabpanel"], [role="dialog"], [role="application"], dialog'),
		siblingTag: sibling.tagName.toLowerCase(),
		siblingText: sibling.textContent || "",
		siblingTextTransform: sibStyle.textTransform || "",
		siblingFontSize: parseFloat(sibStyle.fontSize ?? "") || 0,
		siblingLetterSpacing: parseFloat(sibStyle.letterSpacing ?? "") || 0,
		siblingFontWeight: sibStyle.fontWeight || "",
		siblingColor: sibStyle.color || "",
		siblingHasAccentDashPseudo: hasAccentDashPseudo(sibling, dom),
	});
}

/** The italic-serif hero tell for a heading element. */
function checkElementItalicSerifDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	if (tag !== "h1" && tag !== "h2") return [];
	const style = dom.getComputedStyle(el);
	return checkItalicSerif({
		tag,
		fontStyle: style.fontStyle || "",
		fontFamily: style.fontFamily || "",
		fontSize: parseFloat(style.fontSize ?? "") || 0,
		headingText: el.textContent || "",
	});
}

export {
	checkElementBordersDOM,
	checkElementColorsDOM,
	checkElementHeroEyebrowDOM,
	checkElementIconTileDOM,
	checkElementItalicSerifDOM,
	checkElementPseudoStripeDOM,
	checkHoverContrast as checkElementHoverContrast,
	classSelector,
	directText,
	effectiveOpacity,
	hasAccentDashPseudo,
	isRenderedForBrowserRule,
	isStatusContextElement,
	isTabContextElement,
	readPseudoSurface,
};
