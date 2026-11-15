/**
 * Typography and heading rules, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */
import { primaryFontFace, GENERIC_FONTS, KNOWN_SERIF_FONTS } from "../shared/constants.ts";
import { isAccentColor } from "./colors.ts";
import type { RuleHit } from "./rule-hit.ts";
import type { Color } from "../shared/color.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** The primary face of a `font-family` stack and whether it reads as serif. */
interface SerifResolution {
	readonly primary: string | null;
	readonly isSerif: boolean;
}

/**
 * Resolve whether a heading's stack is serif. Two paths: the primary face is a
 * known serif, or the primary is unknown but the stack ends in the generic
 * `serif` token. Authors who write `font-family: 'X', serif` almost always have
 * a serif primary; a sans declared with a serif fallback is a code smell, not
 * the common case.
 */
function resolveSerif(fontFamily: string | null | undefined): SerifResolution {
	if (!fontFamily) return { primary: null, isSerif: false };
	const tokens = fontFamily.split(",").map((face) => face.trim().replace(/^['"]|['"]$/g, "").toLowerCase());
	const primary = primaryFontFace(fontFamily, GENERIC_FONTS);
	if (!primary) return { primary: null, isSerif: false };
	if (KNOWN_SERIF_FONTS.has(primary)) return { primary, isSerif: true };
	if (tokens.includes("serif")) return { primary, isSerif: true };
	return { primary, isSerif: false };
}

export interface ItalicSerifOptions {
	readonly tag: string;
	readonly fontStyle: string;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly headingText?: string | null;
}

/**
 * The italic-serif display hero: the most-used generated hero treatment. Anchored
 * on hero scale, because an italic serif at body size is ordinary typography.
 * `h1` is the canonical hero element; `h2` at 48px or more catches designs that
 * demote the visual hero to an h2 but keep the size.
 */
function checkItalicSerif(opts: ItalicSerifOptions): RuleHit[] {
	const { tag, fontStyle, fontFamily, fontSize, headingText } = opts;
	if (fontStyle !== "italic") return [];
	if (tag !== "h1" && !(tag === "h2" && fontSize >= 48)) return [];
	if (fontSize < 48) return [];
	const { primary, isSerif } = resolveSerif(fontFamily);
	if (!isSerif) return [];

	const text = (headingText || "").trim().slice(0, 60);
	return [
		{
			id: "italic-serif-display",
			snippet: `italic serif ${tag} (${primary || "serif"}) at ${Math.round(fontSize)}px "${text}"`,
		},
	];
}

export interface IconTileOptions {
	readonly headingTag: string;
	readonly headingText?: string | null;
	readonly headingTop: number;
	readonly siblingTag: string | null;
	readonly siblingWidth: number;
	readonly siblingHeight: number;
	readonly siblingBottom: number;
	readonly siblingBgColor?: Color | null;
	readonly siblingBgImage?: string | null;
	readonly siblingBorderWidth: number;
	readonly siblingBorderRadius: number;
	readonly hasIconChild: boolean;
	readonly iconChildWidth?: number;
}

/**
 * The "icon tile stacked above a heading" shape: a squarish 32–128px tile with
 * a visible surface, an icon child smaller than the tile, sitting above the
 * heading. Round avatars and wide thumbnails are excluded.
 */
function checkIconTile(opts: IconTileOptions): RuleHit[] {
	const {
		headingTag, headingText, headingTop,
		siblingTag, siblingWidth, siblingHeight, siblingBottom,
		siblingBgColor, siblingBgImage, siblingBorderWidth, siblingBorderRadius,
		hasIconChild, iconChildWidth,
	} = opts;

	if (!HEADING_TAGS.has(headingTag)) return [];
	if (!siblingTag) return [];
	// A nested heading (h2 above h3 in a section header) is a different tell.
	if (HEADING_TAGS.has(siblingTag)) return [];

	if (!(siblingWidth >= 32 && siblingWidth <= 128)) return [];
	if (!(siblingHeight >= 32 && siblingHeight <= 128)) return [];

	const ratio = siblingWidth / siblingHeight;
	if (ratio < 0.7 || ratio > 1.4) return [];

	const bgVisible =
		(siblingBgColor != null && siblingBgColor.a > 0.1) ||
		(siblingBgImage != null && siblingBgImage !== "none" && siblingBgImage !== "");
	const borderVisible = siblingBorderWidth > 0;
	if (!bgVisible && !borderVisible) return [];

	// Circles are avatars; rounded squares pass.
	if (siblingBorderRadius >= siblingWidth / 2) return [];

	if (!hasIconChild) return [];
	if (iconChildWidth && iconChildWidth >= siblingWidth * 0.95) return [];

	// The tile must end above where the heading starts. Both zero means the
	// engine had no layout to measure, so the check abstains from the ordering
	// gate rather than failing it.
	if (headingTop && siblingBottom && siblingBottom > headingTop + 4) return [];

	const text = (headingText || "").trim().slice(0, 60);
	return [
		{
			id: "icon-tile-stack",
			snippet: `${Math.round(siblingWidth)}x${Math.round(siblingHeight)}px icon tile above ${headingTag} "${text}"`,
		},
	];
}

/**
 * Resolve a CSS length to pixels for the hero-scale gates. Static engines cannot
 * resolve viewport units, but a `clamp()`'s bounds still say whether the heading
 * can ever reach hero scale, so the larger bound is used.
 */
function resolveHeroHeadingSizePx(value: string | null | undefined): number {
	const input = String(value || "").trim().toLowerCase();
	if (!input) return 0;

	const simpleLengthPx = (token: string | null | undefined): number | null => {
		const match = /^(-?\d*\.?\d+)\s*(px|rem|em|%)?$/.exec(String(token || "").trim());
		if (!match) return null;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount)) return null;
		if (match[2] === "rem" || match[2] === "em") return amount * 16;
		if (match[2] === "%") return amount * 0.16;
		return amount;
	};

	const direct = simpleLengthPx(input);
	if (direct !== null) return direct;

	const clamp = /^clamp\((.*)\)$/.exec(input);
	if (clamp) {
		const parts = clamp[1].split(",");
		if (parts.length === 3) {
			const bounds = [simpleLengthPx(parts[0]), simpleLengthPx(parts[2])].filter(
				(candidate): candidate is number => candidate !== null,
			);
			if (bounds.length > 0) return Math.max(...bounds);
		}
	}

	return 0;
}

export interface HeroEyebrowOptions {
	readonly headingTag: string;
	readonly headingText?: string | null;
	readonly headingFontSize: number;
	readonly headingInApplicationContext?: boolean;
	readonly siblingTag: string | null;
	readonly siblingText?: string | null;
	readonly siblingTextTransform?: string | null;
	readonly siblingFontSize: number;
	readonly siblingLetterSpacing: number;
	readonly siblingFontWeight: number | string;
	readonly siblingColor?: string | null;
	readonly siblingHasAccentDashPseudo?: boolean;
}

/**
 * A label above a hero headline: the eyebrow-chip cliché. Three styles reach
 * the same place — tracked uppercase, accent bold in sentence case, and a
 * short chromatic dash announcing the label.
 *
 * This is a marketing-hero pattern, not a ban on compact context labels in
 * product UI, so application contexts are exempt.
 */
function checkHeroEyebrow(opts: HeroEyebrowOptions): RuleHit[] {
	const {
		headingTag, headingText, headingFontSize, headingInApplicationContext,
		siblingTag, siblingText, siblingTextTransform, siblingFontSize, siblingLetterSpacing,
		siblingFontWeight, siblingColor, siblingHasAccentDashPseudo,
	} = opts;

	if (headingTag !== "h1") return [];
	if (headingInApplicationContext) return [];
	if (!(headingFontSize >= 48)) return [];
	if (!siblingTag) return [];
	// An h2 above an h1 is a heading-hierarchy problem, never an eyebrow.
	if (HEADING_TAGS.has(siblingTag)) return [];

	const text = (siblingText || "").trim();
	if (text.length < 2 || text.length > 60) return [];
	if (!(siblingFontSize > 0 && siblingFontSize <= 14)) return [];

	const isUppercased = siblingTextTransform === "uppercase" || (/[A-Z]/.test(text) && !/[a-z]/.test(text));
	const isClassicTracked = isUppercased && siblingLetterSpacing >= 1.6;

	const weight = Number(siblingFontWeight) || 400;
	const isAccentBold = weight >= 700 && isAccentColor(siblingColor || "");

	const isDashPrefixed = !!siblingHasAccentDashPseudo;

	if (!isClassicTracked && !isAccentBold && !isDashPrefixed) return [];

	const headingTextSnippet = (headingText || "").trim().slice(0, 60);
	const eyebrowSnippet = text.slice(0, 40);
	const style = isClassicTracked ? "tracked-caps" : isAccentBold ? "accent-bold" : "dash-prefix";
	return [
		{
			id: "hero-eyebrow-chip",
			snippet: `eyebrow chip (${style}) "${eyebrowSnippet}" above ${headingTag} "${headingTextSnippet}"`,
		},
	];
}

/** A collected kicker candidate: a small label directly above a heading. */
export interface KickerCandidate {
	readonly kickerText: string;
	readonly headingTag: string;
	readonly headingText: string;
}

/**
 * The kicker above a heading is an outright ban: one is one too many, so every
 * collected candidate becomes a finding. The judgment lives in the candidate
 * gate and the collector's context skips, not in a repetition count.
 */
function checkKickerAboveHeading(opts: { readonly candidates?: readonly KickerCandidate[] | unknown }): RuleHit[] {
	const { candidates } = opts;
	if (!Array.isArray(candidates)) return [];
	return candidates.map((candidate: KickerCandidate) => ({
		id: "kicker-above-heading",
		snippet: `kicker "${candidate.kickerText}" above ${candidate.headingTag} "${candidate.headingText}"`,
	}));
}

export {
	checkHeroEyebrow,
	checkIconTile,
	checkItalicSerif,
	checkKickerAboveHeading,
	HEADING_TAGS,
	resolveHeroHeadingSizePx,
	resolveSerif,
};
export type { SerifResolution };
