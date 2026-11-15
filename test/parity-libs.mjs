/**
 * Parity check: the small shared libs against the reference.
 *
 * These are the pieces every other command leans on — argument parsing, slugs, the artifact
 * schema stamp — so a difference here propagates silently. Each is small enough to compare
 * exhaustively.
 */
import * as targetArgs from "../extensions/designer/engine/lib/target-args.ts";
import * as targetSlug from "../extensions/designer/engine/lib/target-slug.ts";
import * as schema from "../extensions/designer/engine/lib/artifact-schema.ts";
import * as provider from "../extensions/designer/engine/lib/provider.ts";

const refArgs = await import("../reference/impeccable-js/scripts/lib/target-args.mjs");
const refSlug = await import("../reference/impeccable-js/scripts/lib/target-slug.mjs");
const refSchema = await import("../reference/impeccable-js/scripts/lib/artifact-schema.mjs");

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     port: ${a}\n     ref:  ${e}`);
}

// ─── --target parsing ──────────────────────────────────────────────────────

const argCases = [
	[],
	["--target", "src/app"],
	["-t", "src/app"],
	["--target=src/app"],
	["--target"],
	["--target", "--json"],
	["--target="],
	["--json", "--target", "a", "--fix"],
	["src/app"],
];
for (const args of argCases) {
	for (const strict of [false, true]) {
		let portResult;
		let refResult;
		try {
			portResult = { value: targetArgs.parseTargetPath(args, { strict }) };
		} catch (error) {
			portResult = { error: error.code ?? error.name };
		}
		try {
			refResult = { value: refArgs.parseTargetPath(args, { strict }) };
		} catch (error) {
			refResult = { error: error.code ?? error.name };
		}
		check(`parseTargetPath(${JSON.stringify(args)}, strict=${strict})`, portResult, refResult);
	}
	check(`parseTargetOptions(${JSON.stringify(args)})`, targetArgs.parseTargetOptions(args), refArgs.parseTargetOptions(args));
}

// ─── Slugs ─────────────────────────────────────────────────────────────────

for (const value of ["", " ", "App Layout", "a/b/c", "/abs/path/file.css", "src\\win\\file.ts", "---", "x".repeat(120), "ÜBER Café"]) {
	check(`kebab(${JSON.stringify(value)})`, targetSlug.kebab(value), refSlug.kebab(value));
}

for (const target of ["src/app/page.tsx", "/abs/elsewhere/file.css", "https://example.com/pricing", "https://x.dev", "not a real url", "", null]) {
	check(`slugFromTarget(${JSON.stringify(target)})`, targetSlug.slugFromTarget(target, { cwd: "/project" }), refSlug.slugFromTarget(target, { cwd: "/project" }));
}

// ─── Artifact schema ───────────────────────────────────────────────────────

check("PRODUCT_SCHEMA_VERSION", schema.PRODUCT_SCHEMA_VERSION, refSchema.PRODUCT_SCHEMA_VERSION);
check("DESIGN_SIDECAR_SCHEMA_VERSION", schema.DESIGN_SIDECAR_SCHEMA_VERSION, refSchema.DESIGN_SIDECAR_SCHEMA_VERSION);
check("PRODUCT_V4_SECTIONS", [...schema.PRODUCT_V4_SECTIONS], [...refSchema.PRODUCT_V4_SECTIONS]);
check("PRODUCT_DEPRECATED_SECTIONS", schema.PRODUCT_DEPRECATED_SECTIONS, refSchema.PRODUCT_DEPRECATED_SECTIONS);
check("productStampLine()", schema.productStampLine(), refSchema.productStampLine());
check("productStampLine(3)", schema.productStampLine(3), refSchema.productStampLine(3));

const productBodies = [
	"",
	"# Product\n\nBody copy.",
	"# Product\n\n<!-- impeccable:product-schema 1 -->\n\nBody copy.",
	"# Product\n\n<!--impeccable:product-schema   2-->\n\nBody copy.",
	"No heading here.\n\nJust prose.",
	"# Title\n## Section\n",
	"   \n\n# Spaced\n",
];
for (const body of productBodies) {
	check(`readProductSchemaVersion(${JSON.stringify(body.slice(0, 24))})`, schema.readProductSchemaVersion(body), refSchema.readProductSchemaVersion(body));
	check(`stampProductSchema(${JSON.stringify(body.slice(0, 24))})`, schema.stampProductSchema(body), refSchema.stampProductSchema(body));
	check(
		`stampProductSchema(idempotent, ${JSON.stringify(body.slice(0, 24))})`,
		schema.stampProductSchema(schema.stampProductSchema(body)),
		refSchema.stampProductSchema(refSchema.stampProductSchema(body)),
	);
}
check("stampProductSchema(body, 7)", schema.stampProductSchema("# P\n\nx", 7), refSchema.stampProductSchema("# P\n\nx", 7));

for (const sidecar of [null, {}, { schemaVersion: 2 }, { schemaVersion: "2" }, { schemaVersion: 2.5 }, "nope"]) {
	check(`readSidecarSchemaVersion(${JSON.stringify(sidecar)})`, schema.readSidecarSchemaVersion(sidecar), refSchema.readSidecarSchemaVersion(sidecar));
}

// ─── Provider identity (deliberate divergence) ─────────────────────────────

check(
	"provider: the command names pi's front door",
	[provider.IMPECCABLE_COMMAND_PREFIX, provider.IMPECCABLE_PROVIDER_ID, provider.IMPECCABLE_COMMAND],
	["/", "pi", "/designer"],
);

// ─── Surface briefs ────────────────────────────────────────────────────────

import { parseSurfaceBrief as refParseBrief, normalizeSurfaceTarget as refNormalizeTarget, resolveSurfaceBrief as refResolveBrief, writeSurfaceBrief as refWriteBrief, surfaceBriefPathForTarget as refBriefPath } from "../reference/impeccable-js/scripts/lib/surface-briefs.mjs";
import * as briefs from "../extensions/designer/engine/lib/surface-briefs.ts";
import fsMod from "node:fs";
import osMod from "node:os";
import pathMod from "node:path";

const briefRoot = "/project";
for (const target of [
	"src/app/page.tsx",
	"/project/src/app/page.tsx",
	"/pricing",
	"/",
	"route:/pricing?x=1#y",
	"route:../escape",
	"https://example.com/pricing/?q=1#top",
	"https://example.com",
	"../outside/file.tsx",
	"",
	null,
]) {
	check(`normalizeSurfaceTarget(${JSON.stringify(target)})`, briefs.normalizeSurfaceTarget(target, { projectRoot: briefRoot }), refNormalizeTarget(target, { projectRoot: briefRoot }));
	check(`surfaceBriefPathForTarget(${JSON.stringify(target)})`, briefs.surfaceBriefPathForTarget(target, { projectRoot: briefRoot }), refBriefPath(target, { projectRoot: briefRoot }));
}

const briefTexts = [
	"",
	"No frontmatter at all.",
	`---\nversion: 1\nslug: "src-app"\nprimary_target: "src/app/page.tsx"\nrelated_targets: ["src/app/layout.tsx"]\n---\n\nBody here.`,
	`---\nversion: 1\nprimary_target: route:/pricing\n---\nbody`,
	`---\nnot a key pair\nslug: x\n---\n`, 
	`---\nslug: 42\nprimary_target: plain text value\n---\n`,
];
for (const text of briefTexts) {
	check(`parseSurfaceBrief(${JSON.stringify(text.slice(0, 20))})`, briefs.parseSurfaceBrief(text, "/project/.impeccable/surfaces/x.md"), refParseBrief(text, "/project/.impeccable/surfaces/x.md"));
}

const briefDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-briefs-"));
try {
	briefs.writeSurfaceBrief({ projectRoot: briefDir, primaryTarget: "src/app/page.tsx", relatedTargets: ["https://example.com/a", "src/app/page.tsx"], body: "Strategy." });
	check("resolveSurfaceBrief(only brief)", briefs.resolveSurfaceBrief(briefDir).reason, refResolveBrief(briefDir).reason);
	check("resolveSurfaceBrief(by target)", briefs.resolveSurfaceBrief(briefDir, "src/app/page.tsx").reason, refResolveBrief(briefDir, "src/app/page.tsx").reason);
	check("resolveSurfaceBrief(by related target)", briefs.resolveSurfaceBrief(briefDir, "https://example.com/a").reason, refResolveBrief(briefDir, "https://example.com/a").reason);
	check("resolveSurfaceBrief(not found)", briefs.resolveSurfaceBrief(briefDir, "src/other.tsx").reason, refResolveBrief(briefDir, "src/other.tsx").reason);
	briefs.writeSurfaceBrief({ projectRoot: briefDir, primaryTarget: "src/b.tsx", body: "Second." });
	check("resolveSurfaceBrief(ambiguous)", briefs.resolveSurfaceBrief(briefDir).reason, refResolveBrief(briefDir).reason);
	check("listSurfaceBriefs", briefs.listSurfaceBriefs(briefDir).map((b) => b.slug), refResolveBrief(briefDir).candidates.map((b) => b.slug));
} finally {
	fsMod.rmSync(briefDir, { recursive: true, force: true });
}

// ─── Staleness notice: throttling and the directive ────────

import * as notice from "../extensions/designer/engine/lib/staleness-notice.ts";
import * as refNotice from "../reference/impeccable-js/scripts/lib/staleness-notice.mjs";

const noticeDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-notice-"));
const cacheFile = pathMod.join(noticeDir, "staleness.json");
const savedCacheEnv = process.env.IMPECCABLE_STALENESS_CACHE;
const savedOffEnv = process.env.IMPECCABLE_NO_STALENESS_CHECK;
process.env.IMPECCABLE_STALENESS_CACHE = cacheFile;
delete process.env.IMPECCABLE_NO_STALENESS_CHECK;

try {
	const mention = { id: "config-unknown-keys", artifact: "config.json", path: "a", severity: "mention", summary: "s", fix: "f" };
	const auto = { id: "design-sidecar-legacy-path", artifact: "design.json", path: "b", severity: "auto", summary: "s", fix: "f" };
	const route = { id: "product-schema-legacy", artifact: "PRODUCT.md", path: "c", severity: "route", summary: "s", fix: "f" };
	const now = 1_000_000_000_000;

	check("filterFreshFindings(empty)", notice.filterFreshFindings([], { projectRoot: "/p", now }), refNotice.filterFreshFindings([], { projectRoot: "/p", now }));

	// The throttle cache is shared state, so each implementation gets its own file: otherwise the
	// first run stamps the finding and the second reads it as already notified.
	let cacheSeq = 0;
	function withFreshCache(callback) {
		cacheSeq++;
		process.env.IMPECCABLE_STALENESS_CACHE = pathMod.join(noticeDir, `cache-${cacheSeq}.json`);
		return callback();
	}
	function compareFilter(name, findings, options) {
		const portResult = withFreshCache(() => notice.filterFreshFindings(findings, options).map((f) => f.id));
		const refResult = withFreshCache(() => refNotice.filterFreshFindings(findings, options).map((f) => f.id));
		check(name, portResult, refResult);
	}

	compareFilter("filterFreshFindings(first boot)", [mention, auto], { projectRoot: "/p", now });
	compareFilter("filterFreshFindings(after window)", [mention, auto], { projectRoot: "/p", now: now + 8 * 24 * 60 * 60 * 1000 });
	compareFilter("filterFreshFindings(auto only)", [auto], { projectRoot: "/p", now });

	check("buildStalenessDirective(none)", notice.buildStalenessDirective([]), refNotice.buildStalenessDirective([]));
	check("buildStalenessDirective(auto only)", notice.buildStalenessDirective([auto]), refNotice.buildStalenessDirective([auto]));
	check("buildStalenessDirective(reportable)", notice.buildStalenessDirective([mention, route, auto]), refNotice.buildStalenessDirective([mention, route, auto]));

	check("stalenessCheckDisabled(default)", notice.stalenessCheckDisabled([noticeDir]), refNotice.stalenessCheckDisabled([noticeDir]));
	fsMod.mkdirSync(pathMod.join(noticeDir, ".impeccable"), { recursive: true });
	fsMod.writeFileSync(pathMod.join(noticeDir, ".impeccable", "config.json"), JSON.stringify({ stalenessCheck: false }));
	check("stalenessCheckDisabled(config false)", notice.stalenessCheckDisabled([noticeDir]), refNotice.stalenessCheckDisabled([noticeDir]));
	fsMod.writeFileSync(pathMod.join(noticeDir, ".impeccable", "config.local.json"), JSON.stringify({ stalenessCheck: true }));
	check("stalenessCheckDisabled(local overrides)", notice.stalenessCheckDisabled([noticeDir]), refNotice.stalenessCheckDisabled([noticeDir]));
	process.env.IMPECCABLE_NO_STALENESS_CHECK = "1";
	check("stalenessCheckDisabled(env)", notice.stalenessCheckDisabled([noticeDir]), refNotice.stalenessCheckDisabled([noticeDir]));
	delete process.env.IMPECCABLE_NO_STALENESS_CHECK;
} finally {
	if (savedCacheEnv === undefined) delete process.env.IMPECCABLE_STALENESS_CACHE;
	else process.env.IMPECCABLE_STALENESS_CACHE = savedCacheEnv;
	if (savedOffEnv === undefined) delete process.env.IMPECCABLE_NO_STALENESS_CHECK;
	else process.env.IMPECCABLE_NO_STALENESS_CHECK = savedOffEnv;
	fsMod.rmSync(noticeDir, { recursive: true, force: true });
}

// ─── Impeccable paths ───────────────────────

import * as paths from "../extensions/designer/engine/lib/impeccable-paths.ts";
import * as refPaths from "../reference/impeccable-js/scripts/lib/impeccable-paths.mjs";

const pathsRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-paths-"));
try {
	fsMod.mkdirSync(pathMod.join(pathsRoot, ".gem", "proj", "src"), { recursive: true });
	fsMod.writeFileSync(pathMod.join(pathsRoot, ".gem", "proj", "package.json"), "{}");
	fsMod.writeFileSync(pathMod.join(pathsRoot, ".gem", "proj", "DESIGN.md"), "# D\n");
	const project = pathMod.join(pathsRoot, ".gem", "proj");

	for (const [name, fn, refFn] of [
		["getImpeccableDir", paths.getImpeccableDir, refPaths.getImpeccableDir],
		["getDesignSidecarPath", paths.getDesignSidecarPath, refPaths.getDesignSidecarPath],
		["getCritiqueDir", paths.getCritiqueDir, refPaths.getCritiqueDir],
		["getLiveDir", paths.getLiveDir, refPaths.getLiveDir],
		["getLiveServerPath", paths.getLiveServerPath, refPaths.getLiveServerPath],
	]) {
		check(`${name}(project)`, pathMod.relative(pathsRoot, fn(project)), pathMod.relative(pathsRoot, refFn(project)));
		check(`${name}(subdir)`, pathMod.relative(pathsRoot, fn(pathMod.join(project, "src"))), pathMod.relative(pathsRoot, refFn(pathMod.join(project, "src"))));
	}

	check(
		"getDesignSidecarCandidates",
		paths.getDesignSidecarCandidates(project).map((p) => pathMod.relative(pathsRoot, p)),
		refPaths.getDesignSidecarCandidates(project).map((p) => pathMod.relative(pathsRoot, p)),
	);
	check("resolveDesignSidecarPath(absent)", paths.resolveDesignSidecarPath(project), refPaths.resolveDesignSidecarPath(project));
	fsMod.writeFileSync(pathMod.join(project, "DESIGN.json"), "{}");
	check(
		"resolveDesignSidecarPath(legacy present)",
		pathMod.relative(pathsRoot, paths.resolveDesignSidecarPath(project)),
		pathMod.relative(pathsRoot, refPaths.resolveDesignSidecarPath(project)),
	);

	for (const id of ["abc123", "a-b_c", "../escape", "a/b", "", 42, "x".repeat(200)]) {
		let portResult;
		let refResult;
		try {
			portResult = { value: paths.safeSessionId(id) };
		} catch (error) {
			portResult = { error: "invalid" };
		}
		try {
			refResult = { value: refPaths.safeSessionId(id) };
		} catch {
			refResult = { error: "invalid" };
		}
		check(`safeSessionId(${JSON.stringify(id)})`, portResult, refResult);
	}

	check("resolveLiveConfigPath(env override)", pathMod.relative(pathsRoot, paths.resolveLiveConfigPath({ cwd: project, env: { IMPECCABLE_LIVE_CONFIG: "custom.json" } })), pathMod.relative(pathsRoot, refPaths.resolveLiveConfigPath({ cwd: project, env: { IMPECCABLE_LIVE_CONFIG: "custom.json" } })));
	check("resolveLiveConfigPath(default)", pathMod.relative(pathsRoot, paths.resolveLiveConfigPath({ cwd: project, env: {} })), pathMod.relative(pathsRoot, refPaths.resolveLiveConfigPath({ cwd: project, env: {} })));
} finally {
	fsMod.rmSync(pathsRoot, { recursive: true, force: true });
}

// ─── Template extensions and generated files ──

import * as ext from "../extensions/designer/engine/lib/template-extensions.ts";
import * as refExt from "../reference/impeccable-js/scripts/lib/template-extensions.mjs";
import * as gen from "../extensions/designer/engine/lib/is-generated.ts";
import * as refGen from "../reference/impeccable-js/scripts/lib/is-generated.mjs";

check("LIVE_TEMPLATE_EXTENSIONS", ext.LIVE_TEMPLATE_EXTENSIONS, refExt.LIVE_TEMPLATE_EXTENSIONS);

for (const entries of [
	[],
	[".blade.php", "erb"],
	[{ ext: ".heex" }, { ext: "twig", engine: "text" }],
	[{ ext: "  .HTML " }, { nope: true }, null, 42],
]) {
	check(`normalizeExtensionEntries(${JSON.stringify(entries)})`, ext.normalizeExtensionEntries(entries), refExt.normalizeExtensionEntries(entries));
}

check(
	"mergeExtensions",
	ext.mergeExtensions([{ ext: ".php", engine: "html" }], [{ ext: ".blade.php", engine: "text" }, { ext: ".php", engine: "text" }]),
	refExt.mergeExtensions([{ ext: ".php", engine: "html" }], [{ ext: ".blade.php", engine: "text" }, { ext: ".php", engine: "text" }]),
);

const configured = [{ ext: ".php", engine: "html" }, { ext: ".blade.php", engine: "text" }];
for (const filePath of ["show.blade.php", "show.php", "show.html.erb", "card.tsx", ".heex", "", "BLADE.PHP"]) {
	check(`matchConfiguredExtension(${JSON.stringify(filePath)})`, ext.matchConfiguredExtension(filePath, configured), refExt.matchConfiguredExtension(filePath, configured));
	check(
		`matchesTemplateExtension(${JSON.stringify(filePath)})`,
		ext.matchesTemplateExtension(filePath, [".php", ".blade.php", ".html.erb"]),
		refExt.matchesTemplateExtension(filePath, [".php", ".blade.php", ".html.erb"]),
	);
}

const extDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-ext-"));
try {
	check("resolveLiveTemplateExtensions(default)", ext.resolveLiveTemplateExtensions(extDir), refExt.resolveLiveTemplateExtensions(extDir));
	fsMod.mkdirSync(pathMod.join(extDir, ".impeccable"), { recursive: true });
	fsMod.writeFileSync(
		pathMod.join(extDir, ".impeccable", "config.json"),
		JSON.stringify({ detector: { extensions: [{ ext: ".blade.php", engine: "text" }, ".twig", ".html"] } }),
	);
	ext.clearTemplateExtensionCache();
	refExt.clearTemplateExtensionCache();
	check("resolveLiveTemplateExtensions(configured)", ext.resolveLiveTemplateExtensions(extDir), refExt.resolveLiveTemplateExtensions(extDir));
} finally {
	fsMod.rmSync(extDir, { recursive: true, force: true });
	refExt.clearTemplateExtensionCache();
}

const genDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-gen-"));
try {
	fsMod.writeFileSync(pathMod.join(genDir, "marked.tsx"), "// AUTO-GENERATED — do not edit\nexport const A = 1;\n");
	fsMod.writeFileSync(pathMod.join(genDir, "do-not-edit.css"), "/* DO NOT EDIT */\n.a { color: red }\n");
	fsMod.writeFileSync(pathMod.join(genDir, "plain.tsx"), "export const B = 2;\n");
	fsMod.writeFileSync(pathMod.join(genDir, "late-marker.tsx"), `${'x'.repeat(400)}\n// AUTO-GENERATED\n`);
	for (const file of ["marked.tsx", "do-not-edit.css", "plain.tsx", "late-marker.tsx", "missing.tsx"]) {
		check(`isGeneratedFile(${file})`, gen.isGeneratedFile(file, { cwd: genDir }), refGen.isGeneratedFile(file, { cwd: genDir }));
	}
} finally {
	fsMod.rmSync(genDir, { recursive: true, force: true });
}

// ─── Composition catalog ──────────

import * as comp from "../extensions/designer/engine/lib/composition-catalog.ts";
import * as refComp from "../reference/impeccable-js/scripts/lib/composition-catalog.mjs";

check("COMPOSITION_GRAMMAR_PREFIXES", comp.COMPOSITION_GRAMMAR_PREFIXES, refComp.COMPOSITION_GRAMMAR_PREFIXES);
check("COMPOSITION_SURFACES", [...comp.COMPOSITION_SURFACES], [...refComp.COMPOSITION_SURFACES]);

const validGrammar = [
	"Staging/hierarchy: one column, the outcome pinned above the fold",
	"Sequence/attention: three steps, each ending in a decision",
	"Controls/state: a single primary action per step",
	"Adaptation: steps stack below 700 pixels",
];

const validComposition = {
	id: "three-step-checkout",
	familyId: "sequential",
	form: "A three-step checkout where each step resolves one decision and the running total stays pinned above the fold, staged as a single column.",
	lineage: "guided checkout patterns, ticket stubs",
	surface: "operate",
	grain: "flow",
	platforms: ["web", "ios"],
	tags: ["sequential", "pinned", "single-column"],
	grammar: validGrammar,
	spark: "Each step ends on a decision the buyer can undo without leaving, so the sequence reads as a conversation rather than a form to survive.",
	webLeverage: "IntersectionObserver keeps the pinned total in view as the steps scroll.",
};

const compositionCases = {
	valid: validComposition,
	badId: { ...validComposition, id: "Three Step" },
	noComma: { ...validComposition, form: "A form with plenty of length but no comma so the staging mechanism is missing entirely." },
	badSurface: { ...validComposition, surface: "convert" },
	badGrain: { ...validComposition, grain: "epic" },
	emptyPlatforms: { ...validComposition, platforms: [] },
	badPlatform: { ...validComposition, platforms: ["desktop"] },
	duplicatePlatforms: { ...validComposition, platforms: ["web", "web"] },
	everyPlatform: { ...validComposition, platforms: ["web", "ios", "android"] },
	omittedPlatforms: { ...validComposition, platforms: undefined },
	threeRules: { ...validComposition, grammar: validGrammar.slice(0, 3) },
	dupeGrammar: { ...validComposition, grammar: [validGrammar[0], validGrammar[0], validGrammar[2], validGrammar[3]] },
	wrongGrammarOrder: { ...validComposition, grammar: [validGrammar[1], validGrammar[0], validGrammar[2], validGrammar[3]] },
	shortSpark: { ...validComposition, spark: "short" },
	badLineage: { ...validComposition, lineage: "short" },
	twoTags: { ...validComposition, tags: ["sequential", "pinned"] },
};

for (const [name, composition] of Object.entries(compositionCases)) {
	check(`validateCompositionEntry(${name})`, comp.validateCompositionEntry(composition), refComp.validateCompositionEntry(composition));
	check(`compositionContentHash(${name})`, comp.compositionContentHash(composition), refComp.compositionContentHash(composition));
}

const family = (id) => ({ id, description: "A description long enough to clear the forty character floor for families." });
const makeCompositionCatalog = (overrides = {}) => ({
	schemaVersion: 1,
	qualityBar: { principle: "A staging bar long enough to clear the eighty character floor, stating what every composition must earn." },
	families: [family("sequential"), family("layered"), family("spatial"), family("indexed")],
	compositions: [validComposition],
	...overrides,
});

const makeCompositionReviews = (catalog, tweak = (reviews) => reviews) => {
	const reviews = {};
	for (const composition of catalog.compositions || []) {
		reviews[composition.id] = {
			status: "approved",
			reviewedBy: "reviewer",
			reviewedAt: "2024-01-01T00:00:00.000Z",
			formHash: comp.compositionContentHash(composition),
			rating: 2,
		};
	}
	return { schemaVersion: 1, reviews: tweak(reviews) };
};

const compositionCatalogCases = {
	valid: makeCompositionCatalog(),
	badSchema: makeCompositionCatalog({ schemaVersion: 0 }),
	thinQualityBar: makeCompositionCatalog({ qualityBar: { principle: "short" } }),
	threeFamilies: makeCompositionCatalog({ families: [family("sequential"), family("layered"), family("spatial")] }),
	badFamilyId: makeCompositionCatalog({ families: [family("Not A Slug"), family("layered"), family("spatial"), family("indexed")] }),
	shortFamilyDescription: makeCompositionCatalog({ families: [{ id: "sequential", description: "short" }, family("layered"), family("spatial"), family("indexed")] }),
	orphanComposition: makeCompositionCatalog({ compositions: [{ ...validComposition, familyId: "missing" }] }),
	duplicateComposition: makeCompositionCatalog({ compositions: [validComposition, { ...validComposition }] }),
};

for (const [name, catalog] of Object.entries(compositionCatalogCases)) {
	const reviews = makeCompositionReviews(makeCompositionCatalog());
	check(`validateCompositionCatalog(${name})`, comp.validateCompositionCatalog(catalog, reviews), refComp.validateCompositionCatalog(catalog, reviews));
}

const baseCompositionCatalog = makeCompositionCatalog();
const compositionReviewVariants = {
	staleHash: (reviews) => {
		reviews["three-step-checkout"].formHash = "000000000000";
		return reviews;
	},
	missingEntry: (reviews) => {
		reviews["ghost"] = { status: "approved", formHash: "x" };
		return reviews;
	},
	badStatus: (reviews) => {
		reviews["three-step-checkout"].status = "maybe";
		return reviews;
	},
	badRating: (reviews) => {
		reviews["three-step-checkout"].rating = 0;
		return reviews;
	},
	ratingOnRejection: (reviews) => {
		reviews["three-step-checkout"].status = "rejected";
		return reviews;
	},
	longNote: (reviews) => {
		reviews["three-step-checkout"].note = "x".repeat(501);
		return reviews;
	},
};

for (const [name, tweak] of Object.entries(compositionReviewVariants)) {
	const reviews = makeCompositionReviews(baseCompositionCatalog, tweak);
	check(
		`validateCompositionCatalog(review: ${name})`,
		comp.validateCompositionCatalog(baseCompositionCatalog, reviews),
		refComp.validateCompositionCatalog(baseCompositionCatalog, reviews),
	);
}

const compDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "pi-designer-compcatalog-"));
try {
	const catalogPath = pathMod.join(compDir, "compositions.json");
	const reviewsPath = pathMod.join(compDir, "reviews.json");
	fsMod.writeFileSync(catalogPath, JSON.stringify(baseCompositionCatalog));
	fsMod.writeFileSync(reviewsPath, JSON.stringify(makeCompositionReviews(baseCompositionCatalog)));
	check("readCompositionCatalog", comp.readCompositionCatalog(catalogPath, reviewsPath), refComp.readCompositionCatalog(catalogPath, reviewsPath));
} finally {
	fsMod.rmSync(compDir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} lib parity comparisons failed`);
	process.exit(1);
}
console.log(`lib parity: ${comparisons} comparisons match the reference`);
