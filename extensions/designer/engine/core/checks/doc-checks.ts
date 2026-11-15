/**
 * Style-object element checks: the static-engine twins of the DOM adapters.
 * Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0;
 * see NOTICE).
 *
 * These take a computed style and a pre-resolved value instead of reading the
 * live DOM, which is what lets a parsed document run the same rules. The host
 * object is an adapter, because a parser can expose hover styles and pseudo
 * surfaces where a real browser exposes different APIs.
 */
import {
	compositeColorOver,
	parseAnyColor,
	parseRgb,
	type Color,
} from "../shared/color.ts";
import { isEmojiOnlyText } from "./text.ts";
import { checkBorders, type BorderSide } from "./borders.ts";
import { checkColors, checkHoverContrast, type ScanMode } from "./colors.ts";
import {
	checkHeroEyebrow,
	checkIconTile,
	checkItalicSerif,
	HEADING_TAGS,
	resolveHeroHeadingSizePx,
} from "./typography.ts";
import { checkMotion } from "./motion.ts";
import { checkGlow } from "./css-scan.ts";
import { checkQuality } from "./quality.ts";
import {
	readOwnBackgroundColor,
	resolveBackground,
	resolveBackgroundInfo,
	resolveBorderRadiusPx,
	resolveGradientStops,
	type ElementLike,
	type StyleHost,
} from "./background.ts";
import { parseColorResolved, resolveVarRefs } from "./css-scan.ts";
import { resolveFontSizePx, resolveLengthPx } from "./lengths.ts";
import { isStatusContextElement, isTabContextElement } from "./elements.ts";
import type { CssStyle, DomElement } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** One side's resolved border, used when a parser dropped a `var()` shorthand. */
export interface BorderSideOverride {
	readonly width: number;
	readonly color: string;
}

/** A hover-state style, present only when a `:hover` rule changed the element. */
export interface HoverStyle {
	readonly color?: string;
	readonly backgroundColor?: string;
}

/**
 * What the static checks need from their host. `getComputedStyle` is the only
 * required part; the rest are capabilities the caller may provide, and a check
 * abstains when one is missing rather than guessing.
 */
export interface DocHost extends StyleHost {
	/** The opaque surface a full-cover `::before`/`::after` paints, when the cascade found one. */
	getPseudoSurface?(el: ElementLike): Color | null;
	/** The element's hover style, when a `:hover` rule changed its color or background. */
	getHoverStyle?(el: ElementLike): HoverStyle | null;
	/** True when a short chromatic dash pseudo-element declares on the element. */
	hasAccentDashPseudo?(el: ElementLike): boolean;
}

/** Quality findings for one element, with font sizes resolved through the parent chain. */
function checkElementQualityInDoc(el: DomElement, style: CssStyle, tag: string, host: DocHost, mode: ScanMode = "static"): RuleHit[] {
	const hasDirectText = (el.childNodes ?? []).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 10);
	const textLen = el.textContent?.trim().length ?? 0;
	const fontSize = resolveFontSizePx(el, (node) => host.getComputedStyle(node));
	const lineHeightPx = resolveLengthPx(style.lineHeight, fontSize);
	const letterSpacingPx = resolveLengthPx(style.letterSpacing, fontSize);
	return checkQuality({
		el,
		tag,
		style,
		hasDirectText,
		textLen,
		fontSize,
		lineHeightPx,
		letterSpacingPx,
		rect: null,
		dom: { getComputedStyle: (node) => host.getComputedStyle(node) },
	});
}

/**
 * The border tell from a parsed style. `overrides` fills in sides whose
 * shorthand carried a `var()`, which some parsers drop entirely, and
 * `resolvedRadius` carries a radius resolved before the parser lost the
 * shorthand.
 */
function checkElementBordersInDoc(
	tag: string,
	style: CssStyle,
	overrides: Readonly<Partial<Record<BorderSide, BorderSideOverride>>> | null,
	resolvedRadius: number | null,
	el: ElementLike | null = null,
): RuleHit[] {
	const widths = {} as Record<BorderSide, number>;
	const colors = {} as Record<BorderSide, string>;
	for (const side of ["Top", "Right", "Bottom", "Left"] as BorderSide[]) {
		widths[side] = parseFloat(style[`border${side}Width`] ?? "") || 0;
		colors[side] = style[`border${side}Color`] ?? "";
		const override = overrides?.[side];
		if (widths[side] === 0 && override) {
			widths[side] = override.width;
			colors[side] = override.color;
		} else if (colors[side] && colors[side].startsWith("var(") && override) {
			// Longhand case: the width survived and the color stayed a literal `var()`.
			colors[side] = override.color;
		}
	}
	const radius = resolvedRadius ?? (parseFloat(style.borderRadius ?? "") || 0);
	const ownBg = parseAnyColor(style.backgroundColor);
	return checkBorders(tag, widths, colors, radius, {
		tabContext: isTabContextElement(el as DomElement | null),
		statusContext: isStatusContextElement(el as DomElement | null),
		badgeLike: !!(ownBg && ownBg.a > 0.1),
	});
}

/**
 * Contrast and palette findings from a parsed style.
 *
 * `hasAnchorInheritRule` exists for one parser bug: a user-agent stylesheet can
 * have `:link { color: blue }` at high specificity, so the page's
 * `a { color: inherit }` loses there even though it wins in a browser (which
 * wraps the UA rule in zero-specificity `:where()`). When the page declares the
 * inherit rule and the link blue shows up, the nearest non-anchor ancestor's color
 * is the truth.
 */
function checkElementColorsInDoc(
	el: DomElement,
	style: CssStyle,
	tag: string,
	host: DocHost,
	customPropMap: Map<string, string> | null,
	hasAnchorInheritRule: boolean,
	mode: ScanMode = "static",
): RuleHit[] {
	if (style.visibility === "hidden") return [];

	// Opacity does not inherit, so multiply the declared values down the chain.
	let effOpacity = 1;
	for (let cur: DomElement | null = el; cur && cur.nodeType === 1 && effOpacity > 0.02; cur = cur.parentElement) {
		effOpacity *= parseFloat(host.getComputedStyle(cur).opacity || "1");
	}
	if (effOpacity <= 0.02) return [];

	const direct = (el.childNodes ?? [])
		.filter((n) => n.nodeType === 3)
		.map((n) => n.textContent ?? "")
		.join("");
	const hasDirectText = direct.trim().length > 0;

	const bgInfo = resolveBackgroundInfo(el as ElementLike, host, customPropMap, mode);
	const effectiveBg = bgInfo.color;

	// A parser can return literal `var(--X)` or `oklch(…)` for color, so resolve
	// through the map first and fall back to plain rgb parsing.
	let textColor = customPropMap ? parseColorResolved(style.color, customPropMap) : null;
	if (!textColor) textColor = parseRgb(style.color);

	if (hasAnchorInheritRule && textColor && textColor.r === 0 && textColor.g === 0 && textColor.b === 238 && (tag === "a" || el.closest?.("a"))) {
		for (let cur: DomElement | null = el.parentElement; cur && cur.tagName !== "HTML"; cur = cur.parentElement) {
			if (cur.tagName !== "A") {
				const ps = host.getComputedStyle(cur);
				const inherited = (customPropMap ? parseColorResolved(ps.color, customPropMap) : null) ?? parseRgb(ps.color);
				if (inherited && !(inherited.r === 0 && inherited.g === 0 && inherited.b === 238)) {
					textColor = inherited;
					break;
				}
			}
		}
	}

	// Own background: tokens first, then the inline fallback, so a chip whose
	// background is `var(--sev)` still reads as its own surface.
	let ownBg: Color | null = (customPropMap ? parseColorResolved(style.backgroundColor, customPropMap) : null) ?? readOwnBackgroundColor(el as ElementLike, { backgroundColor: style.backgroundColor ?? "" }, mode);

	let finalEffectiveBg = effectiveBg;
	let surfaceUnresolved = bgInfo.unresolved;
	if ((!ownBg || ownBg.a <= 0.5) && typeof host.getPseudoSurface === "function") {
		const pseudoSurface = host.getPseudoSurface(el as ElementLike);
		if (pseudoSurface) {
			ownBg = pseudoSurface;
			finalEffectiveBg = pseudoSurface;
			surfaceUnresolved = false;
		}
	}

	return checkColors({
		tag,
		textColor,
		bgColor: ownBg,
		// Unknown surface: hand the checks nothing rather than a guess.
		effectiveBg: surfaceUnresolved ? null : finalEffectiveBg,
		effectiveBgStops: surfaceUnresolved || finalEffectiveBg ? null : resolveGradientStops(el as ElementLike, host, customPropMap, mode),
		fontSize: parseFloat(style.fontSize ?? "") || 16,
		fontWeight: parseInt(style.fontWeight ?? "", 10) || 400,
		hasDirectText,
		isEmojiOnly: isEmojiOnlyText(direct),
		bgClip: style.webkitBackgroundClip || style.backgroundClip || "",
		bgImage: style.backgroundImage || "",
		classList: el.getAttribute?.("class") || el.className || "",
		mode,
	});
}

/**
 * Hover-state contrast. Needs the host's hover pass: the style is present only
 * when a `:hover` rule changed the element's color or background relative to rest.
 */
function checkElementHoverContrastInDoc(el: DomElement, style: CssStyle, tag: string, host: DocHost): RuleHit[] {
	if (typeof host.getHoverStyle !== "function") return [];
	const hover = host.getHoverStyle(el as ElementLike);
	if (!hover) return [];

	const direct = (el.childNodes ?? [])
		.filter((n) => n.nodeType === 3)
		.map((n) => n.textContent ?? "")
		.join("");
	if (direct.trim().length === 0) return [];

	const textColor = parseAnyColor(hover.color);
	if (!textColor || textColor.a < 1) return [];

	const restingOwnBg = parseAnyColor(style.backgroundColor);
	const hoverOwnBg = parseAnyColor(hover.backgroundColor);
	const ownBg = hoverOwnBg ?? restingOwnBg;

	// The effective hover surface: the element's own hover background composited
	// over whatever sits beneath. A surface that cannot be resolved to a solid
	// color abstains rather than measuring against a guess.
	let bg: Color | null = null;
	if (ownBg && ownBg.a >= 0.99) {
		bg = ownBg;
	} else {
		const under = resolveBackground((el.parentElement || el) as ElementLike, host, null, "static");
		if (!under) return [];
		bg = ownBg && ownBg.a > 0.1 ? compositeColorOver(ownBg, under) : under;
	}

	return checkHoverContrast({
		tag,
		textColor,
		bg,
		ownBgAlpha: ownBg ? ownBg.a : null,
		fontSize: parseFloat(style.fontSize ?? "") || 16,
		fontWeight: parseInt(style.fontWeight ?? "", 10) || 400,
		hasDirectText: true,
		isEmojiOnly: isEmojiOnlyText(direct),
	});
}

/**
 * The icon-tile shape from a parsed style. A parser has no layout, so explicit
 * pixel dimensions come from CSS and the vertical-stacking gate is skipped.
 */
function checkElementIconTileInDoc(el: DomElement, tag: string, host: DocHost): RuleHit[] {
	if (!HEADING_TAGS.has(tag)) return [];
	const sibling = el.previousElementSibling;
	if (!sibling) return [];

	const sibStyle = host.getComputedStyle(sibling);
	const sibWidth = parseFloat(sibStyle.width ?? "") || 0;
	const sibHeight = parseFloat(sibStyle.height ?? "") || 0;

	const iconChild = sibling.querySelector?.('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]') ?? null;
	let iconWidth = 0;
	if (iconChild) {
		const iconStyle = host.getComputedStyle(iconChild);
		iconWidth = parseFloat(iconStyle.width ?? "") || parseFloat(iconChild.getAttribute?.("width") ?? "") || 0;
	}

	const sibDirect = (sibling.childNodes ?? [])
		.filter((n) => n.nodeType === 3)
		.map((n) => n.textContent ?? "")
		.join("");
	const hasInlineEmojiIcon = (sibling.children?.length ?? 0) === 0 && isEmojiOnlyText(sibDirect);

	return checkIconTile({
		headingTag: tag,
		headingText: el.textContent || "",
		headingTop: 0,
		siblingTag: sibling.tagName.toLowerCase(),
		siblingWidth: sibWidth,
		siblingHeight: sibHeight,
		siblingBottom: 0,
		siblingBgColor: parseRgb(sibStyle.backgroundColor),
		siblingBgImage: sibStyle.backgroundImage || "",
		siblingBorderWidth: parseFloat(sibStyle.borderTopWidth ?? "") || 0,
		siblingBorderRadius: resolveBorderRadiusPx(sibStyle, sibWidth),
		hasIconChild: !!iconChild || hasInlineEmojiIcon,
		iconChildWidth: iconWidth,
	});
}

/** The italic-serif hero tell from a parsed style. */
function checkElementItalicSerifInDoc(el: DomElement, style: CssStyle, tag: string): RuleHit[] {
	if (tag !== "h1" && tag !== "h2") return [];
	return checkItalicSerif({
		tag,
		fontStyle: style.fontStyle || "",
		fontFamily: style.fontFamily || "",
		fontSize: parseFloat(style.fontSize ?? "") || 0,
		headingText: el.textContent || "",
	});
}

/**
 * The label-above-headline tell from a parsed style, with Tailwind-style
 * `var(--token)` wrappers resolved before parsing so the gates see real values.
 */
function checkElementHeroEyebrowInDoc(
	el: DomElement,
	style: CssStyle,
	tag: string,
	host: DocHost,
	customPropMap: Map<string, string> | null,
): RuleHit[] {
	if (tag !== "h1") return [];
	const sibling = el.previousElementSibling;
	if (!sibling) return [];

	const sibStyle = host.getComputedStyle(sibling);
	const resolve = (value: string | undefined): string | undefined => (customPropMap ? resolveVarRefs(value ?? "", customPropMap) : value);

	const fontSizeRaw = resolve(sibStyle.fontSize);
	const fontWeightRaw = resolve(sibStyle.fontWeight);
	const letterSpacingRaw = resolve(sibStyle.letterSpacing);
	const colorRaw = resolve(sibStyle.color);
	const headingFontSizeRaw = resolve(style.fontSize);

	const siblingFontSize = parseFloat(fontSizeRaw ?? "") || 0;

	return checkHeroEyebrow({
		headingTag: tag,
		headingText: el.textContent || "",
		headingFontSize: resolveHeroHeadingSizePx(headingFontSizeRaw),
		headingInApplicationContext: !!el.closest?.('[role="tabpanel"], [role="dialog"], [role="application"], dialog'),
		siblingTag: sibling.tagName.toLowerCase(),
		siblingText: sibling.textContent || "",
		siblingTextTransform: sibStyle.textTransform || "",
		siblingFontSize,
		// `normal` and `auto` resolve to null; coerce to zero so the gate falls
		// through cleanly instead of NaN.
		siblingLetterSpacing: resolveLengthPx(letterSpacingRaw, siblingFontSize) || 0,
		siblingFontWeight: fontWeightRaw || "",
		siblingColor: colorRaw || "",
		siblingHasAccentDashPseudo: typeof host.hasAccentDashPseudo === "function" ? host.hasAccentDashPseudo(sibling as ElementLike) : false,
	});
}

/** Motion findings from a parsed style. */
function checkElementMotionInDoc(tag: string, style: CssStyle): RuleHit[] {
	return checkMotion({
		tag,
		transitionProperty: style.transitionProperty || "",
		animationName: style.animationName || "",
		timingFunctions: [style.animationTimingFunction, style.transitionTimingFunction].filter(Boolean).join(" "),
		classList: "",
	});
}

/** Glow findings from a parsed style. */
function checkElementGlowInDoc(tag: string, style: CssStyle, effectiveBg: Color | null): RuleHit[] {
	const boxShadow = style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : "";
	const textShadow = style.textShadow && style.textShadow !== "none" ? style.textShadow : "";
	if (!boxShadow && !textShadow) return [];
	return checkGlow({ boxShadow, textShadow, effectiveBg });
}

export {
	checkElementBordersInDoc,
	checkElementColorsInDoc,
	checkElementGlowInDoc,
	checkElementHeroEyebrowInDoc,
	checkElementHoverContrastInDoc,
	checkElementIconTileInDoc,
	checkElementItalicSerifInDoc,
	checkElementMotionInDoc,
	checkElementQualityInDoc,
};
