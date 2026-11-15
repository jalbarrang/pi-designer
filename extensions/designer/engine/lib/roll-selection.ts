/**
 * The one implementation of world-roll selection: which challengers and compositions a
 * direction round deals. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two copies of this logic used to exist and had drifted — one had no breadth gate and no
 * rating weighting, and since the catalog ships over an API, those gates reached nobody.
 *
 * Why generators: the two callers cannot agree on a hash. Node has a synchronous one, a worker
 * runtime only has async crypto, and the local render path is deliberately synchronous so tests
 * can call it without awaiting. So selection is written once as a generator that yields batches
 * of strings to hash and resumes with the digests; `runSyncSelection` and `runAsyncSelection` are
 * the only runtime-specific code, and both produce identical rolls because the digest inputs are
 * the same bytes.
 *
 * Nothing here reads a file, an environment variable, or the network: callers pass pools in.
 */

/** The grains a composition can declare: how much of the product is in play. */
const COMPOSITION_GRAINS: readonly string[] = [
	"product", // a whole site or app: its information architecture
	"flow", // a sequence of views with one outcome: onboarding, checkout, setup
	"view", // one page or screen
	"region", // a section inside a view: a hero, a feature grid, a table
];

/** The delivery targets a composition can declare it survives. */
const COMPOSITION_PLATFORMS: readonly string[] = ["web", "ios", "android"];

/** The three translation tiers every roll draws two challengers from. */
const WELL_TIERS: readonly string[] = ["graphic", "interaction", "atmosphere"];

/** True when the value is a known composition grain. */
function isGrain(value: unknown): boolean {
	return typeof value === "string" && COMPOSITION_GRAINS.includes(value);
}

/** True when the value is a known delivery target. */
function isPlatform(value: unknown): boolean {
	return typeof value === "string" && COMPOSITION_PLATFORMS.includes(value);
}

/** Drives a selection generator with a synchronous hash. */
function runSyncSelection<T>(generator: Generator<string[], T, string[]>, hash: (input: string) => string): T {
	let step = generator.next();
	while (!step.done) step = generator.next(step.value.map(hash));
	return step.value;
}

/** Drives a selection generator with an asynchronous hash. */
async function runAsyncSelection<T>(generator: Generator<string[], T, string[]>, hash: (input: string) => Promise<string>): Promise<T> {
	let step = generator.next();
	while (!step.done) step = generator.next(await Promise.all(step.value.map(hash)));
	return step.value;
}

interface HasId {
	readonly id: string;
}
/**
 * Ranks items by the digest of `${input}:${id}`, descending, with the id as a stable tiebreak.
 * Every needed digest is yielded in one batch so the async driver resolves them concurrently.
 */
function* rank<T>(items: readonly T[], input: string, idFor: (item: T) => string): Generator<string[], T[], string[]> {
	const ids = items.map(idFor);
	const digests = yield ids.map((id) => `${input}:${id}`);
	return items
		.map((item, index) => ({ item, id: ids[index], score: digests[index] }))
		.sort((a, b) => b.score.localeCompare(a.score) || a.id.localeCompare(b.id))
		.map((entry) => entry.item);
}

// Rating sets how many tickets a world holds; breadth decides whether it draws at all. A niche
// world leaves the pool however good it is, keeping its approval for direct briefs. Two tickets
// for a 3-star, one for everything else, proved too sharp: the thinnest tier is small enough
// that the same worlds kept coming back. So a 3-star no longer outdraws a 2-star, and a 1-star
// draws at half rather than not at all — a marginal keep is "narrow or unexceptional", not
// "wrong", and excluding it entirely would make rating do breadth's job.
const RATING_TICKETS: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 2 };
const ticketsForRating = (rating: number | undefined): number => RATING_TICKETS[rating ?? 2] ?? 2;

/** One review as these checks read it. */
interface RollReview {
	readonly breadth?: string;
	readonly rating?: number;
	readonly allowedModes?: readonly string[];
}

/** One catalog concept, as a challenger. */
export interface ChallengerConcept {
	readonly id: string;
	readonly status: string;
	readonly strength: string;
	readonly wellTier: string;
	readonly familyId: string;
	readonly review?: RollReview;
}

/** One catalog composition. */
export interface CompositionInput {
	readonly id: string;
	readonly status: string;
	readonly surface?: string;
	readonly grain?: string;
	readonly platforms?: readonly string[];
	readonly familyId?: string;
	readonly review?: RollReview;
}

interface ChallengerTicket {
	readonly concept: ChallengerConcept;
	readonly ticket: number;
}

interface CompositionTicket {
	readonly composition: CompositionInput;
	readonly ticket: number;
}

function challengerTickets(pool: readonly ChallengerConcept[]): ChallengerTicket[] {
	return pool.flatMap((concept) => {
		if (concept.review?.breadth === "niche") return [];
		return Array.from({ length: ticketsForRating(concept.review?.rating) }, (_, ticket) => ({ concept, ticket }));
	});
}

function compositionTickets(pool: readonly CompositionInput[]): CompositionTicket[] {
	return pool.flatMap((composition) =>
		Array.from({ length: ticketsForRating(composition.review?.rating) }, (_, ticket) => ({ composition, ticket })),
	);
}

// A world with no allowedModes is eligible everywhere, which keeps the filter additive: nothing
// has to be backfilled for it to be safe.
function modeAllows(concept: ChallengerConcept, mode: string): boolean {
	const allowed = concept.review?.allowedModes;
	if (!Array.isArray(allowed) || allowed.length === 0) return true;
	return allowed.includes(mode);
}

export interface ChallengerSelectionOptions {
	readonly scope: "direction" | "surface";
	readonly key: string;
	readonly reroll?: number;
	/** Optional floor, skipped per tier it would empty. */
	readonly minRating?: number | null;
	readonly mode?: string | null;
	readonly concepts: readonly ChallengerConcept[];
}

export interface ChallengerSelection {
	readonly approved: ChallengerConcept[];
	readonly picks: ChallengerConcept[];
}

/**
 * Six challengers, two per translation tier, from an explicit approved pool.
 *
 * Direction chooses a durable identity, so it draws worlds; surface designs one page inside a
 * committed identity, so it draws compositions, and duals serve both. A tier with no
 * matching-strength approvals falls back to its full approved pool rather than starving the
 * roll.
 */
function* selectApprovedChallengers({
	scope,
	key,
	reroll = 0,
	minRating = null,
	mode = null,
	concepts,
}: ChallengerSelectionOptions): Generator<string[], ChallengerSelection, string[]> {
	const approved = concepts.filter((concept) => concept.status === "approved");
	const wanted = scope === "direction" ? new Set(["world", "dual"]) : new Set(["composition", "dual"]);

	const approvedByTier = new Map<string, ChallengerConcept[]>();
	for (const concept of approved) {
		const tier = approvedByTier.get(concept.wellTier) ?? [];
		tier.push(concept);
		approvedByTier.set(concept.wellTier, tier);
	}
	if (WELL_TIERS.some((tier) => (approvedByTier.get(tier) ?? []).length === 0)) {
		throw new Error("concept-seed: every challenger tier needs at least one approved concept");
	}

	if (minRating) {
		for (const [tier, pool] of approvedByTier) {
			const rated = pool.filter((concept) => (concept.review?.rating || 0) >= minRating);
			if (rated.length > 0) approvedByTier.set(tier, rated);
		}
	}

	// Mode eligibility, per tier and skipped where it would empty one. A world is an identity
	// and identities transfer further than compositions, so this is a ceiling the reviewer sets
	// rather than a category assignment.
	if (mode) {
		for (const [tier, pool] of approvedByTier) {
			const eligible = pool.filter((concept) => modeAllows(concept, mode));
			if (eligible.length > 0) approvedByTier.set(tier, eligible);
		}
	}

	for (const [tier, pool] of approvedByTier) {
		const matching = pool.filter((concept) => wanted.has(concept.strength));
		if (matching.length > 0) approvedByTier.set(tier, matching);
	}

	// Two challengers per tier, so every roll carries near-zero-translation graphic systems
	// beside instrument languages and atmosphere worlds, with the second pick preferring a
	// different family. Tier order is rolled too, to avoid positional bias.
	function* pickRound(round: number, excluded: Set<string>): Generator<string[], ChallengerConcept[], string[]> {
		const salt = round === 0 ? "" : `:reroll-${round}`;
		const tierOrder = (yield* rank(
			WELL_TIERS.map((id) => ({ id })),
			`${scope}:${key}:tiers${salt}`,
			(item) => item.id,
		)).map((item) => item.id);

		const picks: ChallengerConcept[] = [];
		for (const [index, tier] of tierOrder.entries()) {
			let pool = (approvedByTier.get(tier) ?? []).filter((concept) => !excluded.has(concept.id));
			// A tier exhausted by prior rounds falls back to reuse over starvation.
			if (pool.length === 0) pool = approvedByTier.get(tier) ?? [];

			let tickets = challengerTickets(pool);
			if (tickets.length === 0) tickets = pool.map((concept) => ({ concept, ticket: 0 }));

			const ranked = yield* rank(tickets, `${scope}:${key}:challenger-${index}${salt}`, (entry) => `${entry.concept.id}#${entry.ticket}`);

			const order: ChallengerConcept[] = [];
			const seen = new Set<string>();
			for (const entry of ranked) {
				if (seen.has(entry.concept.id)) continue;
				seen.add(entry.concept.id);
				order.push(entry.concept);
			}

			const first = order[0];
			const second = order.find((concept) => concept.familyId !== first.familyId) ?? order.find((concept) => concept.id !== first.id);
			picks.push(...(second ? [first, second] : [first]));
		}
		return picks;
	}

	// Round n of a re-roll chain excludes everything rounds 0..n-1 drew, so the same base key
	// reproduces the whole chain.
	const excluded = new Set<string>();
	let picks = yield* pickRound(0, excluded);
	for (let round = 1; round <= reroll; round += 1) {
		for (const pick of picks) excluded.add(pick.id);
		picks = yield* pickRound(round, excluded);
	}

	return { approved, picks };
}

/** How well a composition deal matched the request. Reported so a borrow is never silent. */
export interface CompositionMatch {
	readonly grain: string | null;
	/** How many dealt compositions actually sit at the requested grain. */
	readonly atGrain: number | null;
	readonly grainAvailable: number | null;
	readonly platform: string | null;
	readonly platformExcluded: number;
}

export interface CompositionSelection {
	readonly picks: CompositionInput[];
	 readonly match: CompositionMatch;
}

function emptyMatch(grain: string | null, platform: string | null, platformExcluded = 0): CompositionMatch {
	return { grain: grain ?? null, atGrain: grain ? 0 : null, grainAvailable: grain ? 0 : null, platform: platform ?? null, platformExcluded };
}

export interface CompositionSelectionOptions {
	readonly scope: "direction" | "surface";
	readonly key: string;
	readonly reroll?: number;
	readonly mode?: string | null;
	readonly grain?: string | null;
	readonly platform?: string | null;
	readonly compositions: readonly CompositionInput[];
	readonly count?: number;
}

/**
 * Three identity-free composition inputs from an explicit approved pool.
 *
 * One input was too weak a counterweight to a model's habitual page skeleton: it became a single
 * optional flourish beside six identity challengers rather than a search over composition.
 * Distinct families are preferred so a roll tests materially different hierarchy, sequence, and
 * interaction laws. An absent mode returns nothing rather than borrowing across modes, because a
 * cross-mode fallback would make the input misleading.
 */
function* selectApprovedCompositions({
	scope,
	key,
	reroll = 0,
	mode = null,
	grain = null,
	platform = null,
	compositions,
	count = 3,
}: CompositionSelectionOptions): Generator<string[], CompositionSelection, string[]> {
	// Compositions honour the same breadth gate as worlds, with a full-set fallback rather than
	// an empty deal when every approved composition is niche.
	let approved = compositions.filter((composition) => composition.status === "approved");
	const broad = approved.filter((composition) => composition.review?.breadth !== "niche");
	if (broad.length > 0) approved = broad;
	if (approved.length === 0) return { picks: [], match: emptyMatch(grain, platform) };

	if (mode) {
		const matching = approved.filter((composition) => composition.surface === mode);
		if (matching.length === 0) return { picks: [], match: emptyMatch(grain, platform) };
		approved = matching;
	}

	// Platform is a hard filter, unlike grain: a composition that needs hover does not degrade on
	// a phone into something slightly worse, it stops working. No fallback here either — an
	// empty deal is a visible gap, a hover-only composition on a phone is a defect.
	let platformExcluded = 0;
	if (platform) {
		const survives = approved.filter((composition) => {
			const only = composition.platforms;
			return !Array.isArray(only) || only.length === 0 || only.includes(platform);
		});
		platformExcluded = approved.length - survives.length;
		approved = survives;
		if (approved.length === 0) return { picks: [], match: emptyMatch(grain, platform, platformExcluded) };
	}

	const prior = new Set<string>();
	let picks: CompositionInput[] = [];

	for (let round = 0; round <= reroll; round += 1) {
		const available = approved.filter((composition) => !prior.has(composition.id));
		const base = available.length >= Math.min(count, approved.length) ? available : approved;

		// Rating weights the draw as it does for worlds, and matters more here because the
		// per-surface pools are small. Each ticket carries its index so the rank sees a distinct
		// key per ticket: ranking bare duplicates would hash identically, and the id-dedupe below
		// would discard the second copy, making the weighting a no-op.
		let tickets = compositionTickets(base);
		if (tickets.length === 0) tickets = base.map((composition) => ({ composition, ticket: 0 }));

		const ranked = (
			yield* rank(
				tickets,
				// The salt keeps the word "staging" deliberately: it is hash input, so renaming it
				// would re-deal every roll anyone has ever reproduced by key.
				round === 0 ? `${scope}:${key}:staging` : `${scope}:${key}:staging:reroll-${round}`,
				(entry) => `${entry.composition.id}#${entry.ticket}`,
			)
		).map((entry) => entry.composition);

		// Grain is a preference, not a filter: a requested grain is dealt first and topped up from
		// the rest of the register rather than dealing fewer. The top-up is why `match` is
		// reported — dealing three plausible view-grain compositions against a flow request with
		// no signal would be the silent-plausibility failure this axis exists to fix.
		const ordered = grain
			? [...ranked.filter((composition) => composition.grain === grain), ...ranked.filter((composition) => composition.grain !== grain)]
			: ranked;

		const families = new Set<string>();
		picks = [];
		for (const composition of ordered) {
			const family = composition.familyId ?? composition.id;
			if (families.has(family)) continue;
			picks.push(composition);
			families.add(family);
			if (picks.length >= count) break;
		}
		for (const composition of ordered) {
			if (picks.length >= count) break;
			if (!picks.some((pick) => pick.id === composition.id)) picks.push(composition);
		}

		if (round < reroll) for (const composition of picks) prior.add(composition.id);
	}

	const atGrain = grain ? picks.filter((composition) => composition.grain === grain).length : null;
	return {
		picks,
		match: {
			grain: grain ?? null,
			atGrain,
			grainAvailable: grain ? approved.filter((composition) => composition.grain === grain).length : null,
			platform: platform ?? null,
			platformExcluded,
		},
	};
}

export {
	COMPOSITION_GRAINS,
	COMPOSITION_PLATFORMS,
	isGrain,
	isPlatform,
	runAsyncSelection,
	runSyncSelection,
	selectApprovedChallengers,
	selectApprovedCompositions,
	WELL_TIERS,
};
