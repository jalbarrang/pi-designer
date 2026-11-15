/**
 * Parity check: the concept catalog validators against the reference.
 *
 * The catalog is what a roll draws from, and its validator is the only thing between a typo and
 * a silently wrong pool: a bad mode reads as "unrecorded", a stale formHash approves content
 * that no longer exists. These comparisons run whole catalogs and review sets through both
 * implementations and compare every error string, because the messages are what a maintainer
 * acts on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const port = await import("../extensions/designer/engine/lib/concept-catalog.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/concept-catalog.mjs");

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

// ─── form normalization ─────────────────────────────────────────────
for (const value of ["  Café—Poster  ", "Ünïcode // Solid", "", null, undefined, "ALL CAPS"]) {
	check(`normalizeConceptForm(${JSON.stringify(value)})`, port.normalizeConceptForm(value), ref.normalizeConceptForm(value));
}

// ─── one valid concept, then each way it can break ──────────────────
const validSystem = [
	"Palette/material: oxidised iron and chalk white",
	"Type/composition: condensed grotesque on a wide grid",
	"Topology/navigation: single column with a fixed index",
	"Controls/state: one pressed state, no hover flourish",
	"Responsive/motion: static below the fold",
];

const validConcept = {
	id: "oxidised-iron-chart",
	form: "A nautical chart printed on oxidised iron plate, its soundings set in condensed grotesque and its margins ruled as a single wide grid.",
	lineage: "portolan charts, naval plotting sheets",
	strength: "world",
	tags: ["nautical", "metal", "indexical"],
	system: validSystem,
	spark: "Soundings that only appear when the light rakes the plate at the right angle, so reading the chart is a physical act rather than a glance.",
	webLeverage: "CSS transforms and pointer motion can rake the light across the plate.",
	avoid: ["a literal dashboard of gauges and dials", "gradients standing in for material depth"],
};

const cases = {
	valid: validConcept,
	badId: { ...validConcept, id: "Not A Slug" },
	noForm: { ...validConcept, form: undefined },
	shortForm: { ...validConcept, form: "too short" },
	noComma: { ...validConcept, form: "A form with plenty of length but no comma so the inherited structure is missing entirely." },
	imitation: { ...validConcept, form: `${validConcept.form} Styled like a Swiss poster.` },
	wrapper: { ...validConcept, form: `${validConcept.form} A live digital system modeled on shipping.` },
	bland: { ...validConcept, form: `${validConcept.form} Essentially a control room for the crew.` },
	badStrength: { ...validConcept, strength: "identity" },
	twoTags: { ...validConcept, tags: ["nautical", "metal"] },
	badAvoid: { ...validConcept, avoid: ["short"] },
	fourRules: { ...validConcept, system: validSystem.slice(0, 4) },
	dupeRules: { ...validConcept, system: [validSystem[0], validSystem[0], validSystem[2], validSystem[3], validSystem[4]] },
	wrongOrder: { ...validConcept, system: [validSystem[1], validSystem[0], validSystem[2], validSystem[3], validSystem[4]] },
	shortSpark: { ...validConcept, spark: "too short" },
	badLeverage: { ...validConcept, webLeverage: "short" },
	areaLeverage: { ...validConcept, webLeverage: "A canvas with a resize observer reacting to the viewport." },
	badAxesShape: { ...validConcept, axes: ["depth"] },
	unknownAxis: { ...validConcept, axes: { depth: "flat" } },
	unknownAxisValue: { ...validConcept, axes: { depth: "invented" } },
};

const axes = {
	axes: [
		{ id: "depth", values: [{ id: "flat" }, { id: "layered" }] },
		{ id: "motion", values: [{ id: "still" }, { id: "kinetic" }] },
	],
};

for (const [name, concept] of Object.entries(cases)) {
	check(`validateConceptEntry(${name})`, port.validateConceptEntry(concept, { axes }), ref.validateConceptEntry(concept, { axes }));
	check(`conceptContentHash(${name})`, port.conceptContentHash(concept), ref.conceptContentHash(concept));
}

// A duplicate form is caught against the forms already seen.
const seen = new Map([[port.normalizeConceptForm(validConcept.form), "first-concept"]]);
check(
	"validateConceptEntry(duplicate form)",
	port.validateConceptEntry(validConcept, { existingForms: seen }),
	ref.validateConceptEntry(validConcept, { existingForms: seen }),
);

// ─── whole catalogs ─────────────────────────────────────────────────
const well = (id, tier) => ({ id, label: id, description: "A description long enough to pass the forty character floor.", tier });
const conceptIn = (id, strength = "world") => ({ ...validConcept, id, form: `${validConcept.form} Variant ${id}.`, strength });

const makeCatalog = (overrides = {}) => ({
	schemaVersion: 7,
	catalogVersion: "test-1",
	qualityBar: {
		principle: "A principle long enough to clear the eighty character floor, stating the universal creative bar for every entry.",
		rejectIf: ["a", "b", "c", "d", "e"],
		reviewAxes: ["a", "b", "c", "d", "e", "f", "g", "h"],
	},
	wells: [well("graphic-w", "graphic"), well("interaction-w", "interaction"), well("atmosphere-w", "atmosphere")],
	families: [
		{ id: "fam-g", label: "Graphic", well: "graphic-w", concepts: [conceptIn("concept-g")] },
		{ id: "fam-i", label: "Interaction", well: "interaction-w", concepts: [conceptIn("concept-i", "dual")] },
		{ id: "fam-a", label: "Atmosphere", well: "atmosphere-w", concepts: [conceptIn("concept-a")] },
	],
	...overrides,
});

const makeReviews = (catalog, tweak = (reviews) => reviews) => {
	const reviews = {};
	for (const family of catalog.families || []) {
		for (const concept of family.concepts || []) {
			reviews[concept.id] = {
				status: "approved",
				reviewedBy: "reviewer",
				reviewedAt: "2024-01-01T00:00:00.000Z",
				formHash: port.conceptContentHash(concept),
				rating: 2,
				breadth: "general",
			};
		}
	}
	return { schemaVersion: 2, reviews: tweak(reviews) };
};

const catalogCases = {
	valid: makeCatalog(),
	oldSchema: makeCatalog({ schemaVersion: 6 }),
	thinQualityBar: makeCatalog({ qualityBar: { principle: "short", rejectIf: [], reviewAxes: [] } }),
	twoFamilies: makeCatalog({ families: makeCatalog().families.slice(0, 2) }),
	fourWells: makeCatalog({ wells: [well("graphic-w", "graphic")] }),
	badWellTier: makeCatalog({ wells: [well("graphic-w", "graphic"), well("interaction-w", "interaction"), well("atmosphere-w", "misnamed")] }),
	orphanFamily: makeCatalog({ families: [...makeCatalog().families, { id: "fam-x", label: "X", well: "missing-well", concepts: [conceptIn("concept-x")] }] }),
	emptyFamily: makeCatalog({ families: [...makeCatalog().families.slice(0, 2), { id: "fam-empty", label: "Empty", well: "atmosphere-w", concepts: [] }] }),
	unpopulatedWell: makeCatalog({ wells: [...makeCatalog().wells, well("spare-w", "graphic")] }),
	duplicateConcept: makeCatalog({
		families: [
			{ id: "fam-g", label: "Graphic", well: "graphic-w", concepts: [conceptIn("concept-g"), conceptIn("concept-g")] },
			...makeCatalog().families.slice(1),
		],
	}),
};

for (const [name, catalog] of Object.entries(catalogCases)) {
	const reviews = makeReviews(makeCatalog());
	check(`validateConceptCatalog(${name})`, port.validateConceptCatalog(catalog, reviews), ref.validateConceptCatalog(catalog, reviews));
}

// Review-side failures, one each.
const baseCatalog = makeCatalog();
const reviewVariants = {
	staleHash: (reviews) => {
		reviews["concept-g"].formHash = "000000000000";
		return reviews;
	},
	missingConcept: (reviews) => {
		reviews["ghost"] = { status: "approved", reviewedBy: "r", reviewedAt: "2024-01-01T00:00:00.000Z", formHash: "x" };
		return reviews;
	},
	badStatus: (reviews) => {
		reviews["concept-g"].status = "maybe";
		return reviews;
	},
	noReviewer: (reviews) => {
		reviews["concept-g"].reviewedBy = "";
		return reviews;
	},
	badTimestamp: (reviews) => {
		reviews["concept-g"].reviewedAt = "not a date";
		return reviews;
	},
	badRating: (reviews) => {
		reviews["concept-g"].rating = 4;
		return reviews;
	},
	ratingOnRejection: (reviews) => {
		reviews["concept-g"].status = "rejected";
		return reviews;
	},
	badBreadth: (reviews) => {
		reviews["concept-g"].breadth = "narrow";
		return reviews;
	},
	emptyModes: (reviews) => {
		reviews["concept-g"].allowedModes = [];
		return reviews;
	},
	unknownMode: (reviews) => {
		reviews["concept-g"].allowedModes = ["persuade", "socialize"];
		return reviews;
	},
	duplicateModes: (reviews) => {
		reviews["concept-g"].allowedModes = ["persuade", "persuade"];
		return reviews;
	},
	everyMode: (reviews) => {
		reviews["concept-g"].allowedModes = ["persuade", "operate", "read", "experience"];
		return reviews;
	},
	longNote: (reviews) => {
		reviews["concept-g"].note = "x".repeat(501);
		return reviews;
	},
	tooFewApproved: (reviews) => {
		for (const id of ["concept-g", "concept-i", "concept-a"]) reviews[id].status = "rejected";
		return reviews;
	},
};

for (const [name, tweak] of Object.entries(reviewVariants)) {
	const reviews = makeReviews(baseCatalog, tweak);
	check(`validateConceptCatalog(review: ${name})`, port.validateConceptCatalog(baseCatalog, reviews), ref.validateConceptCatalog(baseCatalog, reviews));
}

check(
	"validateConceptCatalog(no approved minimum)",
	port.validateConceptCatalog(baseCatalog, makeReviews(baseCatalog, reviewVariants.tooFewApproved), { requireApprovedMinimum: false }),
	ref.validateConceptCatalog(baseCatalog, makeReviews(baseCatalog, reviewVariants.tooFewApproved), { requireApprovedMinimum: false }),
);
check(
	"validateConceptCatalog(expectedTotal)",
	port.validateConceptCatalog(baseCatalog, makeReviews(baseCatalog), { expectedTotal: 99, minimumTotal: 99 }),
	ref.validateConceptCatalog(baseCatalog, makeReviews(baseCatalog), { expectedTotal: 99, minimumTotal: 99 }),
);

// ─── reading a catalog from disk ────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-catalog-"));
try {
	const catalogPath = path.join(dir, "concepts.json");
	const reviewsPath = path.join(dir, "reviews.json");
	fs.writeFileSync(catalogPath, JSON.stringify(baseCatalog));
	fs.writeFileSync(reviewsPath, JSON.stringify(makeReviews(baseCatalog)));
	check("readConceptCatalog", port.readConceptCatalog(catalogPath, reviewsPath), ref.readConceptCatalog(catalogPath, reviewsPath));

	const merged = port.readConceptCatalog(catalogPath, reviewsPath).concepts;
	check("approvedPoolRevision", port.approvedPoolRevision(merged), ref.approvedPoolRevision(merged));

	// A revision changes when the pool content changes, and not before.
	const edited = merged.map((concept) =>
		concept.id === "concept-g" ? { ...concept, spark: `${concept.spark} Edited.` } : concept,
	);
	check("approvedPoolRevision changes on edit", port.approvedPoolRevision(edited) !== port.approvedPoolRevision(merged), true);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} concept-catalog comparisons failed`);
	process.exit(1);
}
console.log(`concept-catalog parity: ${comparisons} comparisons match the reference`);
