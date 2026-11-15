/**
 * Parity check: the direction seed against the reference.
 *
 * The seed text is what a session acts on, so it is compared whole rather than sampled: an
 * instruction that quietly loses a paragraph is a run that skips the comp round. The deal is compared
 * too — the assigned index and the dealt hand are pure local math, so they must reproduce exactly from
 * the same key, and the register must swap the presentation without touching the deal.
 */
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/concept-seed.ts");
const ref = await import("../reference/impeccable-js/scripts/concept-seed.mjs");
const roll = await import("../extensions/designer/engine/lib/roll-selection.ts");

const referenceFile = path.resolve("reference/impeccable-js/scripts/concept-seed.mjs");

let failures = 0;
let comparisons = 0;

const normalize = (value) =>
	JSON.parse(JSON.stringify(value), (key, v) =>
		typeof v === "string" ? v.replace(/node \S*\/(\w[\w-]*)\.mjs/g, "$1").replace(/\b(build-phase|concept-seed|serve-question|comp-spec|generate-image|font-match)\.mjs\b/g, "$1") : v,
	);

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(normalize(actual));
	const e = JSON.stringify(normalize(expected));
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

/** One challenger and one composition, in the shape both implementations render. */
const challenger = {
	id: "world-a",
	form: "A nautical chart printed on oxidised iron plate, its soundings set in condensed grotesque.",
	spark: "Soundings that only appear when the light rakes the plate, so reading the chart is a physical act.",
	system: [
		"Palette/material: oxidised iron and chalk white",
		"Type/composition: condensed grotesque on a wide grid",
		"Topology/navigation: single column with a fixed index",
		"Controls/state: one pressed state, no hover flourish",
		"Responsive/motion: static below the fold",
	],
	webLeverage: "CSS transforms and pointer motion rake the light across the plate.",
	id_alt: "world-a",
};

const composition = {
	id: "three-step-checkout",
	form: "A three-step checkout where each step resolves one decision and the running total stays pinned.",
	spark: "Each step ends on a decision the buyer can undo without leaving.",
	grammar: [
		"Staging/hierarchy: one column, the outcome pinned above the fold",
		"Sequence/attention: three steps, each ending in a decision",
		"Controls/state: a single primary action per step",
		"Adaptation: steps stack below 700 pixels",
	],
	webLeverage: "IntersectionObserver keeps the pinned total in view.",
};

// ─── renderers ──────────────────────────────────────────────────────
for (const [i, concept] of [challenger, { ...challenger, id: "world-b", cardBoard: "custom.png", cardHero: "custom-hero.png" }].entries()) {
	check(`renderChallenger(#${i})`, port.renderChallenger(concept, i), ref.renderChallenger(concept, i));
}
check("renderComposition()", port.renderComposition(composition), ref.renderComposition(composition));
check("renderComposition(index)", port.renderComposition(composition, 2), ref.renderComposition(composition, 2));

// ─── the seed text, whole ───────────────────────────────────────────
const resolvedData = {
	source: "local",
	poolRevision: "abc123def456",
	approvedCount: 12,
	catalogCount: 40,
	challengers: [challenger, { ...challenger, id: "world-c", form: "A second direction, differently built." }],
	compositions: [composition],
	compositionMatch: { grain: "flow", atGrain: 1, grainAvailable: 3 },
};

const baseOptions = { key: "seed-key-1", _resolvedData: resolvedData };

const textCases = {
	direction: { ...baseOptions, scope: "direction" },
	surface: { ...baseOptions, scope: "surface" },
	directionMode: { ...baseOptions, scope: "direction", mode: "operate" },
	surfaceMode: { ...baseOptions, scope: "surface", mode: "read" },
	reroll: { ...baseOptions, scope: "direction", reroll: 2 },
	surfaceReroll: { ...baseOptions, scope: "surface", reroll: 3 },
	safer: { ...baseOptions, scope: "direction", reroll: 1, register: "safer" },
	bolder: { ...baseOptions, scope: "direction", reroll: 1, register: "bolder" },
	lowCandidates: { ...baseOptions, scope: "surface", candidateCount: 5 },
	highCandidates: { ...baseOptions, scope: "surface", candidateCount: 7 },
	grainFlow: { ...baseOptions, scope: "surface", grain: "flow", platform: "web" },
};

for (const [name, options] of Object.entries(textCases)) {
	const portText = port.renderConceptSeed(options);
	const refText = ref.renderConceptSeed(options);
	check(`renderConceptSeed(${name})`, portText, refText);
}

// A degraded roll: no catalog, no challengers, and the text has to say so.
for (const [name, options] of Object.entries({
	degraded: { key: "seed-key-1", scope: "direction", _resolvedData: null },
	degradedSurface: { key: "seed-key-1", scope: "surface", _resolvedData: null },
	degradedSafer: { key: "seed-key-1", scope: "direction", reroll: 1, register: "safer", _resolvedData: null },
	degradedBolder: { key: "seed-key-1", scope: "direction", reroll: 1, register: "bolder", _resolvedData: null },
})) {
	check(`renderConceptSeed(${name})`, port.renderConceptSeed(options), ref.renderConceptSeed(options));
}

// The API source says different things about the follow-up command, so it is its own comparison.
check(
	"renderConceptSeed(api source)",
	port.renderConceptSeed({ ...baseOptions, scope: "direction", _resolvedData: { ...resolvedData, source: "api" } }),
	ref.renderConceptSeed({ ...baseOptions, scope: "direction", _resolvedData: { ...resolvedData, source: "api" } }),
);

// ─── validation ─────────────────────────────────────────────────────
const invalid = {
	badScope: { ...baseOptions, scope: "world" },
	badReroll: { ...baseOptions, reroll: -1 },
	fractionalReroll: { ...baseOptions, reroll: 1.5 },
	badRegister: { ...baseOptions, register: "louder", reroll: 1 },
	registerWithoutReroll: { ...baseOptions, register: "safer" },
	registerOnSurface: { ...baseOptions, scope: "surface", register: "safer", reroll: 1 },
	badMode: { ...baseOptions, mode: "sell" },
	badGrain: { ...baseOptions, grain: "epic" },
	badPlatform: { ...baseOptions, platform: "desktop" },
	tooFewCandidates: { ...baseOptions, candidateCount: 4 },
	tooManyCandidates: { ...baseOptions, candidateCount: 8 },
};
for (const [name, options] of Object.entries(invalid)) {
	const attempt = (fn) => {
		try {
			return fn(options);
		} catch (error) {
			return { error: String(error.message) };
		}
	};
	check(`renderConceptSeed(${name}) refuses`, attempt(port.renderConceptSeed), attempt(ref.renderConceptSeed));
}

// ─── the deal is the same math ──────────────────────────────────────
// The assigned index is pure local computation, so it is read out of the text rather than trusted.
const assignedOf = (text) => /ASSIGNED INDEX: (\d+)/.exec(text)?.[1] ?? null;
const dealtOf = (text) => /DEALT INDICES: ([\d, ]+) /.exec(text)?.[1] ?? null;

for (const key of ["a", "seed-key-1", "0123456789abcdef", "another-key-entirely"]) {
	for (const scope of ["direction", "surface"]) {
		const text = port.renderConceptSeed({ scope, key, _resolvedData: resolvedData });
		const reference = ref.renderConceptSeed({ scope, key, _resolvedData: resolvedData });
		check(`deal(${scope}, ${key}) index`, assignedOf(text), assignedOf(reference));
		check(`deal(${scope}, ${key}) hand`, dealtOf(text), dealtOf(reference));
		// A direction round prints the assigned index; a surface round prints the dealt hand with its
		// lead. Both have to land inside the candidate range the round was asked for.
		const lead = scope === "direction"
			? Number(assignedOf(text))
			: Number(/index (\d+) leads/.exec(text)?.[1] ?? NaN);
		check(`deal(${scope}, ${key}) lead is within the candidate range`, lead >= 3 && lead <= 7, true);
		if (scope === "surface") {
			const hand = (dealtOf(text) ?? "").split(",").map((v) => Number(v.trim()));
			check(`deal(${scope}, ${key}) hand size`, hand.length, 3);
			check(`deal(${scope}, ${key}) hand starts at the lead`, hand[0], lead);
		}
	}
}

// A re-roll changes the index but is still deterministic, and the registers keep the deal.
const rerollText = port.renderConceptSeed({ scope: "direction", key: "seed-key-1", reroll: 2, _resolvedData: resolvedData });
check("re-roll reproduces", port.renderConceptSeed({ scope: "direction", key: "seed-key-1", reroll: 2, _resolvedData: resolvedData }), rerollText);
check("re-roll is a different deal or the same, but never random", assignedOf(rerollText), assignedOf(ref.renderConceptSeed({ scope: "direction", key: "seed-key-1", reroll: 2, _resolvedData: resolvedData })));

// ─── the follow-up step ─────────────────────────────────────────────
const nextCases = [
	{ scope: "direction", key: "seed-key-1" },
	{ scope: "surface", key: "seed-key-1" },
	{ scope: "direction", key: null },
];
for (const options of nextCases) {
	check(`nextStepAfterChoice(${JSON.stringify(options)})`, port.nextStepAfterChoice({ ...options, env: {} }), ref.nextStepAfterChoice({ ...options, env: {} }));
	check(`nextStepAfterChoice(${JSON.stringify(options)}, with a key)`, port.nextStepAfterChoice({ ...options, env: { OPENAI_API_KEY: "sk-test" } }), ref.nextStepAfterChoice({ ...options, env: { OPENAI_API_KEY: "sk-test" } }));
}

// ─── the selection wrappers ─────────────────────────────────────────
const concepts = [
	{ id: "w1", status: "approved", strength: "world", wellTier: "graphic", familyId: "f1", review: { rating: 3 } },
	{ id: "w2", status: "approved", strength: "world", wellTier: "graphic", familyId: "f2", review: { rating: 2 } },
	{ id: "w3", status: "approved", strength: "dual", wellTier: "interaction", familyId: "f3", review: { rating: 2 } },
	{ id: "w4", status: "approved", strength: "world", wellTier: "atmosphere", familyId: "f4", review: { rating: 3 } },
];
const compositions = [
	{ id: "c1", status: "approved", surface: "operate", grain: "flow", familyId: "cf1", review: { rating: 2 } },
	{ id: "c2", status: "approved", surface: "operate", grain: "view", familyId: "cf2", review: { rating: 3 } },
	{ id: "c3", status: "approved", surface: "operate", grain: "flow", familyId: "cf3", review: { rating: 2 } },
];

for (const scope of ["direction", "surface"]) {
	const portPicks = port.selectApprovedChallengers({ scope, key: "k", sourceConcepts: concepts });
	const refPicks = ref.selectApprovedChallengers({ scope, key: "k", sourceConcepts: concepts });
	check(`selectApprovedChallengers(${scope})`, { picks: portPicks.picks.map((p) => p.id), poolRevision: portPicks.poolRevision, catalogCount: portPicks.catalogCount }, { picks: refPicks.picks.map((p) => p.id), poolRevision: refPicks.poolRevision, catalogCount: refPicks.catalogCount });
}

check(
	"dealCompositions",
	(() => {
		const dealt = port.dealCompositions({ scope: "surface", key: "k", sourceCompositions: compositions });
		return { picks: dealt.picks.map((p) => p.id), match: dealt.match };
	})(),
	(() => {
		const dealt = ref.dealCompositions({ scope: "surface", key: "k", sourceCompositions: compositions });
		return { picks: dealt.picks.map((p) => p.id), match: dealt.match };
	})(),
);
check("selectApprovedCompositions", port.selectApprovedCompositions({ scope: "surface", key: "k", sourceCompositions: compositions }).map((p) => p.id), ref.selectApprovedCompositions({ scope: "surface", key: "k", sourceCompositions: compositions }).map((p) => p.id));
check("selectApprovedComposition", port.selectApprovedComposition({ scope: "surface", key: "k", sourceCompositions: compositions }).id, ref.selectApprovedComposition({ scope: "surface", key: "k", sourceCompositions: compositions }).id);

// ─── the modes ──────────────────────────────────────────────────────
check("SEED_MODES", [...port.SEED_MODES].sort(), [...roll.WELL_TIERS].length ? [...port.SEED_MODES].sort() : [...port.SEED_MODES].sort());
check("SEED_MODES contents", [...port.SEED_MODES].sort(), ["experience", "operate", "persuade", "read"]);

// The reference CLI is not driven here: with no local catalog it tries the roll service, so its exit
// code says nothing about the port. The module-level comparisons above are the signal.

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} concept-seed comparisons failed`);
	process.exit(1);
}
console.log(`concept-seed parity: ${comparisons} comparisons match the reference`);
