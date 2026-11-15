/**
 * The fingerprint index of the Google Fonts catalog: what font ranking uses as its candidate
 * generator, plus the pack/unpack helpers the release-time build shares with it. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The file shape is `{ schema, text, sizes, features, categories, entries }`, where an entry is
 * `[family, weight, categoryIndex, variable, ...vectors]` and a vector is a string of 3-char
 * base-36 numbers, each the feature value times 1000 clipped at 46.655, with `___` for null. That
 * packing keeps ~3,000 faces × 2 sizes × 33 features under 750 KB on disk, which is what makes it
 * shippable inside a skill without gzip.
 *
 * Two sizes because the features are stable within a factor of about two in size but not from
 * 48px down to 14px: a crop is routed to the index rendered nearer its own cap height.
 */
import fs from "node:fs";
import { distance, FEATURES, STATS } from "./font-fingerprint.ts";

/** Where the index lives by default. A caller passes its own path when it ships elsewhere. */
const DEFAULT_INDEX_PATH = "font-index.json";

/** Cap heights the catalog is rendered at. `48c` is the same 48px cap in all-caps text. */
const INDEX_SIZES: readonly (number | string)[] = [48, 14, "48c"];

/** Crops with a cap height under this many px query the 14px index. */
const ROUTE_CAP_PX = 22;

/** Below this cap height the fingerprint is not trustworthy; callers size by the box instead. */
const MIN_RANK_CAP_PX = 10;

/** The categories an entry can declare. */
const CATEGORIES: readonly string[] = ["sans", "serif", "display", "handwriting", "mono"];

/** Gross features the fitted distance would otherwise zero. */
const GROSS_FEATURES: readonly string[] = ["advance", "advTall", "advX", "densTall", "densX", "stemW"];

/** The features a vector stores: the ones the fitted distance gives nonzero weight. */
const INDEX_FEATURES: readonly string[] = FEATURES.filter((k) => (STATS[k] && STATS[k].w > 0) || GROSS_FEATURES.includes(k));

const NULL_TOKEN = "___";
const MAX_Q = 36 ** 3 - 1;

/** Pack a fingerprint into the index's compact vector string. */
function packVector(fp: Record<string, unknown>, features: readonly string[] = INDEX_FEATURES): string {
	return features
		.map((k) => {
			const v = fp?.[k];
			if (v == null || typeof v !== "number" || !Number.isFinite(v)) return NULL_TOKEN;
			return Math.min(MAX_Q, Math.max(0, Math.round(v * 1000)))
				.toString(36)
				.padStart(3, "0");
		})
		.join("");
}

/** Unpack an index vector string back into feature values, with nulls preserved. */
function unpackVector(s: string, features: readonly string[] = INDEX_FEATURES): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	for (let i = 0; i < features.length; i++) {
		const token = s.slice(i * 3, i * 3 + 3);
		out[features[i]] = token === NULL_TOKEN || token.length < 3 ? null : parseInt(token, 36) / 1000;
	}
	return out;
}

/** One catalog face, with its vectors keyed by the size they were rendered at. */
interface IndexEntry {
	readonly family: string;
	readonly weight: number;
	readonly category: string;
	readonly variable: boolean;
	readonly fp: Record<string, Record<string, number | null> | null>;
}

/** The decoded index. */
interface FontIndex {
	readonly schema: number;
	readonly text: string;
	readonly sizes: readonly (number | string)[];
	readonly features: readonly string[];
	readonly entries: readonly IndexEntry[];
}

let cached: { file: string; index: FontIndex } | null = null;

/**
 * Load and decode the index, or null when the file is missing so a caller can fall back to its
 * built-in shortlist. Cached per path, because ranking reads it once per run.
 */
function loadFontIndex(file: string = DEFAULT_INDEX_PATH): FontIndex | null {
	if (cached && cached.file === file) return cached.index;
	if (!fs.existsSync(file)) return null;

	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
		schema: number;
		text: string;
		sizes?: (number | string)[];
		features?: string[];
		categories?: string[];
		entries: Array<[string, number, number, number, ...string[]]>;
	};

	const features = raw.features ?? INDEX_FEATURES;
	const categories = raw.categories ?? CATEGORIES;
	const sizes = raw.sizes ?? INDEX_SIZES;

	const entries: IndexEntry[] = raw.entries.map((entry) => {
		const fp: Record<string, Record<string, number | null> | null> = {};
		sizes.forEach((size, i) => {
			const vector = entry[4 + i];
			fp[String(size)] = vector ? unpackVector(String(vector), features) : null;
		});
		return { family: entry[0], weight: entry[1], category: categories[entry[2]] ?? String(entry[2]), variable: !!entry[3], fp };
	});

	const index: FontIndex = { schema: raw.schema, text: raw.text, sizes, features, entries };
	cached = { file, index };
	return index;
}

/** Which of the index's cap sizes a crop with this cap height should query. */
function routeSize(capHeightPx: number, sizes: readonly (number | string)[] = INDEX_SIZES, { allCaps = false }: { readonly allCaps?: boolean } = {}): number | string | undefined {
	const numeric = sizes.filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
	if (allCaps && capHeightPx >= ROUTE_CAP_PX && sizes.includes("48c")) return "48c";
	return capHeightPx < ROUTE_CAP_PX ? numeric[0] : numeric[numeric.length - 1];
}

/**
 * Faces that are not lettering: barcodes, redaction bars, placeholder "flow" text, dingbats,
 * symbol fonts, and effect faces (outlines, shades, glitch, pixel, 3D) whose fingerprint lands
 * near heavy condensed text without being usable as it.
 */
const NON_TEXT_FAMILY =
	/barcode|^redacted|^flow (block|circular|rounded)|dings|symbols|^bungee (hairline|outline|shade|spice)|^rubik (80s|beastly|broken|bubbles|burned|dirt|distressed|doodle|gemstones|glitch|iso|lines|marker|maze|microbe|moonrocks|pixels|puddles|scribble|spray|storm|vinyl|wet)|^(nabla|honk|kablammo|sixtyfour|workbench|codystar|rock 3d|zen dots|ballet|butcherman|creepster|eater|faster one|frijole|nosifer|metal mania|miltonian)/i;

/** One ranked candidate face. */
interface Candidate {
	readonly family: string;
	readonly weight: number;
	readonly category: string;
	readonly variable: boolean;
	readonly d: number;
	readonly size: number | string | undefined;
}

/**
 * The n nearest catalog faces to a comp fingerprint, routed by cap height, sorted by distance.
 *
 * At most `perFamily` entries of one family, so the shortlist spans faces rather than weights.
 */
function candidatesFromIndex(
	fp: Record<string, unknown> | null | undefined,
	index: FontIndex | null | undefined,
	{ n = 25, category = null, perFamily = 2, includeNonText = false }: { readonly n?: number; readonly category?: string | null; readonly perFamily?: number; readonly includeNonText?: boolean } = {},
): Candidate[] {
	if (!fp || !index) return [];

	const size = routeSize(fp.capHeightPx as number, index.sizes, { allCaps: !!fp.allCaps });
	const wantCat = category
		? String(category)
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean)
		: null;

	const scored: Candidate[] = [];
	for (const entry of index.entries) {
		if (wantCat && !wantCat.includes(entry.category)) continue;
		if (!includeNonText && NON_TEXT_FAMILY.test(entry.family)) continue;
		const vector = entry.fp[String(size)];
		if (!vector) continue;

		const d = distance(fp, vector);
		if (!Number.isFinite(d)) continue;
		scored.push({ family: entry.family, weight: entry.weight, category: entry.category, variable: entry.variable, d, size });
	}

	scored.sort((a, b) => a.d - b.d);

	const perFam = new Map<string, number>();
	const out: Candidate[] = [];
	for (const candidate of scored) {
		const count = perFam.get(candidate.family) ?? 0;
		if (count >= perFamily) continue;
		perFam.set(candidate.family, count + 1);
		out.push(candidate);
		if (out.length >= n) break;
	}
	return out;
}

export {
	CANDIDATES_DEFAULTS,
	CATEGORIES,
	candidatesFromIndex,
	DEFAULT_INDEX_PATH,
	GROSS_FEATURES,
	INDEX_FEATURES,
	INDEX_SIZES,
	loadFontIndex,
	MIN_RANK_CAP_PX,
	NON_TEXT_FAMILY,
	packVector,
	ROUTE_CAP_PX,
	routeSize,
	unpackVector,
};
export type { Candidate, FontIndex, IndexEntry };

/** The defaults `candidatesFromIndex` applies, exported so a caller can report them. */
const CANDIDATES_DEFAULTS = { n: 25, perFamily: 2, includeNonText: false } as const;
