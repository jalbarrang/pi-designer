/**
 * Clipping checks: a container that clips a positioned child, plus the box and
 * clip-path metrics the text checks share. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A clipping container (overflow hidden or clip, not a scroll region) that wraps an
 * absolutely- or fixed-positioned descendant cuts off popovers and menus that need
 * to escape. The judgment is about intent, so the gates are narrow: selection-state
 * viewports and decorative children are exempt.
 */
import { resolveLengthPx } from "./lengths.ts";
import { classSelector } from "./elements.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** Interactive or content-bearing positioned children: these need to escape, not be clipped. */
const POSITIONED_CHILD_INTERACTIVE_SELECTOR = [
	"a[href]",
	"button",
	"input",
	"select",
	"summary",
	"textarea",
	'[tabindex]:not([tabindex="-1"])',
	'[role="button"]',
	'[role="dialog"]',
	'[role="link"]',
	'[role="listbox"]',
	'[role="menu"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="tooltip"]',
].join(",");

/** True when the child carries text or something interactive, i.e. is not just decoration. */
function positionedChildHasSubstantiveContent(child: DomElement): boolean {
	const text = (child.textContent || "").replace(/\s+/g, " ").trim();
	if (text.length > 0) return true;
	if (typeof child.matches === "function") {
		try {
			if (child.matches(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
		} catch {
			// Selector-engine differences: fall through to the descendant query.
		}
	}
	if (typeof child.querySelector === "function") {
		try {
			if (child.querySelector(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
		} catch {
			// Selector-engine differences: treat as not substantive.
		}
	}
	return false;
}

/**
 * A positioned child that is decoration: hidden from assistive tech, marked as
 * presentational, a media element, or a class/id that names an ornament with no real
 * content.
 */
function positionedChildIsDecorative(child: DomElement | null | undefined): boolean {
	if (!child || typeof child.getAttribute !== "function") return false;
	if (child.closest?.('[aria-hidden="true"]')) return true;
	const role = (child.getAttribute("role") || "").toLowerCase();
	if (role === "none" || role === "presentation") return true;
	const tag = child.tagName ? child.tagName.toLowerCase() : "";
	if (["img", "svg", "canvas", "video"].includes(tag)) return true;

	const ident = `${child.getAttribute("class") || ""} ${child.getAttribute("id") || ""}`;
	if (
		/\b(art|bg|background|badge|blob|crop|decor|dot|glow|grain|image|mask|ornament|overlay|photo|scrim|shadow|shine|texture)\b/i.test(ident) &&
		!positionedChildHasSubstantiveContent(child)
	) {
		return true;
	}
	return false;
}

/**
 * True when the container is a deliberate viewport for clipped content: a carousel,
 * comparison, marquee, or demo stage. Clipping is the design there.
 */
function clippingContainerIsIntentionalViewport(el: DomElement | null | undefined): boolean {
	if (!el || typeof el.getAttribute !== "function") return false;
	const roleDescription = (el.getAttribute("aria-roledescription") || "").toLowerCase();
	if (/\b(carousel|slider)\b/.test(roleDescription)) return true;
	const ident = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`.toLowerCase();
	return (
		/\b(carousel|comparison|compare|fisheye|marquee|preview|scroller|slider|slideshow|split|viewport)\b/.test(ident) ||
		/\b(demo-area|demo-stage|demo-viewport)\b/.test(ident)
	);
}

/** A usable rect, or null when the engine cannot lay out or returns non-finite values. */
function elementRect(el: DomElement | null | undefined): Rect | null {
	if (!el || typeof el.getBoundingClientRect !== "function") return null;
	try {
		const rect = el.getBoundingClientRect();
		if (!rect) return null;
		const values = [rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height];
		if (!values.every(Number.isFinite)) return null;
		if (rect.width <= 0 && rect.height <= 0) return null;
		return rect;
	} catch {
		return null;
	}
}

/** True when the offsets spell an escape: a negative value or a full 100% on some axis. */
function positionedStyleImpliesEscape(style: CssStyle): boolean {
	const values = [
		style.top, style.right, style.bottom, style.left, style.inset, style.insetBlock, style.insetInline,
		style.insetBlockStart, style.insetBlockEnd, style.insetInlineStart, style.insetInlineEnd,
	]
		.filter((value): value is string => !!value)
		.map((value) => String(value).trim().toLowerCase());

	for (const value of values) {
		if (/(^|[\s(])-+(?:\d|\.)/.test(value)) return true;
		if (/(^|[\s(])100(?:\.0+)?%/.test(value)) return true;
	}
	return false;
}

/** True when the child's box sits outside the container on a clipped axis; null when unmeasurable. */
function positionedChildEscapesClip(el: DomElement, child: DomElement, clipX: boolean, clipY: boolean): boolean | null {
	const parentRect = elementRect(el);
	const childRect = elementRect(child);
	if (!parentRect || !childRect) return null;
	const threshold = 2;
	return Boolean(
		(clipX && (childRect.left < parentRect.left - threshold || childRect.right > parentRect.right + threshold)) ||
			(clipY && (childRect.top < parentRect.top - threshold || childRect.bottom > parentRect.bottom + threshold)),
	);
}

/**
 * The clipped-overflow finding: a clipping container whose positioned descendant
 * escapes it. When the engine cannot measure either rect, the child's own offsets
 * decide instead, so the check still fires on a static parse.
 */
function checkClippedOverflow(el: DomElement, style: CssStyle, getStyle: (el: DomElement) => CssStyle): RuleHit[] {
	const clips = (v: string | undefined) => v === "hidden" || v === "clip";
	const scrolls = (v: string | undefined) => v === "auto" || v === "scroll";

	const ox = style.overflowX || "";
	const oy = style.overflowY || "";
	const ov = style.overflow || "";
	const clipX = clips(ox) || clips(ov);
	const clipY = clips(oy) || clips(ov);
	if (!(clipX || clipY)) return [];
	if (scrolls(ox) || scrolls(oy) || scrolls(ov)) return [];
	if (clippingContainerIsIntentionalViewport(el)) return [];
	if (!el.querySelectorAll) return [];

	for (const child of Array.from(el.querySelectorAll("*"))) {
		const childStyle = getStyle(child);
		const pos = childStyle.position || "";
		if (pos !== "absolute" && pos !== "fixed") continue;
		if (positionedChildIsDecorative(child)) continue;

		const escapes = positionedChildEscapesClip(el, child, clipX, clipY);
		if (escapes === false) continue;
		if (escapes === null && !positionedStyleImpliesEscape(childStyle)) continue;
		return [{ id: "clipped-overflow-container", snippet: `${classSelector(el)} clips a positioned child` }];
	}
	return [];
}

/** A length that may arrive as a number or a CSS string. */
function metricLengthPx(value: unknown, fontSizePx = 16): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	return resolveLengthPx(value, fontSizePx);
}

/** The first of the given values that resolves to a length. */
function firstMetricLengthPx(fontSizePx: number, ...values: unknown[]): number | null {
	for (const value of values) {
		const parsed = metricLengthPx(value, fontSizePx);
		if (parsed !== null) return parsed;
	}
	return null;
}

/** A 1–4 value box shorthand expanded to top, right, bottom, left. */
function expandBoxShorthand(parts: readonly string[]): string[] {
	if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
	if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
	if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
	return [parts[0], parts[1], parts[2], parts[3]];
}

/** True when a `clip-path: inset()` covers the whole box (top+bottom or left+right reach 100%). */
function clippedByInset(clipPath: string | null | undefined): boolean {
	const match = String(clipPath || "").trim().toLowerCase().match(/^inset\s*\(([^)]*)\)$/);
	if (!match) return false;
	const beforeRound = match[1].split(/\s+round\s+/)[0].trim();
	if (!beforeRound) return false;
	const values = expandBoxShorthand(beforeRound.split(/\s+/).slice(0, 4));
	const percents = values.map((value) => String(value).trim().match(/^(-?\d+(?:\.\d+)?)%$/));
	if (percents.some((p) => !p)) return false;
	const [top, right, bottom, left] = percents.map((p) => parseFloat((p as RegExpMatchArray)[1]));
	return top + bottom >= 100 || left + right >= 100;
}

/** True when a legacy `clip: rect()` collapses the box (bottom <= top or right <= left). */
function clippedByRect(clip: string | null | undefined): boolean {
	const match = String(clip || "").trim().toLowerCase().match(/^rect\s*\(([^)]*)\)$/);
	if (!match) return false;
	const values = match[1].split(/[,\s]+/).map((value) => value.trim()).filter(Boolean);
	if (values.length !== 4) return false;
	const [top, right, bottom, left] = values.map((value) => metricLengthPx(value, 16));
	if ([top, right, bottom, left].some((value) => value === null)) return false;
	return (bottom as number) <= (top as number) || (right as number) <= (left as number);
}

/** The clipped-overflow tell for a live element. */
function checkElementClippedOverflowDOM(el: DomElement, dom: DomAdapter): RuleHit[] {
	return checkClippedOverflow(el, dom.getComputedStyle(el), (node) => dom.getComputedStyle(node));
}

export {
	checkClippedOverflow,
	checkElementClippedOverflowDOM,
	clippedByInset,
	clippedByRect,
	clippingContainerIsIntentionalViewport,
	elementRect,
	expandBoxShorthand,
	firstMetricLengthPx,
	metricLengthPx,
	POSITIONED_CHILD_INTERACTIVE_SELECTOR,
	positionedChildEscapesClip,
	positionedChildHasSubstantiveContent,
	positionedChildIsDecorative,
	positionedStyleImpliesEscape,
};
