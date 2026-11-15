/**
 * Font matching: what a comp's type reads as, which candidates to try, and how a measured choice is
 * stamped so a spec gate can tell it from a guess. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The fingerprint and the distance live in `font-fingerprint.ts`; this module turns two of those
 * features into the words a MEASURE line prints, builds the candidate list, and stamps a choice.
 * Browsers are not here on purpose: rendering a candidate is a host surface, so `renderCandidates`
 * takes a renderer instead of discovering one.
 */
import { createHash } from "node:crypto";
import { candidatesFromIndex, loadFontIndex, MIN_RANK_CAP_PX, type FontIndex } from "./font-index.ts";
import { distance, fingerprint, type Fingerprint } from "./font-fingerprint.ts";

/** A feature that reads as width or weight, and its value. */
interface Measure {
	readonly key: string;
	readonly value: number;
}

/**
 * The feature that reads as width: `advX` on a mixed-case crop, `advTall` when the crop is all
 * caps, falling back to `advance`.
 */
function widthMeasure(fp: Record<string, unknown> | null | undefined): Measure | null {
	if (!fp) return null;
	if (fp.advX != null) return { key: "advX", value: fp.advX as number };
	if (fp.advTall != null) return { key: "advTall", value: fp.advTall as number };
	if (fp.advance != null) return { key: "advance", value: fp.advance as number };
	return null;
}

/**
 * How wide the type reads.
 *
 * The thresholds sit on the catalog index, anchored by named faces: League Gothic 0.36, Oswald
 * 0.42, Anton 0.48, Barlow Condensed 0.54, Roboto Condensed 0.58, Roboto 0.62, Inter 0.65, Space
 * Grotesk 0.71, Montserrat Bold 0.76, Archivo Black 0.87.
 */
function widthClass(fp: Record<string, unknown> | number | null | undefined): string {
	const m = typeof fp === "number" ? { key: "advX", value: fp } : widthMeasure(fp);
	if (!m) return "normal";
	// Cap widths run about 10% wider than x-height widths against the same reference height.
	const t = m.key === "advTall" ? [0.45, 0.61, 0.78] : [0.42, 0.585, 0.72];
	if (m.value < t[0]) return "compressed";
	if (m.value < t[1]) return "condensed";
	if (m.value < t[2]) return "normal";
	return "wide";
}

/**
 * The feature that reads as weight: `densTall`, the ink over bbox area of cap-height glyphs,
 * falling back through `densX`, `stemW` and the recorded weight.
 *
 * Catalog anchors for densTall: Lato 300 0.27, Roboto 300 0.32, Playfair 400 0.37, Inter 400 0.44,
 * Roboto 700 0.59, Work Sans 700 0.64, Bebas Neue 0.68, Oswald 700 0.72, League Gothic 0.76,
 * Anton 0.79. For stemW: Roboto 300 0.10, Roboto 400 0.14, Inter 700 0.22, Archivo Black 0.30.
 */
function weightMeasure(fp: Record<string, unknown> | null | undefined): Measure | null {
	if (!fp) return null;
	if (fp.densTall != null) return { key: "densTall", value: fp.densTall as number };
	if (fp.densX != null) return { key: "densX", value: fp.densX as number };
	if (fp.stemW != null) return { key: "stemW", value: fp.stemW as number };
	if (fp.weight != null) return { key: "weight", value: fp.weight as number };
	return null;
}

/** How heavy the type reads. */
function weightClass(fp: Record<string, unknown> | number | null | undefined): string {
	const m = typeof fp === "number" ? { key: "densTall", value: fp } : weightMeasure(fp);
	if (!m) return "regular";
	const t = m.key === "stemW" ? [0.105, 0.165, 0.195, 0.24] : [0.34, 0.48, 0.56, 0.66];
	if (m.value < t[0]) return "light";
	if (m.value < t[1]) return "regular";
	if (m.value < t[2]) return "medium";
	if (m.value < t[3]) return "bold";
	return "black";
}

/**
 * A starter shortlist per width class, chosen to span weight and character inside the class.
 *
 * Used only when the catalog index is missing: with the index, candidates come from the comp's own
 * fingerprint and from the names the caller supplied.
 */
const SHORTLIST: Readonly<Record<string, readonly string[]>> = {
	compressed: ["League Gothic:400", "Bebas Neue:400", "Anton:400", "Six Caps:400", "Big Shoulders Display:900", "Antonio:700", "Saira Extra Condensed:800", "Oswald:700"],
	condensed: [
		"League Gothic:400", "Fjalla One:400", "Anton:400", "Bebas Neue:400", "Oswald:600", "Barlow Condensed:700",
		"Roboto Condensed:800", "Archivo Narrow:700", "Pathway Gothic One:400", "Big Shoulders Display:800", "Teko:600", "Sofia Sans Condensed:800",
	],
	normal: ["Inter:700", "Work Sans:700", "IBM Plex Sans:700", "Archivo:800", "Public Sans:700", "Source Sans 3:700", "Roboto:900", "Barlow:800", "Manrope:800", "Rubik:800"],
	wide: ["Archivo Black:400", "Syne:800", "Space Grotesk:700", "Unbounded:700", "Bricolage Grotesque:800", "Sora:800", "Outfit:800", "Lexend:800"],
};

/** Weight-shifted variants of a candidate list, one step lighter and heavier; the ranking decides. */
function withWeightVariants(list: readonly string[]): string[] {
	const out: string[] = [];
	for (const candidate of list) {
		out.push(candidate);
		const m = /^(.*?):(\d{3})$/.exec(candidate);
		if (!m) continue;
		const weight = parseInt(m[2], 10);
		for (const delta of [-200, 200]) {
			const next = weight + delta;
			if (next >= 100 && next <= 900) out.push(`${m[1]}:${next}`);
		}
	}
	return [...new Set(out)];
}

/** A candidate face. */
interface CandidateChoice {
	readonly family: string;
	readonly weight: number;
}

/** Parse a `"Family:700,Family2:400"` string into candidates. */
function parseCandidates(s: string | null | undefined): CandidateChoice[] {
	return String(s || "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => {
			const m = /^(.*?)(?::(\d{3}))?$/.exec(x) as RegExpExecArray;
			return { family: m[1].trim(), weight: m[2] ? parseInt(m[2], 10) : 400 };
		});
}

/**
 * Candidate faces for a comp fingerprint: the nearest index faces, then the caller's own names,
 * and the built-in shortlist only when there is no index at all.
 */
function selectCandidates(
	fp: Record<string, unknown> | null,
	{ own = [], index = null, n = 25, category = null }: { readonly own?: ReadonlyArray<string | CandidateChoice>; readonly index?: FontIndex | null; readonly n?: number; readonly category?: string | null } = {},
): { candidates: CandidateChoice[]; catalog: ReturnType<typeof candidatesFromIndex>; source: "index" | "shortlist" } {
	const catalog = index ? candidatesFromIndex(fp, index, { n, category }) : [];
	// `own` arrives as names or as already-parsed faces, so both compose into one list.
	const ownList: CandidateChoice[] = own.flatMap((entry) => (typeof entry === "string" ? parseCandidates(entry) : [entry]));
	const list: CandidateChoice[] = [...ownList, ...catalog.map((c) => ({ family: c.family, weight: c.weight }))];

	let source: "index" | "shortlist" = "index";
	if (!index) {
		source = "shortlist";
		for (const entry of withWeightVariants(SHORTLIST[widthClass(fp)] ?? SHORTLIST.normal)) list.push(parseCandidates(entry)[0]);
	}

	const seen = new Set<string>();
	const candidates = list.filter((c) => {
		const key = `${c.family}:${c.weight}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { candidates, catalog, source };
}

/** A measured choice, as it lands in the spec. */
interface ChosenFont {
	readonly family: string;
	readonly weight: number | string;
	readonly fontSizePx: number | string;
	readonly source: string;
	readonly stamp?: string;
}

/**
 * Stamp a choice over its own fields.
 *
 * The gate that reads a spec needs to tell a measured choice from a hand-typed one: writing
 * `{"family": "Arial Narrow", "source": "system-fallback"}` straight into the spec is exactly the
 * guess that gate exists to refuse. The stamp is not a secret, just not something a model reaches
 * for by accident.
 */
function stampChoice(regionId: string, chosen: ChosenFont): ChosenFont {
	const h = createHash("sha1").update(`font-match:${regionId}:${chosen.family}:${chosen.weight}:${chosen.fontSizePx}:${chosen.source}`).digest("hex").slice(0, 12);
	return { ...chosen, stamp: h };
}

/** True when the choice carries a stamp this module would produce for it. */
function choiceStamped(regionId: string, chosen: ChosenFont | null | undefined): boolean {
	if (!chosen?.stamp) return false;
	return stampChoice(regionId, { ...chosen, stamp: undefined }).stamp === chosen.stamp;
}

/** The one-line description a MEASURE report prints. */
function describe(fp: Fingerprint): string {
	const wm = widthMeasure(fp);
	const wt = weightMeasure(fp);
	const wmS = wm ? ` (${wm.key} ${wm.value})` : "";
	const wtS = wt ? ` (${wt.key} ${wt.value})` : "";
	return `capHeight ${fp.capHeightPx}px, width ${widthClass(fp)}${wmS}, weight ${weightClass(fp)}${wtS}, tracking ${fp.gap}${fp.allCaps ? ", all caps" : ""}`;
}

/** Fingerprint fields the spec keeps for a region: the class-bearing features, not the whole vector. */
function compactFp(fp: Record<string, unknown> | null): Record<string, unknown> | null {
	if (!fp) return fp;
	const keep = ["lines", "glyphs", "capHeightPx", "inkIsDark", "allCaps", "advance", "advTall", "advX", "gap", "xRatio", "stemW", "contrast", "serif", "densTall", "densX", "weight"];
	const out: Record<string, unknown> = {};
	for (const k of keep) if (fp[k] !== undefined) out[k] = fp[k];
	return out;
}

/**
 * A whole measure or rank step for one region, with the host supplying the pixels and the
 * renderer. This is the seam a command calls: no argv, no process exit, no browser discovery.
 */
interface MatchOptions {
	/** The crop as pixels, already extracted from the comp's region box. */
	readonly crop: Parameters<typeof fingerprint>[0];
	/** Names or faces the caller wants ranked alongside the catalog's. */
	readonly own?: ReadonlyArray<string | CandidateChoice>;
	/** Where the index lives, or null to use the built-in shortlist. */
	readonly indexPath?: string | null;
	readonly index?: FontIndex | null;
	readonly n?: number;
	readonly category?: string | null;
}

interface MatchResult {
	readonly fingerprint: Fingerprint | null;
	readonly description: string | null;
	readonly compact: Record<string, unknown> | null;
	readonly candidates: CandidateChoice[];
	readonly source: "index" | "shortlist" | "none";
	/** True when the cap height is too small for the fingerprint to be trustworthy. */
	readonly belowRankCap: boolean;
}

/** Measure a crop and choose candidates for it. */
function matchRegion({ crop, own = [], indexPath = null, index = null, n = 25, category = null }: MatchOptions): MatchResult {
	const fp = fingerprint(crop);
	if (!fp) return { fingerprint: null, description: null, compact: null, candidates: parseCandidates(own.join(",")), source: "none", belowRankCap: false };
	const catalog = index ?? (indexPath ? loadFontIndex(indexPath) : null);
	const selection = selectCandidates(fp, { own, index: catalog, n, category });

	return {
		fingerprint: fp,
		description: describe(fp),
		compact: compactFp(fp),
		candidates: selection.candidates,
		source: selection.source,
		belowRankCap: typeof fp.capHeightPx === "number" && fp.capHeightPx < MIN_RANK_CAP_PX,
	};
}

/** Rank an explicit candidate list against a crop's fingerprint, nearest first. */
function rankCandidates(crop: Parameters<typeof fingerprint>[0], candidates: readonly string[], fingerprints: Readonly<Record<string, Record<string, unknown>>>): Array<{ family: string; weight: number; distance: number }> {
	const fp = fingerprint(crop);
	if (!fp) return [];

	// A candidate's own fingerprint comes from the host: rendering a face is a browser surface, so
	// this ranks what it is given rather than discovering a renderer.
	return parseCandidates(candidates.join(","))
		.map((candidate) => {
			const rendered = fingerprints[`${candidate.family}:${candidate.weight}`];
			return { ...candidate, distance: rendered ? distance(fp, rendered) : Number.POSITIVE_INFINITY };
		})
		.sort((a, b) => a.distance - b.distance || `${a.family}:${a.weight}`.localeCompare(`${b.family}:${b.weight}`));
}

export {
	choiceStamped,
	compactFp,
	describe,
	matchRegion,
	parseCandidates,
	rankCandidates,
	selectCandidates,
	SHORTLIST,
	stampChoice,
	weightClass,
	weightMeasure,
	widthClass,
	widthMeasure,
	withWeightVariants,
};
export type { CandidateChoice, ChosenFont, MatchOptions, MatchResult, Measure };
