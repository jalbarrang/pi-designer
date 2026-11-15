/**
 * Label rules: kickers above headings, numbered section labels, and em-dash
 * overuse. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These read a document and a style source, so both are passed in: pi supplies a
 * live DOM or a parsed one, and the engine never reaches for an ambient global.
 */
import { isAccentColor } from "./colors.ts";
import { HEADING_TAGS } from "./typography.ts";
import type { CssStyle, DomAdapter, DomElement } from "../../dom.ts";
import type { RuleHit } from "./rule-hit.ts";

/** A style reader for one element. */
export type StyleReader = (el: DomElement) => CssStyle;

/** A length-to-pixels resolver; `fontSizePx` is the context for em and % values. */
export type LengthResolver = (value: string, fontSizePx: number) => number | null;

/**
 * Areas where a small label above a heading is structure, not decoration:
 * navigation, tables, lists, figures, and breadcrumbs.
 */
const KICKER_SKIP_SELECTOR = [
	"nav",
	"form",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"figure",
	"figcaption",
	"ol",
	"ul",
	"li",
	'[role="navigation"]',
	'[aria-label*="breadcrumb" i]',
	'[class*="breadcrumb" i]',
	'[aria-hidden="true"]',
	"[data-impeccable-allow-kickers]",
].join(",");

/** Card-like contexts, where a label above a heading names the item rather than decorating it. */
const KICKER_CARD_CONTEXT_SELECTOR = ["article", "button", "a", "li", '[role="listitem"]', '[role="option"]'].join(",");

/** The text an element owns directly, whitespace-collapsed. */
function cleanInlineText(el: DomElement): string {
	return (el.childNodes ?? [])
		.filter((n) => n.nodeType === 3)
		.map((n) => n.textContent)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function isKickerCardContext(heading: DomElement, kicker: DomElement): boolean {
	const item = heading.closest?.(KICKER_CARD_CONTEXT_SELECTOR);
	return Boolean(item && (!item.contains || item.contains(kicker)));
}

// Meta lines above headlines join category and date (or path crumbs) with
// separator glyphs, or carry a year. A kicker is one short phrase; metadata keeps
// its markers.
const KICKER_META_TEXT_RE = /[·•|]|\s[/›»>]\s|\b(19|20)\d{2}\b/;

// Legal and document numbering: "Section 4.2", "Article IX", "§ 12.3", dotted
// decimal outlines. The label identifies the clause, so it stays.
const KICKER_DOC_NUMBERING_RE =
	/^(§|\d+(\.\d+)+\b|(section|article|clause|appendix|exhibit|schedule|chapter|part|rule|title)\s+([\divxlc]+\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/i;

export interface KickerCandidateOptions {
	readonly headingLevel: number;
	readonly headingText: string;
	readonly headingFontSize: number;
	readonly kickerTag: string;
	readonly kickerText: string;
	readonly kickerTextTransform?: string;
	readonly kickerFontVariant?: string;
	readonly kickerFontSize: number;
	readonly kickerLetterSpacing: number;
}

/**
 * Does this sibling read as a kicker: a short tracked uppercase micro-label above
 * a heading? Tracking is proportional with no absolute floor, because the common
 * recipe in the wild is 0.08em at a sub-13px size, which computes to under 1px.
 */
function isKickerCandidate(opts: KickerCandidateOptions): boolean {
	const { headingLevel, headingText, headingFontSize, kickerTag, kickerText, kickerTextTransform, kickerFontVariant, kickerFontSize, kickerLetterSpacing } = opts;

	if (!headingLevel || headingLevel > 4) return false;
	if (!headingText || headingText.length < 3) return false;
	if (/^\/[\w-]+/i.test(headingText.replace(/^"|"$/g, "").trim())) return false;
	if (!(headingFontSize >= 20)) return false;
	if (!kickerTag || HEADING_TAGS.has(kickerTag)) return false;
	if (!["p", "span", "div", "small"].includes(kickerTag)) return false;
	if (!kickerText || kickerText.length < 2 || kickerText.length > 34) return false;
	if (/^step\s*\d+/i.test(kickerText) || /^\d{1,2}$/.test(kickerText)) return false;
	if (KICKER_META_TEXT_RE.test(kickerText)) return false;
	if (KICKER_DOC_NUMBERING_RE.test(kickerText)) return false;

	const isSmallCaps = /small-caps/.test(kickerFontVariant || "");
	const isUppercased =
		kickerTextTransform === "uppercase" || (/[A-Z]/.test(kickerText) && !/[a-z]/.test(kickerText)) || isSmallCaps;
	if (!isUppercased) return false;
	if (!(kickerFontSize > 0 && kickerFontSize <= 14)) return false;
	if (!(kickerLetterSpacing >= kickerFontSize * 0.06)) return false;
	return true;
}

/** 1–4 for h1–h4, `aria-level` (default 2) for `role="heading"`, 0 otherwise. */
function kickerHeadingLevel(heading: DomElement): number {
	const tag = heading.tagName.toLowerCase();
	const byTag = /^h([1-6])$/.exec(tag);
	if (byTag) return parseInt(byTag[1], 10);
	const role = heading.getAttribute?.("role") || "";
	if (role.toLowerCase() !== "heading") return 0;
	const ariaLevel = parseInt(heading.getAttribute?.("aria-level") || "", 10);
	return Number.isFinite(ariaLevel) && ariaLevel >= 1 ? ariaLevel : 2;
}

/** A candidate collected from a document, ready for {@link checkKickerAboveHeading}. */
export interface CollectedKicker {
	readonly headingTag: string;
	readonly headingText: string;
	readonly kickerText: string;
}

/**
 * Every kicker candidate in a document. Application contexts (tab panels,
 * dialogs) are exempt for the same reason the hero-eyebrow rule exempts them: a
 * compact state label above a heading describes, not decorates. A tracked-caps
 * label above a hero-scale h1 stands down so `hero-eyebrow-chip` owns that shape
 * and one element gets one finding.
 */
function collectKickerCandidates(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: StyleReader,
	resolveLength: LengthResolver,
): CollectedKicker[] {
	const candidates: CollectedKicker[] = [];

	for (const heading of Array.from(doc.querySelectorAll('h1, h2, h3, h4, [role="heading"]'))) {
		const headingLevel = kickerHeadingLevel(heading);
		if (!headingLevel || headingLevel > 4) continue;
		if (heading.closest?.(KICKER_SKIP_SELECTOR)) continue;
		if (heading.closest?.('[role="tabpanel"], [role="dialog"], [role="application"], dialog')) continue;

		const kicker = heading.previousElementSibling;
		if (!kicker || kicker.closest?.(KICKER_SKIP_SELECTOR)) continue;
		if (isKickerCardContext(heading, kicker)) continue;

		const headingStyle = getStyle(heading);
		const kickerStyle = getStyle(kicker);
		const headingTag = heading.tagName.toLowerCase();
		const headingText = (heading.textContent || "").replace(/\s+/g, " ").trim();
		const kickerText = cleanInlineText(kicker) || (kicker.textContent || "").replace(/\s+/g, " ").trim();
		const headingFontSize = resolveLength(headingStyle.fontSize || "", 16) || parseFloat(headingStyle.fontSize ?? "") || 0;
		const kickerFontSize = resolveLength(kickerStyle.fontSize || "", 16) || parseFloat(kickerStyle.fontSize ?? "") || 0;
		const kickerLetterSpacing = resolveLength(kickerStyle.letterSpacing || "", kickerFontSize) ?? 0;

		const candidate = {
			headingLevel,
			headingText,
			headingFontSize,
			kickerTag: kicker.tagName.toLowerCase(),
			kickerText,
			kickerTextTransform: kickerStyle.textTransform || "",
			kickerFontVariant: `${kickerStyle.fontVariant ?? ""} ${kickerStyle.fontVariantCaps ?? ""}`,
			kickerFontSize,
			kickerLetterSpacing,
		};
		if (!isKickerCandidate(candidate)) continue;

		if (headingTag === "h1" && headingFontSize >= 48 && kickerLetterSpacing >= 1.6) continue;

		candidates.push({
			headingTag,
			headingText: headingText.replace(/^"|"$/g, "").slice(0, 60),
			kickerText: kickerText.slice(0, 40),
		});
	}
	return candidates;
}

/** Kicker findings for a document. */
function checkKickersInDoc(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: StyleReader,
	resolveLength: LengthResolver,
): RuleHit[] {
	const candidates = collectKickerCandidates(doc, getStyle, resolveLength);
	return candidates.map((candidate) => ({
		id: "kicker-above-heading",
		snippet: `kicker "${candidate.kickerText}" above ${candidate.headingTag} "${candidate.headingText}"`,
	}));
}

// ── Numbered section labels ────────────────────────────────────────────────
//
// The sibling of the kicker rule: instead of a tracked uppercase word, the
// section scaffold is a tiny numeric index beside each heading — bare and
// zero-padded, or an index joined to a short micro-label by a separator. The
// kicker rule excludes bare 1–2 digit labels on purpose; this rule owns them.

const NUMBERED_LABEL_TAGS: ReadonlySet<string> = new Set(["span", "p", "div", "small", "em", "strong", "b"]);

/** `{ index, text }` when the text reads as a section index label, else null. */
function parseNumberedLabelText(rawText: string | null | undefined): { index: number; text: string } | null {
	const text = (rawText || "").replace(/\s+/g, " ").trim();
	if (!text || text.length > 40) return null;
	let m = /^(\d{2})$/.exec(text);
	if (!m) m = /^(\d{1,2})\s*[^\w\s]\s*\S/.exec(text);
	if (!m) return null;
	const index = parseInt(m[1], 10);
	if (!Number.isFinite(index) || index > 40) return null;
	return { index, text };
}

export interface NumberedLabelCandidateOptions {
	readonly headingTag: string;
	readonly headingText: string;
	readonly headingFontSize: number;
	readonly labelTag: string;
	readonly labelIndex: number | null;
	readonly labelText: string;
	readonly labelFontSize: number;
	readonly labelLetterSpacing: number;
	readonly labelFontWeight: number | string;
	readonly labelFontFamily?: string;
	readonly labelTextTransform?: string;
	readonly labelColor?: string;
}

/**
 * A numbered section label: a tiny index (13px or less) beside an h2–h4, wearing
 * at least one deliberate micro-label treatment — mono face, bold weight,
 * tracking, uppercase, or accent color. A display-scale section number is a
 * different, deliberate device and stays legal.
 */
function isNumberedSectionLabelCandidate(opts: NumberedLabelCandidateOptions): boolean {
	const { headingTag, headingText, headingFontSize, labelTag, labelIndex, labelText, labelFontSize, labelLetterSpacing, labelFontWeight, labelFontFamily, labelTextTransform, labelColor } = opts;

	if (!["h2", "h3", "h4"].includes(headingTag)) return false;
	if (!headingText || headingText.length < 3) return false;
	if (!labelTag || !NUMBERED_LABEL_TAGS.has(labelTag)) return false;
	if (labelIndex == null || !labelText) return false;
	// Tiny rendered size is the tell.
	if (!(labelFontSize > 0 && labelFontSize <= 13)) return false;
	// The heading must be visibly larger where its size resolves; an unresolvable
	// size (clamp/var in a static engine) leaves the remaining gates to carry it.
	if (headingFontSize > 0 && headingFontSize < labelFontSize * 1.3) return false;

	const weight = Number(labelFontWeight) || 400;
	return (
		/mono/i.test(labelFontFamily || "") ||
		weight >= 600 ||
		(labelLetterSpacing || 0) >= 0.5 ||
		(labelTextTransform || "") === "uppercase" ||
		isAccentColor(labelColor || "")
	);
}

export interface CollectedNumberedLabel {
	readonly index: number;
	readonly labelText: string;
	readonly headingTag: string;
	readonly headingText: string;
}

/**
 * Every numbered-label candidate in a document. The index sits either directly
 * before the heading or before the wrapper the heading leads
 * (`label | <div><h2>…</h2></div>`).
 */
function collectNumberedSectionLabelCandidates(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: StyleReader,
	resolveLength: LengthResolver,
): CollectedNumberedLabel[] {
	const candidates: CollectedNumberedLabel[] = [];
	const seenLabels = new Set<DomElement>();

	for (const heading of Array.from(doc.querySelectorAll("h2, h3, h4"))) {
		if (heading.closest?.(KICKER_SKIP_SELECTOR)) continue;

		let label: DomElement | null = heading.previousElementSibling ?? null;
		if (!label) {
			// The index may sit above the wrapper the heading leads:
			// `label | <div><h2>…</h2>…</div>`.
			const parent = heading.parentElement;
			const firstChild = parent?.children?.[0];
			if (firstChild === heading) label = parent?.previousElementSibling ?? null;
		}
		if (!label || seenLabels.has(label)) continue;
		if (label.closest?.(KICKER_SKIP_SELECTOR)) continue;
		if (HEADING_TAGS.has(label.tagName.toLowerCase())) continue;
		if (isKickerCardContext(heading, label)) continue;

		const labelText = cleanInlineText(label) || (label.textContent || "").replace(/\s+/g, " ").trim();
		const parsed = parseNumberedLabelText(labelText);
		if (!parsed) continue;

		const headingStyle = getStyle(heading);
		const labelStyle = getStyle(label);
		const headingText = (heading.textContent || "").replace(/\s+/g, " ").trim();
		const headingFontSize = resolveLength(headingStyle.fontSize || "", 16) || parseFloat(headingStyle.fontSize ?? "") || 0;
		const labelFontSize = resolveLength(labelStyle.fontSize || "", 16) || parseFloat(labelStyle.fontSize ?? "") || 0;

		const candidate = {
			headingTag: heading.tagName.toLowerCase(),
			headingText,
			headingFontSize,
			labelTag: label.tagName.toLowerCase(),
			labelIndex: parsed.index,
			labelText: parsed.text,
			labelFontSize,
			labelLetterSpacing: resolveLength(labelStyle.letterSpacing || "", labelFontSize) ?? 0,
			labelFontWeight: labelStyle.fontWeight || "",
			labelFontFamily: labelStyle.fontFamily || "",
			labelTextTransform: labelStyle.textTransform || "",
			labelColor: labelStyle.color || "",
		};
		if (!isNumberedSectionLabelCandidate(candidate)) continue;

		seenLabels.add(label);
		candidates.push({
			index: parsed.index,
			labelText: parsed.text.slice(0, 24),
			headingTag: heading.tagName.toLowerCase(),
			headingText: headingText.replace(/^"|"$/g, "").slice(0, 60),
		});
	}
	return candidates;
}

/**
 * The numbered-label finding. One repeated identical number is some other device,
 * and the scaffold counts up, so at least two distinct indices are required.
 */
function checkNumberedSectionLabels(opts: {
	readonly candidates?: readonly CollectedNumberedLabel[] | unknown;
	readonly minCount?: number;
}): RuleHit[] {
	const { candidates, minCount = 2 } = opts;
	if (!Array.isArray(candidates) || candidates.length < minCount) return [];
	const distinctIndices = new Set(candidates.map((c: CollectedNumberedLabel) => c.index));
	if (distinctIndices.size < 2) return [];
	return candidates.map((candidate: CollectedNumberedLabel) => ({
		id: "numbered-section-labels",
		snippet: `tiny numbered label "${candidate.labelText}" beside ${candidate.headingTag} "${candidate.headingText}" (${candidates.length} on page)`,
	}));
}

/** Numbered-label findings for a document. */
function checkNumberedSectionLabelsInDoc(
	doc: { querySelectorAll(selector: string): ArrayLike<DomElement> },
	getStyle: StyleReader,
	resolveLength: LengthResolver,
): RuleHit[] {
	const candidates = collectNumberedSectionLabelCandidates(doc, getStyle, resolveLength);
	return checkNumberedSectionLabels({ candidates });
}

// Em-dash overuse is advisory: two gates (an absolute floor and a density) so a
// long article with a few dashes is left alone while a short, dash-per-clause
// page is flagged. The text is already rendered, so no entity decoding is needed.
const EM_DASH_FLOOR = 8;
const EM_DASH_CHARS_PER_DASH = 500;

/** Em-dash overuse findings for already-rendered text. */
function checkEmDashOveruse(text: string | null | undefined): RuleHit[] {
	const body = typeof text === "string" ? text.replace(/\s+/g, " ") : "";
	let count = 0;
	const re = /[—]|--(?=\S)/g;
	while (re.exec(body) !== null) count++;
	if (count < EM_DASH_FLOOR) return [];
	if (body.length > count * EM_DASH_CHARS_PER_DASH) return [];
	return [{ id: "em-dash-overuse", snippet: `${count} em-dashes in body text` }];
}

/** Em-dash overuse for a document's body text. */
function checkEmDashOveruseInDoc(body: { innerText?: string; textContent?: string | null } | null | undefined): RuleHit[] {
	if (!body) return [];
	const text = typeof body.innerText === "string" && body.innerText ? body.innerText : body.textContent || "";
	return checkEmDashOveruse(text);
}

export {
	checkEmDashOveruse,
	checkEmDashOveruseInDoc,
	checkKickersInDoc,
	checkNumberedSectionLabels,
	checkNumberedSectionLabelsInDoc,
	cleanInlineText,
	collectKickerCandidates,
	collectNumberedSectionLabelCandidates,
	isKickerCandidate,
	isKickerCardContext,
	isNumberedSectionLabelCandidate,
	KICKER_CARD_CONTEXT_SELECTOR,
	KICKER_DOC_NUMBERING_RE,
	KICKER_META_TEXT_RE,
	KICKER_SKIP_SELECTOR,
	kickerHeadingLevel,
	NUMBERED_LABEL_TAGS,
	parseNumberedLabelText,
};
