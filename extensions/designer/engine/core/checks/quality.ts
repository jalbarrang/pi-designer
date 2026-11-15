/**
 * Quality rules: line length, cramped padding, flush children, leading, tracking,
 * and text floors. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two checks need layout (line length, cramped padding) and abstain when the
 * engine cannot measure a rect, which is why the caller passes `rect` explicitly
 * instead of the function reaching for one.
 */
import { parseAnyColor } from "../shared/color.ts";
import { resolveLengthPx } from "./lengths.ts";
import type { CssStyle, DomAdapter, DomElement, Rect } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** Tags whose text can be long enough for a line-length judgment. */
const QUALITY_TEXT_TAGS: ReadonlySet<string> = new Set(["p", "li", "td", "th", "dd", "blockquote", "figcaption"]);

/** True when a color value paints nothing: absent, `transparent`, or near-zero alpha. */
function cssColorIsTransparent(value: string | null | undefined): boolean {
	if (!value) return true;
	const str = String(value).trim().toLowerCase();
	if (!str || str === "transparent" || str === "rgba(0, 0, 0, 0)") return true;
	const parsed = parseAnyColor(str);
	if (parsed) return parsed.a <= 0.05;
	return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(str);
}

/** True when two color strings are the same paint within rounding. */
function colorsNearlyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
	const ca = parseAnyColor(a);
	const cb = parseAnyColor(b);
	if (!ca || !cb) return false;
	const alphaDelta = Math.abs(ca.a - cb.a);
	const channelDelta = Math.max(Math.abs(ca.r - cb.r), Math.abs(ca.g - cb.g), Math.abs(ca.b - cb.b));
	return alphaDelta <= 0.03 && channelDelta <= 3;
}

/**
 * True when the element's background reads as a boundary the visitor can see:
 * painted, and not the same paint as its nearest painted ancestor. A card whose
 * background matches the section behind it has no visible boundary.
 */
function hasVisibleBackgroundBoundary(
	style: CssStyle | null | undefined,
	el: DomElement | null | undefined,
	dom: DomAdapter | null | undefined,
): boolean {
	const bg = style?.backgroundColor || "";
	if (cssColorIsTransparent(bg)) return false;

	let parent = el?.parentElement ?? null;
	while (parent) {
		const parentStyle = dom?.getComputedStyle(parent);
		const parentBg = parentStyle?.backgroundColor || "";
		if (!cssColorIsTransparent(parentBg)) return !colorsNearlyMatch(bg, parentBg);
		parent = parent.parentElement;
	}
	return true;
}

const TEXT_EDGE_TAGS: ReadonlySet<string> = new Set([
	"A", "BUTTON", "CODE", "DD", "DT", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "P", "PRE", "SPAN", "TD", "TH",
]);

/** True when the node owns a direct text child with more than four characters. */
function hasMeaningfulDirectText(node: DomElement | null | undefined): boolean {
	if (!node?.childNodes) return false;
	for (const child of node.childNodes) {
		if (child.nodeType === 3 && (child.textContent ?? "").trim().length > 4) return true;
	}
	return false;
}

/** Which sides of `rect` a text-bearing descendant lands flush against, within 4px. */
function textDescendantsFlushSides(el: DomElement, rect: Rect | null): Record<"top" | "right" | "bottom" | "left", boolean> {
	const flush = { top: false, right: false, bottom: false, left: false };
	if (!rect || !el.querySelectorAll) return flush;

	const TEXT_EDGE_THRESHOLD = 4;
	const candidates = el.querySelectorAll("a, button, code, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, li, p, pre, span, td, th");
	for (const node of Array.from(candidates)) {
		if (!TEXT_EDGE_TAGS.has(node.tagName) || !hasMeaningfulDirectText(node)) continue;
		let nodeRect: Rect | null = null;
		try {
			nodeRect = node.getBoundingClientRect?.() ?? null;
		} catch {
			// Layout unavailable for this node: it cannot contribute evidence.
		}
		if (!nodeRect || nodeRect.width <= 0 || nodeRect.height <= 0) continue;
		if (nodeRect.bottom < rect.top || nodeRect.top > rect.bottom || nodeRect.right < rect.left || nodeRect.left > rect.right) continue;
		if (nodeRect.top - rect.top <= TEXT_EDGE_THRESHOLD) flush.top = true;
		if (rect.right - nodeRect.right <= TEXT_EDGE_THRESHOLD) flush.right = true;
		if (rect.bottom - nodeRect.bottom <= TEXT_EDGE_THRESHOLD) flush.bottom = true;
		if (nodeRect.left - rect.left <= TEXT_EDGE_THRESHOLD) flush.left = true;
	}
	return flush;
}

/**
 * Screen-reader-only text is exempt from the tiny-text floors: it is never
 * rendered, so its size is irrelevant. Detects the two standard idioms, a known
 * sr-only class on the element or an ancestor, and the clip / 1px-box pattern.
 */
const SR_ONLY_SELECTOR =
	'.sr-only, .visually-hidden, .visuallyhidden, .screen-reader, .screen-reader-only, .screenreader, .a11y-hidden, .hidden-visually, [class*="sr-only" i], [class*="visually-hidden" i], [class*="visuallyhidden" i], [class*="screen-reader" i], [class*="screenreader" i]';

function isVisuallyHidden(el: DomElement, style: CssStyle): boolean {
	if (el.closest?.(SR_ONLY_SELECTOR)) return true;
	const pos = style.position || "";
	if (pos === "absolute" || pos === "fixed") {
		const clip = style.clip || "";
		const clipPath = style.clipPath || style.webkitClipPath || "";
		if (/rect\(\s*0/.test(clip) || /inset\(\s*(?:50%|99|100%)/.test(clipPath)) return true;
		const w = parseFloat(style.width ?? "");
		const h = parseFloat(style.height ?? "");
		const overflow = style.overflow || "";
		if ((w === 1 || h === 1) && (overflow === "hidden" || overflow === "clip")) return true;
	}
	return false;
}

// Elements whose text is never painted: document metadata and script/style
// payloads. Their JS, CSS, and JSON-LD text satisfies `hasDirectText`, and on
// sites that set `html { font-size: 62.5% }` their inherited size is 10px, so the
// floors flag them as tiny body copy even though nothing renders.
const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
	"script", "style", "title", "noscript", "template", "head",
	"meta", "link", "base", "param", "source", "track", "datalist",
	"col", "colgroup", "map", "area",
]);

/** True when the element's text never reaches the screen, by tag or by cascade. */
function isNonRenderedText(el: DomElement | null | undefined, tag: string, style: CssStyle | null | undefined): boolean {
	if (NON_RENDERED_TAGS.has((tag || "").toLowerCase())) return true;
	// Descendants of <head> never render even when the tag itself would.
	if (el?.closest?.("head")) return true;
	if (style) {
		if (style.display === "none") return true;
		const vis = style.visibility;
		if (vis === "hidden" || vis === "collapse") return true;
	}
	return false;
}

export interface QualityOptions {
	readonly el: DomElement;
	readonly tag: string;
	readonly style: CssStyle;
	readonly hasDirectText: boolean;
	readonly textLen: number;
	readonly fontSize: number;
	readonly lineHeightPx: number | null;
	readonly letterSpacingPx: number | null;
	/** Null when the engine cannot lay out, which skips the two rect-dependent rules. */
	readonly rect?: Rect | null;
	readonly lineMax?: number;
	readonly viewportWidth?: number;
	/** Style source for ancestors and children; null abstains from the boundary gates. */
	readonly dom?: DomAdapter | null;
}

/**
 * The quality checks for one element: a buried raster, line length, padding,
 * children flush against a boundary, text bleeding to the viewport edge, leading,
 * justification, tiny text, undersized functional text, all-caps body, and
 * tracking in both directions.
 *
 * Upstream's browser-extension hosts inject their own elements at near-zero
 * opacity; those ids are skipped before any finding is produced.
 */
function checkQuality(opts: QualityOptions): RuleHit[] {
	const {
		el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx,
		rect, lineMax = 80, viewportWidth = 0, dom = null,
	} = opts;
	const findings: RuleHit[] = [];

	// A raster at near-zero opacity never reaches the screen: the produced
	// material ships as a compliance token. The CSS text scan catches the
	// stylesheet form; this catches computed opacity on the element itself.
	const elId = typeof (el as { id?: unknown }).id === "string" ? ((el as { id: string }).id) : el.getAttribute?.("id") || "";
	if (elId.startsWith("claude-") || elId.startsWith("cic-")) return findings;

	{
		const op = parseFloat(style.opacity ?? "");
		if (Number.isFinite(op) && op < 0.15 && op >= 0) {
			const bg = String(style.backgroundImage || "");
			if (tag === "img" || /url\(/i.test(bg)) {
				const label = tag === "img" ? el.getAttribute?.("alt") || "" : (el.textContent || "").trim().slice(0, 40);
				findings.push({
					id: "buried-raster",
					snippet: `${tag === "img" ? "<img>" : "raster background"} at opacity ${op}${label ? ` "${label}"` : ""}`,
				});
			}
		}
	}

	// --- Line length too long (needs a rect) ---
	if (rect && hasDirectText && QUALITY_TEXT_TAGS.has(tag) && rect.width > 0 && textLen > lineMax) {
		const charsPerLine = rect.width / (fontSize * 0.5);
		if (charsPerLine > lineMax + 5) {
			findings.push({ id: "line-length", snippet: `~${Math.round(charsPerLine)} chars/line (aim for <${lineMax})` });
		}
	}

	// --- Cramped padding (needs a rect to skip badges and labels) ---
	// Vertical and horizontal thresholds differ because line-height already gives
	// text vertical breathing room, while horizontal has no equivalent. Both scale
	// with font size: bigger text demands proportionally more padding.
	const isInlineCode = tag === "code" && !el.closest?.("pre");
	if (!isInlineCode && rect && hasDirectText && textLen > 20 && rect.width > 100 && rect.height > 30) {
		const borders = {
			top: parseFloat(style.borderTopWidth ?? "") || 0,
			right: parseFloat(style.borderRightWidth ?? "") || 0,
			bottom: parseFloat(style.borderBottomWidth ?? "") || 0,
			left: parseFloat(style.borderLeftWidth ?? "") || 0,
		};
		const borderCount = Object.values(borders).filter((w) => w > 0).length;
		const hasBg = hasVisibleBackgroundBoundary(style, el, dom);
		if (borderCount >= 2 || hasBg) {
			const vPads: number[] = [];
			const hPads: number[] = [];
			if (hasBg || borders.top > 0) vPads.push(parseFloat(style.paddingTop ?? "") || 0);
			if (hasBg || borders.bottom > 0) vPads.push(parseFloat(style.paddingBottom ?? "") || 0);
			if (hasBg || borders.left > 0) hPads.push(parseFloat(style.paddingLeft ?? "") || 0);
			if (hasBg || borders.right > 0) hPads.push(parseFloat(style.paddingRight ?? "") || 0);

			const vMin = vPads.length > 0 ? Math.min(...vPads) : Number.POSITIVE_INFINITY;
			const hMin = hPads.length > 0 ? Math.min(...hPads) : Number.POSITIVE_INFINITY;
			const vThresh = Math.max(4, fontSize * 0.3);
			const hThresh = Math.max(8, fontSize * 0.5);

			// At most one finding per element: whichever axis is worse.
			if (vMin < vThresh) {
				findings.push({ id: "cramped-padding", snippet: `${vMin}px vertical padding (need ≥${vThresh.toFixed(1)}px for ${fontSize}px text)` });
			} else if (hMin < hThresh) {
				findings.push({ id: "cramped-padding", snippet: `${hMin}px horizontal padding (need ≥${hThresh.toFixed(1)}px for ${fontSize}px text)` });
			}
		}
	}

	// --- Flush against a visible boundary ---
	// The opposite shape from cramped-padding: a container with NO direct text,
	// only children, bounded and with near-zero padding on the bounded sides. The
	// classic failure is `padding: 28px 0 0` on a bordered section, which zeroes
	// horizontal padding so text children touch the side borders.
	{
		const FLUSH_SKIP_TAGS: ReadonlySet<string> = new Set([
			"HTML", "BODY", "MAIN", "HEADER", "FOOTER", "NAV", "ARTICLE", "ASIDE", "BUTTON", "A", "LABEL", "SUMMARY",
			"CODE", "PRE", "INPUT", "TEXTAREA", "SELECT", "FORM", "FIGURE", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH",
		]);
		const upperTag = tag ? tag.toUpperCase() : "";
		const elPosition = style.position || "";
		if (!FLUSH_SKIP_TAGS.has(upperTag) && !hasDirectText && !["fixed", "absolute"].includes(elPosition) && (el.children?.length ?? 0) > 0) {
			const borderW = {
				top: parseFloat(style.borderTopWidth ?? "") || 0,
				right: parseFloat(style.borderRightWidth ?? "") || 0,
				bottom: parseFloat(style.borderBottomWidth ?? "") || 0,
				left: parseFloat(style.borderLeftWidth ?? "") || 0,
			};
			const borderVisible = {
				top: borderW.top > 0 && !cssColorIsTransparent(style.borderTopColor),
				right: borderW.right > 0 && !cssColorIsTransparent(style.borderRightColor),
				bottom: borderW.bottom > 0 && !cssColorIsTransparent(style.borderBottomColor),
				left: borderW.left > 0 && !cssColorIsTransparent(style.borderLeftColor),
			};

			// Some engines do not decompose the `outline` shorthand, so parse it when
			// the longhands come back empty.
			let outlineW = parseFloat(style.outlineWidth ?? "") || 0;
			let outlineStyleVal = style.outlineStyle || "";
			let outlineColorVal = style.outlineColor || "";
			if (!outlineW && style.outline) {
				const wMatch = style.outline.match(/(\d+(?:\.\d+)?)\s*px/);
				if (wMatch) outlineW = parseFloat(wMatch[1]) || 0;
				if (!outlineStyleVal) {
					outlineStyleVal = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(style.outline) ? "solid" : "";
				}
				if (!outlineColorVal) {
					const cMatch = style.outline.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*$/);
					if (cMatch) outlineColorVal = cMatch[1];
				}
			}
			const outlineVisible = outlineW > 0 && !cssColorIsTransparent(outlineColorVal) && !!outlineStyleVal && outlineStyleVal !== "none";
			const bgVisible = hasVisibleBackgroundBoundary(style, el, dom);

			const anyVisible =
				borderVisible.top || borderVisible.right || borderVisible.bottom || borderVisible.left || outlineVisible || bgVisible;
			if (anyVisible) {
				// Padding resolves to px: some engines return raw `1.5rem`, and parseFloat
				// would read that as 1.5px and false-flag a legitimate inset.
				const pad = {
					top: resolveLengthPx(style.paddingTop, fontSize) ?? 0,
					right: resolveLengthPx(style.paddingRight, fontSize) ?? 0,
					bottom: resolveLengthPx(style.paddingBottom, fontSize) ?? 0,
					left: resolveLengthPx(style.paddingLeft, fontSize) ?? 0,
				};
				const PAD_THRESHOLD = 2;

				// A side is insulated when any direct child has its own padding or
				// margin of 4px or more there: in normal flow only the edge children
				// touch the parent's edges, so one padded child breaks the flush. The
				// heuristic accepts a few false negatives for far fewer false positives.
				const CHILD_INSULATE_THRESHOLD = 4;
				const childrenInsulate = { top: false, right: false, bottom: false, left: false };
				for (const child of el.children ?? []) {
					const childStyle = dom?.getComputedStyle(child);
					if (!childStyle) continue;
					const childPad = {
						top: resolveLengthPx(childStyle.paddingTop, fontSize) ?? 0,
						right: resolveLengthPx(childStyle.paddingRight, fontSize) ?? 0,
						bottom: resolveLengthPx(childStyle.paddingBottom, fontSize) ?? 0,
						left: resolveLengthPx(childStyle.paddingLeft, fontSize) ?? 0,
					};
					const childMargin = {
						top: resolveLengthPx(childStyle.marginTop, fontSize) ?? 0,
						right: resolveLengthPx(childStyle.marginRight, fontSize) ?? 0,
						bottom: resolveLengthPx(childStyle.marginBottom, fontSize) ?? 0,
						left: resolveLengthPx(childStyle.marginLeft, fontSize) ?? 0,
					};
					if (rect) {
						try {
							const childRect = child.getBoundingClientRect?.();
							if (childRect && childRect.width > 0 && childRect.height > 0) {
								if (childRect.top - rect.top >= CHILD_INSULATE_THRESHOLD) childrenInsulate.top = true;
								if (rect.right - childRect.right >= CHILD_INSULATE_THRESHOLD) childrenInsulate.right = true;
								if (rect.bottom - childRect.bottom >= CHILD_INSULATE_THRESHOLD) childrenInsulate.bottom = true;
								if (childRect.left - rect.left >= CHILD_INSULATE_THRESHOLD) childrenInsulate.left = true;
							}
						} catch {
							// Layout unavailable: fall back to the padding and margin reads below.
						}
					}
					for (const side of ["top", "right", "bottom", "left"] as const) {
						if (childPad[side] >= CHILD_INSULATE_THRESHOLD || childMargin[side] >= CHILD_INSULATE_THRESHOLD) {
							childrenInsulate[side] = true;
						}
					}
				}

				const textFlush = rect ? textDescendantsFlushSides(el, rect) : null;
				const fullBleedBgBand = !!rect && viewportWidth > 0 && rect.width >= viewportWidth * 0.94 && bgVisible && !outlineVisible;
				const flushSides: string[] = [];
				for (const side of ["top", "right", "bottom", "left"] as const) {
					const bgBoundsSide = bgVisible && !(fullBleedBgBand && (side === "left" || side === "right"));
					const sideBounded = borderVisible[side] || outlineVisible || bgBoundsSide;
					if (sideBounded && pad[side] <= PAD_THRESHOLD && !childrenInsulate[side] && (!textFlush || textFlush[side])) {
						flushSides.push(side);
					}
				}

				if (flushSides.length > 0) {
					// Confirm a direct child carries substantial text; otherwise the flush
					// is harmless, as in an image-only card.
					let hasTextChild = false;
					for (const child of el.children ?? []) {
						if ((child.textContent || "").trim().length > 4) {
							hasTextChild = true;
							break;
						}
					}
					if (hasTextChild) {
						const cls = typeof el.className === "string" && el.className.trim() ? el.className.trim().split(/\s+/)[0] : "";
						const boundaryParts: string[] = [];
						const borderSidesVisible = (["top", "right", "bottom", "left"] as const).filter((s) => borderVisible[s]);
						if (borderSidesVisible.length === 4) boundaryParts.push("border");
						else if (borderSidesVisible.length > 0) boundaryParts.push(`border-${borderSidesVisible.join("/")}`);
						if (outlineVisible) boundaryParts.push("outline");
						if (bgVisible) boundaryParts.push("bg");
						const sidesLabel = flushSides.length === 4 ? "all sides" : flushSides.join("/");
						const ident = cls ? `<${tag.toLowerCase()}> "${cls}"` : `<${tag.toLowerCase()}>`;
						findings.push({
							id: "cramped-padding",
							snippet: `${ident}: children flush against ${boundaryParts.join("+")} on ${sidesLabel} (no inset)`,
						});
					}
				}
			}
		}
	}

	// --- Body text touching the viewport edge (needs a rect) ---
	// The failure where body paragraphs ship with no container padding at all, so
	// text bleeds to the edge. Gated hard: paragraph-ish only, more than half the
	// viewport wide, actually touching, not in nav or header, and not a full-bleed
	// section that provides its own inset.
	if (rect && hasDirectText && textLen > 40 && ["P", "LI"].includes(tag.toUpperCase()) && viewportWidth > 0) {
		const inNavHeader = el.closest?.("nav") || el.closest?.("header");
		const hasOwnBg = !!style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
		const isPositioned = ["fixed", "absolute"].includes(style.position || "");
		const widthRatio = rect.width / viewportWidth;
		const leftClose = rect.left < 16;
		const rightClose = rect.right > viewportWidth - 16;
		if (!inNavHeader && !hasOwnBg && !isPositioned && widthRatio > 0.5 && (leftClose || rightClose)) {
			const which =
				leftClose && rightClose
					? `left ${Math.round(rect.left)}px / right ${Math.round(viewportWidth - rect.right)}px`
					: leftClose
						? `left ${Math.round(rect.left)}px`
						: `right ${Math.round(viewportWidth - rect.right)}px`;
			findings.push({
				id: "body-text-viewport-edge",
				snippet: `<${tag.toLowerCase()}> with ${textLen}-char body bleeds to viewport edge (${which})`,
			});
		}
	}

	// --- Tight line height ---
	if (hasDirectText && textLen > 50 && !["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
		if (lineHeightPx != null && fontSize > 0) {
			const ratio = lineHeightPx / fontSize;
			if (ratio > 0 && ratio < 1.3) {
				findings.push({ id: "tight-leading", snippet: `line-height ${ratio.toFixed(2)}x (need >=1.3)` });
			}
		}
	}

	// --- Justified text without hyphenation ---
	if (hasDirectText && style.textAlign === "justify") {
		const hyphens = style.hyphens || style.webkitHyphens || "";
		if (hyphens !== "auto") {
			findings.push({ id: "justified-text", snippet: "text-align: justify without hyphens: auto" });
		}
	}

	// --- Tiny body text ---
	// Body content only: UI labels, badges, captions, footer text, and code are
	// furniture, and `undersized-ui-text` below owns them.
	if (hasDirectText && textLen > 20 && fontSize < 12) {
		const skipTags = ["sub", "sup", "code", "kbd", "samp", "var", "caption", "figcaption"];
		const inUIContext = el.closest?.(
			'button, a, label, summary, pre, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], nav, footer, [aria-hidden="true"], [class*="badge" i], [class*="caption" i], [class*="chip" i], [class*="code" i], [class*="console" i], [class*="diff" i], [class*="label" i], [class*="meta" i], [class*="mock" i], [class*="pill" i], [class*="preview" i], [class*="tag" i], [class*="terminal" i], [class*="writes" i]',
		);
		const isUppercase = style.textTransform === "uppercase";
		if (!skipTags.includes(tag) && !inUIContext && !isUppercase && !isNonRenderedText(el, tag, style)) {
			findings.push({ id: "tiny-text", snippet: `${fontSize}px body text` });
		}
	}

	// --- Undersized functional text ---
	// The complement of tiny-text: nav items, buttons, labels, cells, meta rows, and
	// timecodes under an 11px floor (10px for non-interactive smallprint). Being on
	// a DESIGN.md size ramp is not a legibility argument, so the design system is
	// deliberately ignored here.
	{
		const direct = (el.childNodes ?? [])
			.filter((n) => n.nodeType === 3)
			.map((n) => n.textContent ?? "")
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		const dtLen = direct.length;
		const UI_SKIP_TAGS: ReadonlySet<string> = new Set(["sub", "sup", "option"]);

		if (fontSize > 0 && fontSize < 11 && dtLen >= 2 && !UI_SKIP_TAGS.has(tag) && !isNonRenderedText(el, tag, style)) {
			const EXEMPT_CONTEXT =
				'pre, code, kbd, samp, var, svg, [aria-hidden="true"], [class*="terminal" i], [class*="console" i], [class*="code" i], [class*="mock" i], [class*="editor" i], [class*="syntax" i], [class*="diff" i]';
			const isExemptContext = !!el.closest?.(EXEMPT_CONTEXT);
			if (!isExemptContext && !isVisuallyHidden(el, style)) {
				const INTERACTIVE =
					'a[href], button, summary, label, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="treeitem"], [tabindex]';
				const FURNITURE =
					'nav, [role="navigation"], td, th, [role="gridcell"], [role="cell"], caption, figcaption, dt, dd, footer, [class*="meta" i], [class*="label" i], [class*="badge" i], [class*="chip" i], [class*="pill" i], [class*="tag" i], [class*="kicker" i], [class*="eyebrow" i], [class*="breadcrumb" i], [class*="timestamp" i], [class*="category" i], [class*="caption" i], [class*="nav" i]';
				const SMALLPRINT =
					'small, footer, [class*="legal" i], [class*="copyright" i], [class*="fineprint" i], [class*="fine-print" i], [class*="smallprint" i], [class*="small-print" i], [class*="disclaimer" i], [class*="disclosure" i], [class*="footnote" i]';

				const isInteractive = !!el.closest?.(INTERACTIVE);
				const isFurniture = !!el.closest?.(FURNITURE);
				const isSmallprint = !!el.closest?.(SMALLPRINT);
				const floor = !isInteractive && isSmallprint ? 10 : 11;

				// Functional text only: interactive, structural furniture, or any short
				// run. Long non-furniture copy stays with tiny-text, so the two rules never
				// double-flag one element.
				if (fontSize < floor && (isInteractive || isFurniture || dtLen <= 20)) {
					findings.push({
						id: "undersized-ui-text",
						snippet: `${fontSize}px functional text "${direct.slice(0, 40)}" (below ${floor}px floor)`,
					});
				}
			}
		}
	}

	// --- All-caps body text ---
	if (hasDirectText && textLen > 30 && style.textTransform === "uppercase") {
		if (!["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
			findings.push({ id: "all-caps-body", snippet: `text-transform: uppercase on ${textLen} chars of body text` });
		}
	}

	// --- Wide letter spacing on body text ---
	if (hasDirectText && textLen > 20 && style.textTransform !== "uppercase") {
		if (letterSpacingPx != null && letterSpacingPx > 0 && fontSize > 0) {
			const trackingEm = letterSpacingPx / fontSize;
			if (trackingEm > 0.05) {
				findings.push({ id: "wide-tracking", snippet: `letter-spacing: ${trackingEm.toFixed(2)}em on body text` });
			}
		}
	}

	// --- Crushed letter spacing, the mirror of wide-tracking ---
	// Below about -0.05em characters collide. Optical tightening that display type
	// wants sits around -0.02em, well above the floor.
	if (hasDirectText && textLen > 20 && fontSize > 0) {
		if (letterSpacingPx != null && letterSpacingPx < 0) {
			const trackingEm = letterSpacingPx / fontSize;
			if (trackingEm <= -0.05) {
				const excerpt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
				findings.push({ id: "extreme-negative-tracking", snippet: `letter-spacing: ${trackingEm.toFixed(2)}em — "${excerpt}"` });
			}
		}
	}

	return findings;
}

/**
 * Quality findings for one element from a live DOM. Every computed length is
 * already in pixels here, so the values go straight in.
 */
function checkElementQualityDOM(el: DomElement, dom: DomAdapter, viewportWidth = 0, lineMax = 80): RuleHit[] {
	const tag = el.tagName.toLowerCase();
	const style = dom.getComputedStyle(el);
	const hasDirectText = (el.childNodes ?? []).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 10);
	const textLen = el.textContent?.trim().length ?? 0;
	const fontSize = parseFloat(style.fontSize ?? "") || 16;

	return checkQuality({
		el,
		tag,
		style,
		hasDirectText,
		textLen,
		fontSize,
		lineHeightPx: resolveLengthPx(style.lineHeight, fontSize),
		letterSpacingPx: resolveLengthPx(style.letterSpacing, fontSize),
		rect: el.getBoundingClientRect?.() ?? null,
		lineMax,
		viewportWidth,
		dom,
	});
}

/**
 * Skipped-heading walk: a jump from h2 to h4 loses a level, which is a structure
 * bug the visual review cannot see.
 */
function checkPageQualityFromDoc(doc: { querySelectorAll(selector: string): ArrayLike<DomElement> }): RuleHit[] {
	const findings: RuleHit[] = [];
	const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
	let prevLevel = 0;
	let prevText = "";
	for (const h of Array.from(headings)) {
		const level = parseInt(h.tagName[1], 10);
		const text = (h.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
		if (prevLevel > 0 && level > prevLevel + 1) {
			findings.push({
				id: "skipped-heading",
				snippet: `<h${prevLevel}> "${prevText}" followed by <h${level}> "${text}" (missing h${prevLevel + 1})`,
			});
		}
		prevLevel = level;
		prevText = text;
	}
	return findings;
}

export {
	checkElementQualityDOM,
	checkPageQualityFromDoc,
	checkQuality,
	colorsNearlyMatch,
	cssColorIsTransparent,
	hasMeaningfulDirectText,
	hasVisibleBackgroundBoundary,
	isNonRenderedText,
	isVisuallyHidden,
	NON_RENDERED_TAGS,
	QUALITY_TEXT_TAGS,
	SR_ONLY_SELECTOR,
	TEXT_EDGE_TAGS,
	textDescendantsFlushSides,
};
