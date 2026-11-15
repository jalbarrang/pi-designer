/**
 * The DOM surface the element checks need.
 *
 * Upstream's checks call `getComputedStyle`, `el.closest`, and layout metrics
 * directly, because they only ever ran inside a browser. pi runs the same checks
 * over two different DOMs — a live page through its browser tooling, and a parsed
 * document for file scans — so the shape is an interface the engine takes, not an
 * ambient global it assumes.
 */

/** A text node's content, as far as the checks care. */
export interface DomTextNode {
	readonly nodeType: number;
	readonly textContent: string | null;
}

/** The box model metrics a check reads. */
export interface Rect {
	readonly width: number;
	readonly height: number;
	readonly top: number;
	readonly bottom: number;
	readonly left: number;
	readonly right: number;
}

/**
 * The element properties the checks read. Everything beyond identity, children,
 * and attributes is optional, so a parser that cannot answer (no layout, no
 * selector engine) degrades to the same abstention the checks already use when a
 * value is missing.
 */
export interface DomElement {
	readonly nodeType: number;
	readonly tagName: string;
	readonly parentElement: DomElement | null;
	readonly previousElementSibling?: DomElement | null;
	readonly nextElementSibling?: DomElement | null;
	readonly childNodes?: readonly DomTextNode[];
	readonly children?: readonly DomElement[];
	readonly textContent?: string | null;
	readonly className?: string;
	readonly namespaceURI?: string | null;
	/** Present on real elements; some hosts shadow it with a named control, so checks read it defensively. */
	readonly id?: unknown;
	getAttribute?(name: string): string | null;
	closest?(selector: string): DomElement | null;
	matches?(selector: string): boolean;
	querySelector?(selector: string): DomElement | null;
	querySelectorAll?(selector: string): ArrayLike<DomElement>;
	contains?(other: DomElement): boolean;
	getBoundingClientRect?(): Rect;
}

/**
 * A computed style. CSS computed values are all strings, so this is a string map:
 * the property names a check reads are documented here, and the index signature is
 * what keeps a new rule from needing a type edit for every property it touches.
 *
 * Read (by the checks in `core/checks`): backgroundColor, backgroundImage, color,
 * borderRadius, border{Top,Right,Bottom,Left}{Width,Color}, outline,
 * outline{Width,Style,Color}, padding{Top,Right,Bottom,Left},
 * margin{Top,Right,Bottom,Left}, fontSize, fontWeight, fontStyle, fontFamily,
 * fontVariant, fontVariantCaps, lineHeight, letterSpacing, textTransform,
 * textAlign, hyphens, webkitHyphens, visibility, display, opacity, content,
 * contentVisibility, position, width, height, overflow, clip, clipPath,
 * webkitClipPath, boxShadow, textShadow, animationName, transitionProperty,
 * animationTimingFunction, transitionTimingFunction, backgroundClip,
 * webkitBackgroundClip.
 */
export interface CssStyle {
	readonly [property: string]: string | undefined;
}

/** What a checks pass needs from its host DOM. */
export interface DomAdapter {
	getComputedStyle(el: DomElement, pseudo?: "::before" | "::after"): CssStyle;
}
