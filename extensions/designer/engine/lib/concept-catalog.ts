/**
 * The concept catalog: what a world must carry, and what makes a review of it stale. Ported
 * from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two hashes do the work. A review carries the content hash of what it judged, so an approval
 * cannot silently survive an edit to the thing it approved — the validator rejects any review
 * whose hash no longer matches. And the approved-pool revision changes whenever the pool a roll
 * draws from changes, which is what lets a reproduced roll be checked.
 *
 * Everything is validated rather than coerced: a typo in an axis or a mode reads as "unrecorded"
 * and silently falls back to a probe that is known not to work, so it has to be an error.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { WELL_TIERS } from "./roll-selection.ts";

/** The two review outcomes. */
const CONCEPT_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected"]);

/** What a concept can serve: a durable identity, one page inside one, or both. */
const CONCEPT_STRENGTHS: ReadonlySet<string> = new Set(["world", "composition", "dual"]);

/** Whether a concept is broad enough to serve an arbitrary build. */
const CONCEPT_BREADTHS: ReadonlySet<string> = new Set(["general", "niche"]);

/** The registers of work a world can carry. */
const SEED_MODES: ReadonlySet<string> = new Set(["persuade", "operate", "read", "experience"]);

/** A browser-native capability worth naming. A miss is a warning, not an error. */
const WEB_LEVERAGE_RE =
	/(?:\b3d\b|\badaptive\b|\banimat(?:e|ed|ion)\b|\bapi\b|\baria\b|\baudio\b|\bautomated?\b|\bbarcode\b|\bbroadcastchannel\b|\bbrowser\b|\bcamera\b|canvas\b|\bcaption\b|\bcollaborat(?:e|ive|ion)\b|\bcompar(?:e|ison)\b|\bcomput(?:e|ed|ation)\b|\bcomputer[- ]vision\b|\bconstraint[- ]solving\b|\bcryptographic?\b|\bcss\b|\bdeep[- ]link(?:ing)?\b|\bdirect manipulation\b|\bdom\b|\bdrag\b|\bfilter\b|\bfocus\b|\bgenerative\b|\bgeolocat(?:e|ed|ion)\b|\bgesture\b|\bgpu\b|\bgraph\b|\bhistory\b|\bindexeddb\b|\binteractive\b|\bintersectionobserver\b|\bkeyboard\b|\blive\b|\blocal\b|\bmicrophone\b|\bmotion\b|\bmultiplayer\b|\bnative\b|\bnotification\b|\boffline\b|\bpersonaliz(?:e|ed|ation)\b|\bplayable\b|\bpointer\b|\bprocedural\b|\bprovenance\b|\breal[- ]?time\b|\bresizeobserver\b|\bresponsive\b|\breveal\b|\bscrub\b|\bsearch\b|\bsearchparams\b|\bsensor\b|\bserver[- ]sent\b|\bservice worker\b|\bshader\b|\bsimulat(?:e|ed|ion|or)\b|\bspatial\b|\bstate\b|\bstream(?:ing)?\b|\bsvg\b|\bsynchroniz(?:e|ed|ation)\b|\btimeline\b|\btouch\b|\burl|\bvideo\b|\bweb(?:gl|socket|vtt)?\b|\bworker\b|\bzoom\b)/i;

/** The five system-grammar prefixes, in the order a concept must state them. */
const SYSTEM_PREFIXES: readonly string[] = [
	"Palette/material:",
	"Type/composition:",
	"Topology/navigation:",
	"Controls/state:",
	"Responsive/motion:",
];

/** Frames that name a software archetype instead of an inspiring visual world. */
const BLAND_FORM_RE =
	/\b(?:control room|command center|operations center|dispatch desk|review queue|speaker queue|management console|admin console|operator loop|coordination system|tracking system|planning system|software platform|digital platform|operations cockpit|app portal|web portal|data hub|dashboard|workflow|planner|tracker|orchestrator)\b/i;

/** The comparison form of a string: accents folded, lowercased, punctuation flattened. */
function normalizeConceptForm(value: unknown): string {
	return String(value || "")
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Axis definitions, as the validator reads them. */
interface AxesDefinition {
	readonly axes?: ReadonlyArray<{ readonly id: string; readonly values?: ReadonlyArray<{ readonly id: string }> }>;
}

/** A concept as stored in the catalog. */
interface ConceptEntry {
	readonly id?: string;
	readonly form?: unknown;
	readonly lineage?: unknown;
	readonly strength?: unknown;
	readonly tags?: unknown;
	readonly avoid?: unknown;
	readonly system?: unknown;
	readonly spark?: unknown;
	readonly webLeverage?: unknown;
	readonly axes?: unknown;
}

/**
 * Every reason a concept is not acceptable. Form, lineage, strength, tags, the five system rules,
 * the spark and the web leverage each have a shape a reviewer relies on, so each is checked with
 * its bounds rather than a bare truthiness test.
 */
function validateConceptEntry(concept: ConceptEntry, { existingForms = new Map<string, string>(), axes = null }: { readonly existingForms?: Map<string, string>; readonly axes?: AxesDefinition | null } = {}): string[] {
	const errors: string[] = [];
	const id = concept?.id || "(unknown)";

	// Recorded aesthetic axis values are optional, and absent means the value is inferred from the
	// system rules. Some axes cannot be inferred at all, so a wave that assigns those has to
	// record them; a typo would read as unrecorded and fall back to a probe known not to work.
	if (concept?.axes !== undefined && concept.axes !== null) {
		if (typeof concept.axes !== "object" || Array.isArray(concept.axes)) {
			errors.push(`concept ${id} axes must be an object of axis id to value id`);
		} else if (axes) {
			const byId = new Map((axes.axes || []).map((axis) => [axis.id, axis]));
			for (const [axisId, valueId] of Object.entries(concept.axes as Record<string, unknown>)) {
				const axis = byId.get(axisId);
				if (!axis) {
					errors.push(`concept ${id} names unknown axis "${axisId}"`);
				} else if (!(axis.values || []).some((value) => value.id === valueId)) {
					errors.push(`concept ${id} axis "${axisId}" has unknown value "${valueId}" (expected one of ${(axis.values || []).map((v) => v.id).join(", ")})`);
				}
			}
		}
	}

	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(concept?.id || "")) {
		errors.push(`invalid concept id: ${String(concept?.id)}`);
	}

	const normalized = normalizeConceptForm(concept?.form);
	if (!normalized) {
		errors.push(`concept ${id} needs a form`);
	} else if (existingForms.has(normalized)) {
		errors.push(`duplicate concept form: ${id} and ${existingForms.get(normalized)}`);
	}

	const form = typeof concept?.form === "string" ? concept.form : "";
	if (typeof concept?.form !== "string" || form.trim().length < 40 || form.trim().length > 360 || !form.includes(",")) {
		errors.push(`concept ${id} must name a form and inherited structure after a comma`);
	}

	const lineage = typeof concept?.lineage === "string" ? concept.lineage : "";
	if (typeof concept?.lineage !== "string" || lineage.trim().length < 12 || lineage.trim().length > 200) {
		errors.push(`concept ${id} needs specific lineage metadata of 12–200 characters`);
	}

	if (!CONCEPT_STRENGTHS.has(concept?.strength as string)) {
		errors.push(`concept ${id} needs a strength of ${[...CONCEPT_STRENGTHS].join(", ")}`);
	}

	if (!Array.isArray(concept?.tags) || concept.tags.length !== 3 || concept.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
		errors.push(`concept ${id} must have exactly three structural tags`);
	}

	// The slop this particular world is at risk of. Optional, because older entries predate it
	// and none of them are wrong for lacking it: a world built from posters risks shouting, one
	// built from instruments risks dead greys, and a global detector cannot tell which.
	if (concept?.avoid !== undefined) {
		const avoid = concept.avoid;
		if (
			!Array.isArray(avoid) ||
			avoid.length < 2 ||
			avoid.length > 3 ||
			avoid.some((item) => typeof item !== "string" || item.trim().length < 12 || item.trim().length > 160)
		) {
			errors.push(`concept ${id} avoid must be two or three negations of 12–160 characters`);
		}
	}

	if (!Array.isArray(concept?.system) || concept.system.length !== SYSTEM_PREFIXES.length || concept.system.some((rule) => typeof rule !== "string" || rule.trim().length < 12 || rule.trim().length > 180)) {
		errors.push(`concept ${id} needs system grammar with exactly five rules of 12–180 characters`);
	} else {
		const system = concept.system as string[];
		const uniqueRules = new Set(system.map(normalizeConceptForm));
		if (uniqueRules.size !== SYSTEM_PREFIXES.length) errors.push(`concept ${id} has duplicate system grammar rules`);
		if (system.some((rule, index) => !rule.startsWith(SYSTEM_PREFIXES[index]))) {
			errors.push(`concept ${id} system grammar must use palette, type, topology, controls, and responsive prefixes in order`);
		}
	}

	const spark = typeof concept?.spark === "string" ? concept.spark : "";
	if (typeof concept?.spark !== "string" || spark.trim().length < 80 || spark.trim().length > 320) {
		errors.push(`concept ${id} needs a vivid creative spark of 80–320 characters`);
	}

	const webLeverage = typeof concept?.webLeverage === "string" ? concept.webLeverage : "";
	if (typeof concept?.webLeverage !== "string" || webLeverage.trim().length < 20 || webLeverage.trim().length > 240) {
		errors.push(`concept ${id} needs web leverage of 20–240 characters`);
	}

	if (/\b(?:live digital system|shared participatory system) modeled on\b/i.test(form)) {
		errors.push(`concept ${id} is a generic wrapper around another artifact`);
	}
	if (/\b(?:in the style of|styled like|copy of)\b/i.test(form)) {
		errors.push(`concept ${id} contains imitation language`);
	}
	if (BLAND_FORM_RE.test(form)) {
		errors.push(`concept ${id} is framed as a literal software or operations archetype instead of an inspiring visual world`);
	}

	return errors;
}

/**
 * Fingerprint of everything a reviewer judged. Reviews carry this hash, so an approval cannot
 * silently survive a content edit: the validator rejects any review whose hash no longer matches.
 */
function conceptContentHash(concept: ConceptEntry): string {
	const payload = [
		concept?.form ?? "",
		concept?.lineage ?? "",
		JSON.stringify(concept?.tags ?? []),
		JSON.stringify(concept?.system ?? []),
		concept?.spark ?? "",
		concept?.webLeverage ?? "",
	].join("\n");
	return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/** A concept merged with its family, well and review. */
interface MergedConcept extends ConceptEntry {
	readonly familyId: string;
	readonly familyLabel: string;
	readonly wellId: string | null;
	readonly wellLabel: string | null;
	readonly wellTier: string | null;
	readonly status: string;
	readonly review: Record<string, unknown> | null;
}

/** Read both files and merge every concept with its family, well and review. */
function readConceptCatalog(catalogPath: string, reviewsPath: string): {
	catalog: Record<string, unknown>;
	reviewData: Record<string, unknown>;
	reviews: Record<string, Record<string, unknown>>;
	concepts: MergedConcept[];
} {
	const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
		wells?: Array<{ id: string; label?: string; tier?: string }>;
		families?: Array<{ id: string; label?: string; well?: string; concepts?: ConceptEntry[] }>;
	};
	const reviewData = JSON.parse(readFileSync(reviewsPath, "utf8")) as { reviews?: Record<string, Record<string, unknown>> };
	const reviews = reviewData.reviews || {};
	const wellsById = new Map((catalog.wells || []).map((well) => [well.id, well]));
	const concepts: MergedConcept[] = [];

	for (const family of catalog.families || []) {
		for (const concept of family.concepts || []) {
			const well = family.well ? wellsById.get(family.well) : null;
			concepts.push({
				...concept,
				familyId: family.id,
				familyLabel: family.label ?? "",
				wellId: family.well ?? null,
				wellLabel: well?.label ?? null,
				wellTier: well?.tier ?? null,
				status: (reviews[concept.id ?? ""]?.status as string) || "pending",
				review: reviews[concept.id ?? ""] || null,
			});
		}
	}

	return { catalog: catalog as Record<string, unknown>, reviewData: reviewData as Record<string, unknown>, reviews, concepts };
}

/** What a catalog validation found. */
interface CatalogValidation {
	readonly errors: string[];
	readonly warnings: string[];
	readonly stats: {
		readonly wells: number;
		readonly families: number;
		readonly concepts: number;
		readonly approved: number;
		readonly pending: number;
		readonly rejected: number;
	};
}

interface ValidateCatalogOptions {
	readonly expectedTotal?: number;
	readonly minimumTotal?: number;
	readonly requireApprovedMinimum?: boolean;
}

/**
 * Everything wrong with a catalog and its reviews.
 *
 * The review checks matter most: a review that points at a concept whose content changed is
 * rejected rather than trusted, because a stale approval is an approval of something that no
 * longer exists.
 */
function validateConceptCatalog(
	catalog: Record<string, unknown> | null | undefined,
	reviewData: Record<string, unknown> | null | undefined,
	{ expectedTotal, minimumTotal, requireApprovedMinimum = true }: ValidateCatalogOptions = {},
): CatalogValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const familyIds = new Set<string>();
	const conceptIds = new Set<string>();
	const normalizedForms = new Map<string, string>();
	const concepts: ConceptEntry[] = [];

	const data = (catalog ?? {}) as {
		schemaVersion?: number;
		catalogVersion?: string;
		qualityBar?: { principle?: string; rejectIf?: unknown[]; reviewAxes?: unknown[] };
		families?: Array<{ id?: string; label?: string; well?: string; concepts?: ConceptEntry[] }>;
		wells?: Array<{ id?: string; label?: string; description?: string; tier?: string }>;
	};

	if (!Number.isInteger(data.schemaVersion) || (data.schemaVersion ?? 0) < 7) errors.push("catalog.schemaVersion must be 7 or newer");
	if (typeof data.catalogVersion !== "string" || !data.catalogVersion.trim()) errors.push("catalog.catalogVersion must be a non-empty string");
	if (typeof data.qualityBar?.principle !== "string" || data.qualityBar.principle.trim().length < 80) {
		errors.push("catalog.qualityBar.principle must define the universal creative bar");
	}
	if (!Array.isArray(data.qualityBar?.rejectIf) || data.qualityBar.rejectIf.length < 5) {
		errors.push("catalog.qualityBar.rejectIf must define at least five rejection gates");
	}
	if (!Array.isArray(data.qualityBar?.reviewAxes) || data.qualityBar.reviewAxes.length < 8) {
		errors.push("catalog.qualityBar.reviewAxes must define at least eight review axes");
	}
	if (!Array.isArray(data.families) || data.families.length < 3) errors.push("catalog.families must contain at least three families");

	const wellIds = new Set<string>();
	if (!Array.isArray(data.wells) || data.wells.length < 5) errors.push("catalog.wells must define at least five inspiration wells");
	for (const well of data.wells || []) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(well.id || "")) {
			errors.push(`invalid well id: ${String(well.id)}`);
		} else if (wellIds.has(well.id as string)) {
			errors.push(`duplicate well id: ${well.id}`);
		}
		wellIds.add(well.id as string);
		if (typeof well.label !== "string" || !well.label.trim()) errors.push(`well ${well.id || "(unknown)"} needs a label`);
		if (typeof well.description !== "string" || well.description.trim().length < 40) {
			errors.push(`well ${well.id || "(unknown)"} needs a description of at least 40 characters`);
		}
		if (!WELL_TIERS.includes(well.tier ?? "")) {
			errors.push(`well ${well.id || "(unknown)"} needs a tier of ${WELL_TIERS.join(", ")}, got: ${String(well.tier)}`);
		}
	}

	const tiersPresent = new Set((data.wells || []).map((well) => well.tier).filter((tier) => WELL_TIERS.includes(tier ?? "")));
	for (const tier of WELL_TIERS) {
		if ((data.wells || []).length > 0 && !tiersPresent.has(tier)) errors.push(`no well declares the ${tier} tier`);
	}

	const populatedWells = new Set<string>();
	for (const family of data.families || []) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(family.id || "")) {
			errors.push(`invalid family id: ${String(family.id)}`);
		} else if (familyIds.has(family.id as string)) {
			errors.push(`duplicate family id: ${family.id}`);
		}
		familyIds.add(family.id as string);
		if (typeof family.label !== "string" || !family.label.trim()) errors.push(`family ${family.id || "(unknown)"} needs a label`);

		if (!wellIds.has(family.well ?? "")) {
			errors.push(`family ${family.id || "(unknown)"} must belong to a declared well, got: ${String(family.well)}`);
		} else {
			populatedWells.add(family.well as string);
		}

		if (!Array.isArray(family.concepts) || family.concepts.length === 0) {
			errors.push(`family ${family.id || "(unknown)"} has no concepts`);
			continue;
		}

		for (const concept of family.concepts) {
			concepts.push(concept);
			if (conceptIds.has(concept.id as string)) errors.push(`duplicate concept id: ${concept.id}`);
			errors.push(...validateConceptEntry(concept, { existingForms: normalizedForms }));
			conceptIds.add(concept.id as string);

			const normalized = normalizeConceptForm(concept.form);
			if (normalized) normalizedForms.set(normalized, concept.id as string);

			if (typeof concept.webLeverage === "string" && !WEB_LEVERAGE_RE.test(concept.webLeverage)) {
				warnings.push(`concept ${concept.id} web leverage should be checked for a specific browser-native capability`);
			}
		}
	}

	for (const well of data.wells || []) {
		if (well.id && !populatedWells.has(well.id)) errors.push(`well ${well.id} has no families`);
	}

	if (expectedTotal !== undefined && concepts.length !== expectedTotal) errors.push(`expected ${expectedTotal} concepts, found ${concepts.length}`);
	if (minimumTotal !== undefined && concepts.length < minimumTotal) errors.push(`expected at least ${minimumTotal} concepts, found ${concepts.length}`);

	const reviews = (reviewData ?? {}) as { schemaVersion?: number; reviews?: Record<string, Record<string, unknown>> };
	if (!Number.isInteger(reviews.schemaVersion) || (reviews.schemaVersion ?? 0) < 2) errors.push("reviews.schemaVersion must be 2 or newer");

	const conceptsById = new Map(concepts.map((concept) => [concept.id as string, concept]));
	for (const [id, review] of Object.entries(reviews.reviews || {})) {
		if (!conceptIds.has(id)) errors.push(`review references missing concept: ${id}`);
		if (!CONCEPT_STATUSES.has(review?.status as string)) errors.push(`invalid review status for ${id}: ${String(review?.status)}`);
		if (typeof review?.reviewedBy !== "string" || !review.reviewedBy.trim()) errors.push(`review ${id} needs reviewedBy`);
		if (typeof review?.reviewedAt !== "string" || Number.isNaN(Date.parse(review.reviewedAt as string))) {
			errors.push(`review ${id} needs an ISO reviewedAt timestamp`);
		}

		if (typeof review?.formHash !== "string" || !review.formHash.trim()) {
			errors.push(`review ${id} needs a formHash of the reviewed content`);
		} else if (conceptsById.has(id) && review.formHash !== conceptContentHash(conceptsById.get(id) as ConceptEntry)) {
			// A stale approval approves something that no longer exists.
			errors.push(`review ${id} is stale: concept content changed since it was reviewed; reset or re-review it`);
		}

		if (review?.note !== undefined && (typeof review.note !== "string" || !review.note.trim() || (review.note as string).length > 500)) {
			errors.push(`review ${id} note must be a non-empty string of 500 characters or fewer`);
		}

		// Rating grades how strong an approved concept is. Approved-only, because a rating on a
		// rejection would read as a calibration signal it is not.
		if (review?.rating !== undefined) {
			if (![1, 2, 3].includes(review.rating as number)) errors.push(`review ${id} rating must be 1, 2, or 3`);
			else if (review.status !== "approved") errors.push(`review ${id} rating only applies to approved concepts`);
		}

		if (review?.breadth !== undefined && !CONCEPT_BREADTHS.has(review.breadth as string)) {
			errors.push(`review ${id} breadth must be one of ${[...CONCEPT_BREADTHS].join(", ")}`);
		}

		// Mode eligibility: absent means every mode, which is why it needs no backfill. Listing
		// every mode says the same as omitting it, and an empty list would deal nothing.
		if (review?.allowedModes !== undefined) {
			const modes = review.allowedModes;
			if (!Array.isArray(modes) || modes.length === 0) {
				errors.push(`review ${id} allowedModes must be a non-empty array, or omitted to allow every mode`);
			} else if (modes.some((mode) => !SEED_MODES.has(mode))) {
				errors.push(`review ${id} allowedModes may only contain ${[...SEED_MODES].join(", ")}`);
			} else if (new Set(modes).size !== modes.length) {
				errors.push(`review ${id} allowedModes must not repeat a mode`);
			} else if (modes.length === SEED_MODES.size) {
				errors.push(`review ${id} allowedModes lists every mode; omit the field instead`);
			}
		}
	}

	const wellTierById = new Map((data.wells || []).map((well) => [well.id, well.tier]));
	const approved = concepts.filter((concept) => reviews.reviews?.[concept.id as string]?.status === "approved");
	const approvedTiers = new Set(
		(data.families || [])
			.filter((family) => family.concepts?.some((concept) => reviews.reviews?.[concept.id as string]?.status === "approved"))
			.map((family) => wellTierById.get(family.well ?? ""))
			.filter((tier) => WELL_TIERS.includes(tier ?? "")),
	);

	if (requireApprovedMinimum && approved.length < 3) errors.push("at least three concepts must be approved");
	if (requireApprovedMinimum && approvedTiers.size < WELL_TIERS.length) errors.push("approved concepts must cover every challenger tier");

	return {
		errors,
		warnings,
		stats: {
			wells: wellIds.size,
			families: familyIds.size,
			concepts: concepts.length,
			approved: approved.length,
			pending: concepts.length - Object.keys(reviews.reviews || {}).length,
			rejected: Object.values(reviews.reviews || {}).filter((review) => review?.status === "rejected").length,
		},
	};
}

/** A revision of the approved pool: it changes whenever the pool a roll draws from changes. */
function approvedPoolRevision(concepts: readonly MergedConcept[]): string {
	const payload = concepts
		.filter((concept) => concept.status === "approved")
		.map(
			(concept) =>
				`${concept.familyId}:${concept.id}:${concept.strength}:${concept.form}:${concept.spark}:${JSON.stringify(concept.system)}:${concept.webLeverage}`,
		)
		.sort()
		.join("\n");
	return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

export {
	approvedPoolRevision,
	BLAND_FORM_RE,
	CONCEPT_BREADTHS,
	CONCEPT_STATUSES,
	CONCEPT_STRENGTHS,
	conceptContentHash,
	normalizeConceptForm,
	readConceptCatalog,
	SEED_MODES,
	SYSTEM_PREFIXES,
	validateConceptCatalog,
	validateConceptEntry,
	WEB_LEVERAGE_RE,
};
export type { CatalogValidation, ConceptEntry, MergedConcept };
