/**
 * Overlap checks: cards flush against a scroller edge, text painted under an opaque
 * box, and a first-viewport column that runs far past the fold. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These are the composition failures a static scan cannot see: they exist only in
 * the rendered geometry, and each one needs a DOM with layout.
 */
import { parseAnyColor } from "../shared/color.ts";
import { classSelector, effectiveOpacity, isRenderedForBrowserRule } from "./elements.ts";
import { isScreenReaderOnlyTextStyle } from "./text-visibility.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/**
 * An opaque decorated box: a near-solid background fill or two or more visible
 * borders make it hide what sits behind. Gradient and image fills are excluded on
 * purpose, because a scrim over hero imagery is a contrast layer, not an occluder.
 */
function isOpaqueDecoratedBox(cs: CssStyle | null | undefined): boolean {
	if (!cs) return false;
	const bg = parseAnyColor(cs.backgroundColor || "");
	if (bg && bg.a > 0.6) return true;
	return (
		["Top", "Right", "Bottom", "Left"].filter((side) => {
			if ((parseFloat(cs[`border${side}Width`] ?? "") || 0) <= 0) return false;
			const bc = parseAnyColor(cs[`border${side}Color`] || "");
			return !!bc && bc.a > 0.3;
		}).length >= 2
	);
}

/**
 * Is the element lifted out of normal flow into a layer that can cover a sibling?
 * Two normal-flow blocks stacked vertically cannot truly hide each other's ink: an
 * overlap between their rects is line-box bleed from tight leading. Only out-of-flow
 * positioning moves an element onto another's pixels.
 */
function isLayeredElement(el: DomElement | null | undefined, dom: DomAdapter): boolean {
	for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
		const pos = String(dom.getComputedStyle(cur).position || "static");
		if (pos === "absolute" || pos === "fixed" || pos === "sticky") return true;
	}
	return false;
}

/** The text the element owns directly, trimmed. */
function elementDirectText(el: DomElement | null | undefined): string {
	let t = "";
	for (const node of el?.childNodes ?? []) {
		if (node.nodeType === 3) t += node.textContent ?? "";
	}
	return t.trim();
}

/**
 * Rendered gate that, unlike `isRenderedForBrowserRule`, does NOT exempt aria-hidden
 * subtrees: a decorative box hidden from assistive tech still paints, and can still
 * cover real text.
 */
function isPaintedForOcclusion(el: DomElement, dom: DomAdapter): boolean {
	for (let cur: DomElement | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
		const style = dom.getComputedStyle(cur);
		const visibility = String(style.visibility || "").toLowerCase();
		if (style.display === "none" || visibility === "hidden" || visibility === "collapse") return false;
		if ((parseFloat(style.opacity ?? "") || 0) <= 0.05) return false;
		if (String(style.contentVisibility || "").toLowerCase() === "hidden") return false;
	}
	return true;
}

const OCCLUSION_TEXT_SKIP_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript", "template", "title"]);

export interface OverlapViewport {
	readonly width: number;
	readonly height: number;
	readonly scrollX?: number;
	readonly scrollY?: number;
	/** Hit-testing; absent in a parsed document, which then skips the probe path. */
	elementFromPoint?(x: number, y: number): DomElement | null;
}

const ZERO_RECT: Rect = { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
const rectOf = (el: DomElement | null | undefined): Rect => el?.getBoundingClientRect?.() ?? ZERO_RECT;

/**
 * Text painted under an opaque box or another text run: the reader cannot read it.
 * Plus two structural tells the point probe cannot reach — a display headline tucking
 * behind an opaque card, and an inline element whose leaked padding box covers a
 * sibling.
 */
function checkTextOcclusion(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement>; readonly documentElement?: DomElement | null },
	dom: DomAdapter,
	viewport: OverlapViewport,
): RuleHit[] {
	const findings: RuleHit[] = [];
	const seenVictims = new Set<DomElement>();
	const vw = viewport.width || 1280;
	const vh = viewport.height || 800;
	const scrollY = viewport.scrollY ?? 0;

	const isFloated = (cs: CssStyle) => {
		const f = String(cs.cssFloat || cs.float || "none").toLowerCase();
		return f === "left" || f === "right";
	};
	const isMarqueeish = (el: DomElement, cs: CssStyle) => {
		if (el.tagName === "MARQUEE") return true;
		const ident = `${el.getAttribute?.("class") || ""} ${el.getAttribute?.("id") || ""}`;
		if (/\b(marquee|ticker|scroller|carousel|conveyor)\b/i.test(ident)) return true;
		return /marquee|ticker|scroll/.test(String(cs.animationName || "").toLowerCase());
	};
	// A fixed or sticky overlay floats above scrolling content by design: whatever sits
	// under it scrolls clear, so it is not occluding the page.
	const isPinnedOverlay = (el: DomElement) => {
		for (let cur: DomElement | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
			const pos = String(dom.getComputedStyle(cur).position || "static");
			if (pos === "fixed" || pos === "sticky") return true;
		}
		return false;
	};

	// The part of an element actually painted, after every clipping ancestor has cut
	// it. A rect reports where a box would be if nothing clipped it, so a paragraph
	// half scrolled out of a panel would otherwise be probed at coordinates it never
	// paints, and reported as buried under whatever genuinely sits there.
	const paintedRect = (el: DomElement, rect: Rect): Rect | null => {
		let left = rect.left;
		let top = rect.top;
		let right = rect.right;
		let bottom = rect.bottom;
		for (let cur: DomElement | null = el.parentElement; cur && cur !== doc.documentElement; cur = cur.parentElement) {
			let cs: CssStyle;
			try {
				cs = dom.getComputedStyle(cur);
			} catch {
				continue;
			}
			const clipsX = String(cs.overflowX || "visible") !== "visible";
			const clipsY = String(cs.overflowY || "visible") !== "visible";
			if (!clipsX && !clipsY) continue;
			let b: Rect;
			try {
				b = rectOf(cur);
			} catch {
				continue;
			}
			if (clipsX) {
				left = Math.max(left, b.left);
				right = Math.min(right, b.right);
			}
			if (clipsY) {
				top = Math.max(top, b.top);
				bottom = Math.min(bottom, b.bottom);
			}
			if (right - left < 1 || bottom - top < 1) return null;
		}
		return { left, top, right, bottom, width: right - left, height: bottom - top };
	};

	type Victim = { el: DomElement; rect: Rect; text: string; inSvg: boolean };
	const textEls: Victim[] = [];
	for (const el of Array.from(doc.querySelectorAll("body *"))) {
		const tag = el.tagName.toLowerCase();
		if (OCCLUSION_TEXT_SKIP_TAGS.has(tag)) continue;
		const inSvg = !!el.closest?.("svg");
		if (inSvg && tag !== "text") continue;
		const text = inSvg ? (el.textContent || "").trim() : elementDirectText(el);
		if (text.length < 2) continue;
		if (!isPaintedForOcclusion(el, dom)) continue;
		if (effectiveOpacity(el, dom) <= 0.02) continue;

		const full = rectOf(el);
		if (full.width < 6 || full.height < 6) continue;
		// Probe only where the text is on screen; a run clipped to a sliver is dropped
		// rather than sampled, because a few visible pixels support no useful fraction.
		const rect = paintedRect(el, full);
		if (!rect || rect.width < 6 || rect.height < 6) continue;
		if (rect.bottom <= 0 || rect.top >= vh) continue;
		textEls.push({ el, rect, text, inSvg });
	}

	const probe = viewport.elementFromPoint;
	if (probe) {
		for (const victim of textEls) {
			const { el, rect, text } = victim;
			if (seenVictims.has(el)) continue;
			const style = dom.getComputedStyle(el);
			const metrics = el as unknown as { clientWidth?: number; clientHeight?: number };
			if (isScreenReaderOnlyTextStyle(style, { width: rect.width, height: rect.height, clientWidth: metrics.clientWidth, clientHeight: metrics.clientHeight })) continue;

			const cols = Math.max(6, Math.min(30, Math.round(rect.width / 12)));
			const rows = Math.max(1, Math.min(4, Math.round(rect.height / 14)));
			let total = 0;
			let occluded = 0;
			let occluderEl: DomElement | null = null;
			let occluderKind: "" | "box" | "text" = "";

			for (let i = 0; i < cols; i++) {
				const x = rect.left + rect.width * ((i + 0.5) / cols);
				if (x < 1 || x > vw - 1) continue;
				for (let j = 0; j < rows; j++) {
					const y = rect.top + rect.height * ((j + 0.5) / rows);
					if (y < 1 || y > vh - 1) continue;
					total++;
					const top = probe(x, y);
					if (!top) continue;
					// Text visible here: the probe returns the text itself, a descendant, or
					// one of its ancestors.
					if (top === el || el.contains?.(top) || top.contains?.(el)) continue;
					const topCs = dom.getComputedStyle(top);
					if (isFloated(topCs) || isMarqueeish(top, topCs) || isPinnedOverlay(top)) continue;
					if (effectiveOpacity(top, dom) <= 0.02) continue;
					// Text under a raw image or video is contrast territory, not this rule.
					if (["img", "video", "canvas", "picture"].includes(top.tagName.toLowerCase())) continue;

					const topHasText = elementDirectText(top).length > 0 || !!top.closest?.("svg");
					if (isOpaqueDecoratedBox(topCs)) {
						occluded++;
						if (!occluderEl) {
							occluderEl = top;
							occluderKind = "box";
						}
					} else if (topHasText) {
						occluded++;
						if (!occluderEl) {
							occluderEl = top;
							occluderKind = "text";
						}
					}
				}
			}
			if (total === 0 || !occluderEl) continue;

			const occFrac = occluded / total;
			// A solid box's paint fills its rect, so box coverage is real at a lower bar.
			// Text coverage rides on the probe returning the occluder's box, which can exceed
			// its glyph ink, so the text bar is higher: partial overlap is crowding.
			if (occFrac < (occluderKind === "text" ? 0.45 : 0.3)) continue;

			if (occluderKind === "text") {
				// Two SVG texts inside one emblem are one decorative unit.
				const victimSvg = el.closest?.("svg");
				const occSvg = occluderEl.closest?.("svg");
				if (victimSvg && occSvg && victimSvg === occSvg) continue;
				// Both in plain flow: the overlap is line-box bleed from tight leading.
				if (!isLayeredElement(el, dom) && !isLayeredElement(occluderEl, dom)) continue;
			}

			seenVictims.add(el);
			findings.push({
				id: "text-occlusion",
				snippet: `${classSelector(el)} "${text.slice(0, 24)}" is ${Math.round(occFrac * 100)}% covered by ${occluderKind === "text" ? "overlapping text" : "an opaque element"} (${classSelector(occluderEl)})`,
			});
		}
	}

	// A display headline whose bulk sits outside a bounded card but whose edge clips
	// into it: the two layers were dropped on the same pixels.
	const cards: Array<{ el: DomElement; rect: Rect }> = [];
	for (const el of Array.from(doc.querySelectorAll("body *"))) {
		if (el.closest?.("svg")) continue;
		if (!isPaintedForOcclusion(el, dom)) continue;
		const cs = dom.getComputedStyle(el);
		const bg = parseAnyColor(cs.backgroundColor || "");
		const bgImg = cs.backgroundImage || "";
		if (!bg || bg.a <= 0.7) continue;
		if (bgImg && bgImg !== "none" && /(gradient|url)\(/i.test(bgImg)) continue;
		const hasBorder = ["Top", "Right", "Bottom", "Left"].some((s) => (parseFloat(cs[`border${s}Width`] ?? "") || 0) > 0);
		const hasShadow = !!cs.boxShadow && cs.boxShadow !== "none";
		if (!hasBorder && !hasShadow) continue;
		if (isPinnedOverlay(el)) continue;
		const cr = rectOf(el);
		if (cr.width < 100 || cr.width > 0.8 * vw || cr.height < 60) continue;
		cards.push({ el, rect: cr });
	}

	for (const victim of textEls) {
		const { el, rect, text } = victim;
		if (seenVictims.has(el)) continue;
		const style = dom.getComputedStyle(el);
		if ((parseFloat(style.fontSize ?? "") || 16) < 40) continue;

		let lineHeight = parseFloat(style.lineHeight ?? "");
		if (!Number.isFinite(lineHeight)) lineHeight = (parseFloat(style.fontSize ?? "") || 16) * 1.2;
		const centerX = rect.left + rect.width / 2;

		for (const card of cards) {
			if (card.el === el || el.contains?.(card.el) || card.el.contains?.(el)) continue;
			const ix = Math.max(0, Math.min(rect.right, card.rect.right) - Math.max(rect.left, card.rect.left));
			const iy = Math.max(0, Math.min(rect.bottom, card.rect.bottom) - Math.max(rect.top, card.rect.top));
			if (ix < 8 || iy < 0.5 * lineHeight) continue;
			// The headline's bulk must sit outside the card; only its edge clips in.
			if (centerX >= card.rect.left && centerX <= card.rect.right) continue;
			if (ix > 0.5 * rect.width) continue;

			seenVictims.add(el);
			findings.push({
				id: "text-occlusion",
				snippet: `${classSelector(el)} "${text.slice(0, 24)}" overhangs ${classSelector(card.el)} by ${Math.round(ix)}px — the headline and the card collide`,
			});
			break;
		}
	}

	// An inline element with an opaque background and large vertical padding paints a
	// filled block whose padding box overflows its line, landing on the content above
	// and below instead of enclosing its own text. The tell is a rendered height several
	// times the line height, which separates the leak from a padded highlight.
	for (const el of Array.from(doc.querySelectorAll("body *"))) {
		if (el.closest?.("svg")) continue;
		if (!isPaintedForOcclusion(el, dom)) continue;
		const cs = dom.getComputedStyle(el);
		if (cs.display !== "inline") continue;
		const bg = parseAnyColor(cs.backgroundColor || "");
		if (!bg || bg.a <= 0.6) continue;

		const padTop = parseFloat(cs.paddingTop ?? "") || 0;
		const padBottom = parseFloat(cs.paddingBottom ?? "") || 0;
		if (padTop + padBottom < 24) continue;

		const rect = rectOf(el);
		if (rect.width < 12 || rect.height < 24) continue;

		const fontSize = parseFloat(cs.fontSize ?? "") || 16;
		let lineHeight = parseFloat(cs.lineHeight ?? "");
		if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.4;
		if (rect.height < 2.2 * lineHeight) continue;
		if (seenVictims.has(el)) continue;

		// Name a neighbour the fill lands on, if one is nearby.
		let overlaps: DomElement | null = null;
		for (const other of el.parentElement?.children ?? []) {
			if (other === el || el.contains?.(other) || other.contains?.(el)) continue;
			if (dom.getComputedStyle(other).display === "none") continue;
			const oRect = rectOf(other);
			const ix = Math.max(0, Math.min(rect.right, oRect.right) - Math.max(rect.left, oRect.left));
			const iy = Math.max(0, Math.min(rect.bottom, oRect.bottom) - Math.max(rect.top, oRect.top));
			if (ix > 4 && iy > 4 && (other.textContent || "").trim().length > 0) {
				overlaps = other;
				break;
			}
		}

		seenVictims.add(el);
		findings.push({
			id: "text-occlusion",
			snippet: `${classSelector(el)} is an inline element whose opaque fill leaks ${Math.round(rect.height)}px past its line${overlaps ? ` onto ${classSelector(overlaps)}` : ""}`,
		});
	}

	void scrollY;
	return findings;
}

/**
 * Cards flush against a horizontal scroller's edge at rest while keeping a gutter on
 * the other side. The canonical bug is a first snap panel sized wider than the
 * scroller, cutting its cards' rounded corners while siblings keep their inset. A card
 * that extends far past the edge is a deliberate peek and stays exempt.
 */
function checkEdgeFlushCards(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	dom: DomAdapter,
	viewport: OverlapViewport,
): RuleHit[] {
	const findings: RuleHit[] = [];
	const vh = viewport.height || 800;
	const scrollY = viewport.scrollY ?? 0;
	const isScroller = (s: CssStyle) => /(auto|scroll)/.test(s.overflowX || "") || /(auto|scroll)/.test(s.overflow || "");

	for (const scroller of Array.from(doc.querySelectorAll("*"))) {
		const style = dom.getComputedStyle(scroller);
		if (!isScroller(style)) continue;

		const metrics = scroller as unknown as { scrollWidth?: number; clientWidth?: number; scrollLeft?: number; clientLeft?: number };
		if ((metrics.scrollWidth ?? 0) <= (metrics.clientWidth ?? 0) + 8) continue;
		// At rest only: a scrolled or snapped-forward scroller legitimately shows cut
		// cards at both edges.
		if ((metrics.scrollLeft ?? 0) > 4) continue;

		const scRect = rectOf(scroller);
		if (scRect.width < 120 || scRect.height < 60) continue;
		// Landing-region gate: the defect matters where the page opens.
		if (scRect.top + scrollY > 2 * vh) continue;

		const contentLeft = scRect.left + (metrics.clientLeft ?? 0);
		const contentRight = contentLeft + (metrics.clientWidth ?? 0);

		const flush: Array<{ card: DomElement; edge: "left" | "right"; gap: number }> = [];
		for (const card of Array.from(scroller.querySelectorAll?.("*") ?? [])) {
			if (!isRenderedForBrowserRule(card, dom)) continue;
			// Attribute cards to their nearest scroller only.
			let owner: DomElement | null = card.parentElement;
			while (owner && owner !== scroller && !isScroller(dom.getComputedStyle(owner))) owner = owner.parentElement;
			if (owner !== scroller) continue;

			const cs = dom.getComputedStyle(card);
			const rect = rectOf(card);
			if (rect.width < 80 || rect.height < 40) continue;

			const bg = parseAnyColor(cs.backgroundColor || "");
			const hasBg = !!bg && bg.a > 0.5;
			const borderSides = ["Top", "Right", "Bottom", "Left"].filter((side) => (parseFloat(cs[`border${side}Width`] ?? "") || 0) > 0).length;
			if (!hasBg && borderSides < 2) continue;

			const leftGutter = rect.left - contentLeft;
			const rightGap = contentRight - rect.right;
			// The -24 floor keeps deliberately peeking next-cards exempt.
			const flushRight = leftGutter >= 6 && rightGap < 8 && rightGap > -24;
			const flushLeft = rightGap >= 6 && leftGutter < 8 && leftGutter > -24;
			if (!flushRight && !flushLeft) continue;
			flush.push({ card, edge: flushRight ? "right" : "left", gap: Math.round(flushRight ? rightGap : leftGutter) });
		}
		if (flush.length === 0) continue;

		const worst = flush.reduce((a, b) => (b.gap < a.gap ? b : a));
		findings.push({
			id: "edge-flush-cards",
			snippet: `${flush.length} card${flush.length === 1 ? "" : "s"} flush against the ${worst.edge} edge of ${classSelector(scroller)} at rest (${worst.gap}px gap, e.g. ${classSelector(worst.card)})`,
		});
	}
	return findings;
}

/**
 * A multi-column composition that opens the page where one column runs far past the
 * fold while its sibling fits inside one viewport. The row stretches to the tall
 * column, so the short one floats in dead space and the fold lands deep inside a
 * section. Single-column pages and full-page heroes are exempt: there is no fitting
 * sibling to contrast against.
 */
function checkFirstViewportColumnOverflow(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	dom: DomAdapter,
	viewport: OverlapViewport,
): RuleHit[] {
	const findings: RuleHit[] = [];
	const vw = viewport.width || 1280;
	const vh = viewport.height || 800;
	const scrollY = viewport.scrollY ?? 0;
	const isMultiCol = (s: CssStyle) => /(^|inline-)(grid|flex)$/.test(String(s.display || ""));

	for (const el of Array.from(doc.querySelectorAll("body *"))) {
		const style = dom.getComputedStyle(el);
		if (!isMultiCol(style)) continue;

		const rect = rectOf(el);
		if (rect.width < 0.5 * vw) continue;

		const pageTop = rect.top + scrollY;
		const pageBottom = pageTop + rect.height;
		// The fold must fall inside this container: it opens within the first viewport
		// and runs past it.
		if (pageTop >= vh * 0.9 || pageBottom <= vh) continue;

		// Direct children that read as side-by-side columns: a real width share, not
		// full-bleed, sharing the container's top row.
		const cols: Array<{ child: DomElement; top: number; contentH: number }> = [];
		for (const child of el.children ?? []) {
			const cs = dom.getComputedStyle(child);
			if (cs.display === "none") continue;
			if (String(cs.position || "") === "absolute" || String(cs.position || "") === "fixed") continue;

			const cr = rectOf(child);
			const wShare = cr.width / rect.width;
			if (wShare < 0.25 || wShare > 0.9) continue;
			if (cr.height < 40) continue;

			// Content extent: how far the child's own content reaches, independent of a
			// stretched row height.
			let contentBottom = cr.top;
			for (const d of Array.from(child.querySelectorAll?.("*") ?? [])) {
				const ds = dom.getComputedStyle(d);
				if (ds.position === "absolute" || ds.position === "fixed") continue;
				if (ds.display === "none" || ds.visibility === "hidden") continue;
				const dr = rectOf(d);
				if (dr.width > 0 && dr.height > 0) contentBottom = Math.max(contentBottom, dr.bottom);
			}
			cols.push({ child, top: cr.top, contentH: contentBottom - cr.top });
		}
		if (cols.length < 2) continue;

		cols.sort((a, b) => b.contentH - a.contentH);
		const tall = cols[0];
		const shortest = cols[cols.length - 1];
		if (Math.abs(tall.top - shortest.top) > 0.25 * vh) continue;
		if (tall.contentH <= vh * 1.4) continue;
		if (shortest.contentH > vh) continue;

		findings.push({
			id: "first-viewport-column-overflow",
			snippet: `${classSelector(el)} opens the page with one column running ${Math.round((tall.contentH / vh) * 100)}% of the viewport tall while a sibling fits in ${Math.round((shortest.contentH / vh) * 100)}% — the fold falls deep inside the section`,
		});
	}
	return findings;
}

export {
	checkEdgeFlushCards,
	checkFirstViewportColumnOverflow,
	checkTextOcclusion,
	elementDirectText,
	isLayeredElement,
	isOpaqueDecoratedBox,
	isPaintedForOcclusion,
	OCCLUSION_TEXT_SKIP_TAGS,
};
