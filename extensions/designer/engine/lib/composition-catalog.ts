/**
 * The composition catalog: catalog B, which holds compositions rather than styles. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A composition organizes attention, sequence, or manipulation on a surface and has to survive
 * being dressed in any committed visual identity, so it deliberately carries no palette or type
 * half. Surface-scope seeds draw from here, and direction seeds pair one composition with a
 * chosen world for the first surface.
 *
 * The taxonomy lives in `roll-selection.ts` and is re-exported here, because the roll validates
 * its grain and platform arguments against it while this module is the one that reads files.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONCEPT_STATUSES, normalizeConceptForm } from "./concept-catalog.ts";
import { COMPOSITION_GRAINS, COMPOSITION_PLATFORMS, isGrain, isPlatform } from "./roll-selection.ts";

/** The four grammar prefixes, in the order a composition must state them. */
const COMPOSITION_GRAMMAR_PREFIXES: readonly string[] = ["Staging/hierarchy:", "Sequence/attention:", "Controls/state:", "Adaptation:"];

/** Surface registers align with the skill's modes: a persuade composition and an operate one are different species. */
const COMPOSITION_SURFACES: ReadonlySet<string> = new Set(["persuade", "operate", "read", "experience"]);

/** A composition as stored in the catalog. */
interface CompositionEntry {
	readonly id?: string;
	readonly familyId?: string;
	readonly form?: unknown;
	readonly lineage?: unknown;
	readonly surface?: unknown;
	readonly grain?: unknown;
	readonly platforms?: unknown;
	readonly tags?: unknown;
	readonly grammar?: unknown;
	readonly spark?: unknown;
	readonly webLeverage?: unknown;
}

/** Fingerprint of everything a reviewer judged; a review carries it so an approval cannot outlive an edit. */
function compositionContentHash(composition: CompositionEntry): string {
	const payload = [
		composition?.form ?? "",
		composition?.lineage ?? "",
		JSON.stringify(composition?.tags ?? []),
		JSON.stringify(composition?.grammar ?? []),
		composition?.spark ?? "",
		composition?.webLeverage ?? "",
	].join("\n");
	return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/** Every reason a composition is not acceptable. */
function validateCompositionEntry(composition: CompositionEntry, { existingForms = new Map<string, string>() }: { readonly existingForms?: Map<string, string> } = {}): string[] {
	const errors: string[] = [];
	const id = composition?.id || "(unknown)";

	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(composition?.id || "")) {
		errors.push(`invalid composition id: ${String(composition?.id)}`);
	}

	const normalized = normalizeConceptForm(composition?.form);
	if (!normalized) {
		errors.push(`composition ${id} needs a form`);
	} else if (existingForms.has(normalized)) {
		errors.push(`duplicate composition form: ${id} and ${existingForms.get(normalized)}`);
	}

	const form = typeof composition?.form === "string" ? composition.form : "";
	if (typeof composition?.form !== "string" || form.trim().length < 40 || form.trim().length > 360 || !form.includes(",")) {
		errors.push(`composition ${id} must name a staging and its structural mechanism after a comma`);
	}

	const lineage = typeof composition?.lineage === "string" ? composition.lineage : "";
	if (typeof composition?.lineage !== "string" || lineage.trim().length < 12 || lineage.trim().length > 200) {
		errors.push(`composition ${id} needs lineage metadata of 12–200 characters`);
	}

	if (!COMPOSITION_SURFACES.has(composition?.surface as string)) {
		errors.push(`composition ${id} needs a surface of ${[...COMPOSITION_SURFACES].join(", ")}`);
	}

	// Grain is optional, and absence means eligible at any grain, so nothing needs backfilling.
	if (composition?.grain !== undefined && composition.grain !== null && !isGrain(composition.grain)) {
		errors.push(`composition ${id} grain "${String(composition.grain)}" must be one of ${COMPOSITION_GRAINS.join(", ")}`);
	}

	// Absence means every platform, so listing them all says the same as omitting the field; an
	// empty array would exclude the entry from every roll.
	if (composition?.platforms !== undefined && composition.platforms !== null) {
		const list = composition.platforms;
		if (!Array.isArray(list) || list.length === 0) {
			errors.push(`composition ${id} platforms must be a non-empty array, or omitted to allow every platform`);
		} else if (list.some((entry) => !isPlatform(entry))) {
			errors.push(`composition ${id} platforms may only contain ${COMPOSITION_PLATFORMS.join(", ")}`);
		} else if (new Set(list).size !== list.length) {
			errors.push(`composition ${id} platforms must not repeat a platform`);
		} else if (list.length === COMPOSITION_PLATFORMS.length) {
			errors.push(`composition ${id} platforms lists every platform; omit the field instead`);
		}
	}

	if (!Array.isArray(composition?.tags) || composition.tags.length !== 3 || composition.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
		errors.push(`composition ${id} must have exactly three structural tags`);
	}

	if (!Array.isArray(composition?.grammar) || composition.grammar.length !== COMPOSITION_GRAMMAR_PREFIXES.length || composition.grammar.some((rule) => typeof rule !== "string" || rule.trim().length < 12 || rule.trim().length > 180)) {
		errors.push(`composition ${id} needs grammar with exactly four rules of 12–180 characters`);
	} else {
		const grammar = composition.grammar as string[];
		const unique = new Set(grammar.map(normalizeConceptForm));
		if (unique.size !== COMPOSITION_GRAMMAR_PREFIXES.length) errors.push(`composition ${id} has duplicate grammar rules`);
		if (grammar.some((rule, index) => !rule.startsWith(COMPOSITION_GRAMMAR_PREFIXES[index]))) {
			errors.push(`composition ${id} grammar must use staging, sequence, controls, and adaptation prefixes in order`);
		}
	}

	const spark = typeof composition?.spark === "string" ? composition.spark : "";
	if (typeof composition?.spark !== "string" || spark.trim().length < 80 || spark.trim().length > 320) {
		errors.push(`composition ${id} needs a vivid spark of 80–320 characters`);
	}

	const webLeverage = typeof composition?.webLeverage === "string" ? composition.webLeverage : "";
	if (typeof composition?.webLeverage !== "string" || webLeverage.trim().length < 20 || webLeverage.trim().length > 240) {
		errors.push(`composition ${id} needs web leverage of 20–240 characters`);
	}

	return errors;
}

/** A composition merged with its family label and review. */
interface MergedComposition extends CompositionEntry {
	readonly familyLabel: string | null;
	readonly status: string;
	readonly review: Record<string, unknown> | null;
}

/** Read both files and merge every composition with its family label and review. */
function readCompositionCatalog(catalogPath: string, reviewsPath: string): {
	catalog: Record<string, unknown>;
	reviewData: Record<string, unknown>;
	reviews: Record<string, Record<string, unknown>>;
	compositions: MergedComposition[];
} {
	const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
		families?: Array<{ id: string; label?: string }>;
		compositions?: CompositionEntry[];
	};
	const reviewData = JSON.parse(readFileSync(reviewsPath, "utf8")) as { reviews?: Record<string, Record<string, unknown>> };
	const reviews = reviewData.reviews || {};
	const familiesById = new Map((catalog.families || []).map((family) => [family.id, family]));

	const compositions = (catalog.compositions || []).map((composition) => ({
		...composition,
		familyLabel: familiesById.get(composition.familyId ?? "")?.label ?? null,
		status: (reviews[composition.id ?? ""]?.status as string) || "pending",
		review: reviews[composition.id ?? ""] || null,
	}));

	return { catalog: catalog as Record<string, unknown>, reviewData: reviewData as Record<string, unknown>, reviews, compositions };
}

/** What a composition catalog validation found. */
interface CompositionValidation {
	readonly errors: string[];
	readonly stats: {
		readonly families: number;
		readonly compositions: number;
		readonly approved: number;
		readonly rejected: number;
	};
}

/** Everything wrong with a composition catalog and its reviews. */
function validateCompositionCatalog(
	catalog: Record<string, unknown> | null | undefined,
	reviewData: Record<string, unknown> | null | undefined,
	{ minimumTotal }: { readonly minimumTotal?: number } = {},
): CompositionValidation {
	const errors: string[] = [];
	const familyIds = new Set<string>();
	const ids = new Set<string>();
	const forms = new Map<string, string>();

	const data = (catalog ?? {}) as {
		schemaVersion?: number;
		qualityBar?: { principle?: string };
		families?: Array<{ id?: string; description?: string }>;
		compositions?: CompositionEntry[];
	};

	if (!Number.isInteger(data.schemaVersion) || (data.schemaVersion ?? 0) < 1) {
		errors.push("composition catalog schemaVersion must be a positive integer");
	}
	if (typeof data.qualityBar?.principle !== "string" || data.qualityBar.principle.trim().length < 80) {
		errors.push("composition qualityBar.principle must define the staging bar");
	}
	if (!Array.isArray(data.families) || data.families.length < 4) errors.push("composition catalog needs at least four families");

	for (const family of data.families || []) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family.id || "")) errors.push(`invalid composition family id: ${String(family.id)}`);
		if (familyIds.has(family.id as string)) errors.push(`duplicate composition family id: ${family.id}`);
		familyIds.add(family.id as string);
		if (typeof family.description !== "string" || family.description.trim().length < 40) {
			errors.push(`composition family ${family.id || "(unknown)"} needs a description`);
		}
	}

	const compositions = data.compositions || [];
	for (const composition of compositions) {
		if (ids.has(composition.id as string)) errors.push(`duplicate composition id: ${composition.id}`);
		ids.add(composition.id as string);
		if (!familyIds.has(composition.familyId ?? "")) {
			errors.push(`composition ${composition.id} must belong to a declared family, got: ${String(composition.familyId)}`);
		}
		errors.push(...validateCompositionEntry(composition, { existingForms: forms }));
		const normalized = normalizeConceptForm(composition.form);
		if (normalized) forms.set(normalized, composition.id as string);
	}

	if (minimumTotal !== undefined && compositions.length < minimumTotal) {
		errors.push(`expected at least ${minimumTotal} compositions, found ${compositions.length}`);
	}

	const reviews = ((reviewData ?? {}) as { reviews?: Record<string, Record<string, unknown>> }).reviews || {};
	for (const [id, review] of Object.entries(reviews)) {
		if (!ids.has(id)) errors.push(`composition review references missing entry: ${id}`);
		if (!CONCEPT_STATUSES.has(review?.status as string)) errors.push(`invalid composition review status for ${id}`);

		if (typeof review?.formHash !== "string" || !review.formHash.trim()) {
			errors.push(`composition review ${id} needs a formHash`);
		} else {
			const entry = compositions.find((composition) => composition.id === id);
			if (entry && review.formHash !== compositionContentHash(entry)) {
				errors.push(`composition review ${id} is stale: content changed since review`);
			}
		}

		// Mirrors the concept catalog: an optional 1–3 grade on approved entries only, read as a
		// calibration signal and used to weight challenger draws.
		if (review?.rating !== undefined) {
			if (![1, 2, 3].includes(review.rating as number)) errors.push(`review ${id} rating must be 1, 2, or 3`);
			else if (review.status !== "approved") errors.push(`review ${id} rating only applies to approved compositions`);
		}

		if (review?.note !== undefined && (typeof review.note !== "string" || !review.note.trim() || (review.note as string).length > 500)) {
			errors.push(`composition review ${id} note must be a non-empty string of 500 characters or fewer`);
		}
	}

	return {
		errors,
		stats: {
			families: familyIds.size,
			compositions: compositions.length,
			approved: Object.values(reviews).filter((review) => review?.status === "approved").length,
			rejected: Object.values(reviews).filter((review) => review?.status === "rejected").length,
		},
	};
}

export {
	COMPOSITION_GRAMMAR_PREFIXES,
	COMPOSITION_GRAINS,
	COMPOSITION_PLATFORMS,
	COMPOSITION_SURFACES,
	compositionContentHash,
	isGrain,
	isPlatform,
	readCompositionCatalog,
	validateCompositionCatalog,
	validateCompositionEntry,
};
export type { CompositionEntry, CompositionValidation, MergedComposition };
