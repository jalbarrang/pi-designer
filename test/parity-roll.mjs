/**
 * Parity check: the world roll against the reference.
 *
 * The roll is what stops every run converging on the category default, and it is reproducible
 * by key: the same key must deal the same challengers and compositions, re-roll chain included.
 * These comparisons drive both implementations with the same synchronous hash and compare the
 * whole result, so a salt rename or a ticket-weighting slip would show up as a different deal.
 */
import { createHash } from "node:crypto";
import * as port from "../extensions/designer/engine/lib/roll-selection.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/roll-selection.mjs";

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const hash = (input) => createHash("sha256").update(input).digest("hex");

// A catalog with every tier, a spread of ratings, one niche world, one dual, and modes.
const concepts = [
	{ id: "world-a", status: "approved", strength: "world", wellTier: "graphic", familyId: "fam-a", review: { rating: 3 } },
	{ id: "world-b", status: "approved", strength: "world", wellTier: "graphic", familyId: "fam-a", review: { rating: 1 } },
	{ id: "world-c", status: "approved", strength: "world", wellTier: "interaction", familyId: "fam-c", review: { rating: 2 } },
	{ id: "world-d", status: "approved", strength: "world", wellTier: "interaction", familyId: "fam-d", review: { rating: 2, allowedModes: ["operate"] } },
	{ id: "world-e", status: "approved", strength: "world", wellTier: "atmosphere", familyId: "fam-e", review: { rating: 3 } },
	{ id: "world-f", status: "approved", strength: "dual", wellTier: "atmosphere", familyId: "fam-f", review: { rating: 2, breadth: "niche" } },
	{ id: "comp-a", status: "approved", strength: "composition", wellTier: "graphic", familyId: "cfam-a", review: { rating: 2 } },
	{ id: "draft-x", status: "draft", strength: "world", wellTier: "graphic", familyId: "fam-x" },
];

for (const scope of ["direction", "surface"]) {
	for (const reroll of [0, 1, 2]) {
		for (const mode of [null, "operate", "persuade"]) {
			for (const minRating of [null, 2]) {
				const options = { scope, key: "roll-key", reroll, minRating, mode, concepts };
				let portResult;
				let refResult;
				try {
					portResult = port.runSyncSelection(port.selectApprovedChallengers(options), hash);
				} catch (error) {
					portResult = { error: String(error.message) };
				}
				try {
					refResult = ref.runSyncSelection(ref.selectApprovedChallengers(options), hash);
				} catch (error) {
					refResult = { error: String(error.message) };
				}
				check(
					`selectApprovedChallengers(${scope}, reroll ${reroll}, mode ${mode}, min ${minRating})`,
					portResult.error ? portResult : portResult.picks.map((p) => p.id),
					refResult.error ? refResult : refResult.picks.map((p) => p.id),
				);
			}
		}
	}
}

// A missing tier is an error both sides report.
check(
	"selectApprovedChallengers(empty tier)",
	(() => {
		try {
			return port.runSyncSelection(port.selectApprovedChallengers({ scope: "direction", key: "k", concepts: [concepts[0]] }), hash);
		} catch (error) {
			return { error: String(error.message) };
		}
	})(),
	(() => {
		try {
			return ref.runSyncSelection(ref.selectApprovedChallengers({ scope: "direction", key: "k", concepts: [concepts[0]] }), hash);
		} catch (error) {
			return { error: String(error.message) };
		}
	})(),
);

const compositions = [
	{ id: "c1", status: "approved", surface: "operate", grain: "view", familyId: "f1", review: { rating: 2 } },
	{ id: "c2", status: "approved", surface: "operate", grain: "flow", familyId: "f2", review: { rating: 3 } },
	{ id: "c3", status: "approved", surface: "operate", grain: "flow", familyId: "f2", review: { rating: 1 }, platforms: ["web"] },
	{ id: "c4", status: "approved", surface: "operate", grain: "surface", familyId: "f4", review: { rating: 2, breadth: "niche" } },
	{ id: "c5", status: "approved", surface: "persuade", grain: "view", familyId: "f5", review: { rating: 2 } },
	{ id: "c6", status: "approved", surface: "operate", grain: "flow", familyId: "f6", platforms: ["ios"], review: { rating: 2 } },
];

for (const reroll of [0, 1, 3]) {
	for (const mode of [null, "operate", "read"]) {
		for (const grain of [null, "view", "flow"]) {
			for (const platform of [null, "web", "ios"]) {
				const options = { scope: "surface", key: "comp-key", reroll, mode, grain, platform, compositions };
				check(
					`selectApprovedCompositions(reroll ${reroll}, mode ${mode}, grain ${grain}, platform ${platform})`,
					(() => {
						const result = port.runSyncSelection(port.selectApprovedCompositions(options), hash);
						return { ids: result.picks.map((p) => p.id), match: result.match };
					})(),
					(() => {
						const result = ref.runSyncSelection(ref.selectApprovedCompositions(options), hash);
						return { ids: result.picks.map((p) => p.id), match: result.match };
					})(),
				);
			}
		}
	}
}

// An async driver produces the same deal as the sync one.
const asyncHash = async (input) => hash(input);
const syncDeal = port.runSyncSelection(port.selectApprovedCompositions({ scope: "surface", key: "comp-key", compositions }), hash);
const asyncDeal = await port.runAsyncSelection(port.selectApprovedCompositions({ scope: "surface", key: "comp-key", compositions }), asyncHash);
check("runAsyncSelection matches runSyncSelection", asyncDeal.picks.map((p) => p.id), syncDeal.picks.map((p) => p.id));
check("runAsyncSelection matches the reference", asyncDeal.picks.map((p) => p.id), ref.runSyncSelection(ref.selectApprovedCompositions({ scope: "surface", key: "comp-key", compositions }), hash).picks.map((p) => p.id));

// Grain and platform predicates.
for (const value of ["view", "flow", "surface", "web", "nope", null, 3]) {
	check(`isGrain(${JSON.stringify(value)})`, port.isGrain(value), ref.isGrain(value));
	check(`isPlatform(${JSON.stringify(value)})`, port.isPlatform(value), ref.isPlatform(value));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} roll-selection comparisons failed`);
	process.exit(1);
}
console.log(`roll-selection parity: ${comparisons} comparisons match the reference`);
