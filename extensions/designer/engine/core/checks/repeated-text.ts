/**
 * Repeated container text: the same short string rendered in three or more
 * structurally distinct spots inside one card. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * This is the templated-filler tell: a row of cards whose body copy was generated
 * from one sentence with the nouns swapped. Structural signatures are what make it
 * reliable — parallel repetition shares a path, so three occurrences with three
 * different paths were authored, not templated.
 */
import { parseAnyColor, parseRgb } from "../shared/color.ts";
import { isCardLikeFromProps } from "./colors.ts";
import { classSelector } from "./elements.ts";
import type { CssStyle, DomElement } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

const REPEATED_TEXT_SKIP_SELECTOR = [
	"table",
	"select",
	"datalist",
	"nav",
	"menu",
	'[role="navigation"]',
	'[role="menu"]',
	'[role="menubar"]',
	'[role="listbox"]',
	'[role="grid"]',
	'[role="tablist"]',
	'[role="radiogroup"]',
	'[aria-hidden="true"]',
].join(",");

const REPEATED_TEXT_CONTAINER_TAGS: ReadonlySet<string> = new Set([
	"div", "section", "article", "aside", "main", "figure", "form", "fieldset", "details", "li",
]);

const BORDER_WIDTH_KEYS = {
	Top: "borderTopWidth",
	Right: "borderRightWidth",
	Bottom: "borderBottomWidth",
	Left: "borderLeftWidth",
} as const;

/**
 * A container worth attributing text to: visibly bounded (a border on most sides,
 * or an elevation shadow) and surface-like (a radius or its own background).
 */
function isRepeatedTextContainer(style: CssStyle | null | undefined): boolean {
	if (!style) return false;
	const hasShadow = !!style.boxShadow && style.boxShadow !== "none" && style.boxShadow !== "";
	const borderSides = Object.values(BORDER_WIDTH_KEYS).filter(
		(key) => (parseFloat(style[key] ?? "") || 0) >= 1,
	).length;
	const hasBorder = borderSides >= 3;
	const hasRadius = (parseFloat(style.borderRadius ?? "") || 0) > 0;
	const bg = parseRgb(style.backgroundColor) ?? parseAnyColor(style.backgroundColor);
	const hasBg = !!(bg && bg.a > 0.1);
	return isCardLikeFromProps(hasShadow, hasBorder, hasRadius, hasBg);
}

/** A style reader for one element. */
export type StyleReader = (el: DomElement) => CssStyle;

export interface RepeatedTextOptions {
	/** False for elements that are not rendered; defaults to everything visible. */
	readonly isVisible?: (el: DomElement) => boolean;
}

/**
 * Findings for repeated filler text inside card-like containers: the same string
 * (4–48 characters, with letters) in three or more structurally distinct spots.
 */
function collectRepeatedContainerTextFindings(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: StyleReader,
	opts: RepeatedTextOptions = {},
): RuleHit[] {
	const isVisible = opts.isVisible ?? (() => true);
	const findings: RuleHit[] = [];

	const containers: DomElement[] = [];
	const containerSet = new Set<DomElement>();
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		if (!REPEATED_TEXT_CONTAINER_TAGS.has(el.tagName.toLowerCase())) continue;
		if (el.closest?.(REPEATED_TEXT_SKIP_SELECTOR)) continue;
		if (!isRepeatedTextContainer(getStyle(el))) continue;
		containers.push(el);
		containerSet.add(el);
	}

	for (const container of containers) {
		if (!isVisible(container)) continue;
		const descendants = Array.from(container.querySelectorAll?.("*") ?? []);
		// A page-scale wrapper that merely carries a background is not the "one
		// card" this rule reasons about.
		if (descendants.length > 250) continue;

		const groups = new Map<string, string[]>();
		for (const d of descendants) {
			// Attribute text to the innermost container only.
			let ownedByInner = false;
			for (let anc = d.parentElement; anc && anc !== container; anc = anc.parentElement) {
				if (containerSet.has(anc)) {
					ownedByInner = true;
					break;
				}
			}
			if (ownedByInner) continue;
			if (d.closest?.(REPEATED_TEXT_SKIP_SELECTOR)) continue;
			// Icon-font glyph names read as text but render as symbols.
			if (/icon|material-symbols|(?:^|\s)fa[srlbd]?(?:\s|-|$)/i.test(String(d.getAttribute?.("class") || ""))) continue;
			if (!isVisible(d)) continue;

			const direct = (d.childNodes ?? [])
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (direct.length < 4 || direct.length > 48) continue;
			if (!/[a-zA-Z]/.test(direct)) continue;

			// The structural signature is the element path from this occurrence up
			// to the container; parallel repetition shares one signature.
			const sig: string[] = [];
			for (let cur: DomElement | null = d; cur && cur !== container; cur = cur.parentElement) {
				const cls = String(cur.getAttribute?.("class") || "")
					.trim()
					.split(/\s+/)
					.filter(Boolean)
					.sort()
					.join(".");
				sig.push(cur.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
			}
			const existing = groups.get(direct);
			if (existing) existing.push(sig.join(">"));
			else groups.set(direct, [sig.join(">")]);
		}

		for (const [text, sigs] of groups) {
			if (sigs.length < 3) continue;
			if (new Set(sigs).size < 3) continue;
			findings.push({
				id: "repeated-container-text",
				snippet: `"${text.slice(0, 40)}" rendered ${sigs.length}× in distinct spots inside ${classSelector(container)}`,
			});
		}
	}
	return findings;
}

export {
	collectRepeatedContainerTextFindings,
	isRepeatedTextContainer,
	REPEATED_TEXT_CONTAINER_TAGS,
	REPEATED_TEXT_SKIP_SELECTOR,
};
