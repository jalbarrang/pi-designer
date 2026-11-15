/**
 * Staleness: the drift a session can afford to notice between a project's artifacts and what
 * the current version reads. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Every check here is a small number of stats and one short JSON or markdown read, because
 * this runs at boot. The severity is what the reader acts on: `auto` carries no decision,
 * `mention` needs the user to know, and `route` needs a specific command.
 */
import fs from "node:fs";
import path from "node:path";
import {
	DESIGN_SIDECAR_SCHEMA_VERSION,
	PRODUCT_DEPRECATED_SECTIONS,
	PRODUCT_SCHEMA_VERSION,
	PRODUCT_V4_SECTIONS,
	readProductSchemaVersion,
	readSidecarSchemaVersion,
} from "./artifact-schema.ts";

/** One drift finding: what it is, where it lives, and what to do. */
export interface StalenessFinding {
	readonly id: string;
	readonly artifact: string;
	readonly path: string | null;
	readonly severity: "auto" | "mention" | "route";
	readonly summary: string;
	readonly fix: string;
}

/** A persisted surface brief, as this module reads one. */
export interface BriefCandidate {
	readonly path: string | null;
	readonly primaryTarget: string | null;
}

/** A discovered workspace, for the doctor report. */
export interface WorkspaceCandidate {
	readonly name: string;
	readonly path: string;
	readonly productStatus?: string;
	readonly productPath?: string | null;
	readonly designStatus?: string;
	readonly designPath?: string | null;
}

/**
 * The context subset these checks read. Declared structurally so this module never imports
 * the context loader (which imports it).
 */
export interface StalenessContext {
	readonly projectRoot?: string | null;
	readonly repoRoot?: string | null;
	readonly product?: string | null;
	readonly productPath?: string | null;
	readonly platform?: string | null;
	readonly designPath?: string | null;
	readonly surfaceBriefCandidates?: readonly BriefCandidate[];
}

// Top-level config keys a reader honors: the `hook` and `detector` subtrees, `updateCheck`,
// `projectRoots`, `buildPath`, `stalenessCheck`, plus `$schema` and `version` as conventional
// metadata nobody reads.
const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
	"hook",
	"detector",
	"updateCheck",
	"stalenessCheck",
	"projectRoots",
	"buildPath",
	"$schema",
	"version",
]);

// The only two values the build-path setting honors. A near miss reads as a working
// preference and silently rides the opposite path, so it is reported rather than coerced.
const BUILD_PATH_VALUES: readonly string[] = Object.freeze(["comp", "code"]);

// Evidence that this project does the kind of work `buildPath` governs. A project that only
// ever ran polish or audit has no use for the setting and should never be told it exists.
const DIRECTION_WORK_PATHS: readonly string[] = Object.freeze([
	path.join(".impeccable", "surfaces"),
	path.join(".impeccable", "mocks", "decision"),
]);

// `detector` is a closed set, so a typo there is worth reporting. `hook` is not checked:
// several writers own it, and the false-positive rate would outweigh the catch.
const KNOWN_DETECTOR_KEYS: ReadonlySet<string> = new Set(["ignoreRules", "ignoreFiles", "ignoreValues", "designSystem", "extensions"]);

// Evidence that a project ships a native app. Checked only to catch a PRODUCT.md that says
// web (or says nothing, which resolves to web) on a project that plainly is not: that
// combination silently skips the iOS and Android references for the whole session.
const NATIVE_EVIDENCE_PATHS: ReadonlyArray<{ readonly rel: string; readonly platform: string; readonly reason: string }> = Object.freeze([
	{ rel: "pubspec.yaml", platform: "adaptive", reason: "a Flutter pubspec.yaml" },
	{ rel: "ios/Podfile", platform: "ios", reason: "an ios/Podfile" },
	{ rel: "android/build.gradle", platform: "android", reason: "an android/build.gradle" },
	{ rel: "android/build.gradle.kts", platform: "android", reason: "an android/build.gradle.kts" },
	{ rel: "ios/Runner.xcodeproj", platform: "ios", reason: "an ios/Runner.xcodeproj" },
]);

const NATIVE_EVIDENCE_DEPENDENCIES: ReadonlyArray<{ readonly name: string; readonly platform: string; readonly reason: string }> = Object.freeze([
	{ name: "react-native", platform: "adaptive", reason: "a react-native dependency" },
	{ name: "expo", platform: "adaptive", reason: "an expo dependency" },
	{ name: "@react-native/metro-config", platform: "adaptive", reason: "a React Native metro config dependency" },
]);

function finding(entry: StalenessFinding): StalenessFinding {
	return entry;
}

/**
 * Every location a design sidecar may live, canonical first. Pure, so both the path helpers
 * and the context loader can share one definition of where the retired locations are without
 * importing each other.
 */
function designSidecarCandidatesFor(projectRoot: string, contextDir: string = projectRoot): string[] {
	const candidates = [path.join(projectRoot, ".impeccable", "design.json"), path.join(projectRoot, "DESIGN.json")];
	const contextLegacy = path.join(contextDir || projectRoot, "DESIGN.json");
	if (!candidates.includes(contextLegacy)) candidates.push(contextLegacy);
	return candidates;
}

function readJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function mtimeMs(filePath: string): number | null {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}

/** True when the markdown has an `## <heading>` section. */
function hasSection(markdown: string | null | undefined, heading: string): boolean {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^##\\s+${escaped}\\s*$`, "im").test(String(markdown || ""));
}

/** A path relative to the project when it is inside it, absolute otherwise. */
function toRelative(filePath: string | null | undefined, root: string): string | null {
	if (!filePath) return null;
	const rel = path.relative(root, filePath);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : filePath;
}

/**
 * Schema drift visible in a PRODUCT.md body: a retired section, a missing stamp on a record
 * that predates the current one, or a stamp that is behind.
 */
function checkProduct(product: string | null | undefined, productPath = "PRODUCT.md"): StalenessFinding[] {
	if (!product) return [];
	const findings: StalenessFinding[] = [];

	for (const [heading, reason] of Object.entries(PRODUCT_DEPRECATED_SECTIONS)) {
		if (!hasSection(product, heading)) continue;
		findings.push(
			finding({
				id: `product-deprecated-${heading.toLowerCase()}`,
				artifact: "PRODUCT.md",
				path: productPath,
				severity: "mention",
				summary: `PRODUCT.md still carries a \`## ${heading}\` section. ${reason}`,
				fix: `Treat \`## ${heading}\` as absent for every decision this session. Offer to delete the section; do not let its value influence the work either way.`,
			}),
		);
	}

	const stamped = readProductSchemaVersion(product);
	if (stamped === null && !PRODUCT_V4_SECTIONS.some((section) => hasSection(product, section))) {
		findings.push(
			finding({
				id: "product-schema-legacy",
				artifact: "PRODUCT.md",
				path: productPath,
				severity: "route",
				summary: `PRODUCT.md has no schema stamp and none of the sections the current record adds (${PRODUCT_V4_SECTIONS.join(", ")}), so it predates this version of the product record.`,
				fix: "Offer `init`, which preserves confirmed answers and fills the gaps by interview. Do not rewrite the file from inference.",
			}),
		);
	} else if (stamped !== null && stamped < PRODUCT_SCHEMA_VERSION) {
		findings.push(
			finding({
				id: "product-schema-outdated",
				artifact: "PRODUCT.md",
				path: productPath,
				severity: "route",
				summary: `PRODUCT.md is stamped product-schema ${stamped}; the current record is ${PRODUCT_SCHEMA_VERSION}.`,
				fix: "Offer `init` to bring the record current, preserving confirmed answers.",
			}),
		);
	}

	return findings;
}

/**
 * A project that resolves to web while carrying native build files. Only the web resolution
 * is worth checking: an explicit native value is already honored, and an unrecognized value
 * gets its own warning.
 */
function checkNativePlatformEvidence({
	projectRoot,
	platform,
	product,
	productPath,
}: {
	readonly projectRoot?: string | null;
	readonly platform?: string | null;
	readonly product?: string | null;
	readonly productPath?: string | null;
}): StalenessFinding[] {
	if (!projectRoot) return [];
	if (platform && platform !== "web") return [];

	const evidence: Array<{ readonly platform: string; readonly reason: string }> = [];
	for (const entry of NATIVE_EVIDENCE_PATHS) {
		if (fs.existsSync(path.join(projectRoot, entry.rel))) evidence.push(entry);
	}

	const pkg = readJson(path.join(projectRoot, "package.json"));
	if (pkg) {
		const deps = {
			...((pkg.dependencies as Record<string, unknown>) || {}),
			...((pkg.devDependencies as Record<string, unknown>) || {}),
		};
		for (const entry of NATIVE_EVIDENCE_DEPENDENCIES) {
			if (deps[entry.name]) evidence.push(entry);
		}
	}
	if (evidence.length === 0) return [];

	const platforms = new Set(evidence.map((entry) => entry.platform));
	const suggested = platforms.size > 1 || platforms.has("adaptive") ? "adaptive" : [...platforms][0];
	const declared =
		platform === "web"
			? "PRODUCT.md declares `## Platform: web`"
			: product
				? "PRODUCT.md has no `## Platform` section, so the project resolves to web"
				: "no PRODUCT.md declares a platform, so the project resolves to web";

	return [
		finding({
			id: "platform-native-evidence",
			artifact: "PRODUCT.md",
			path: productPath || null,
			severity: "mention",
			summary: `${declared}, but the project carries ${evidence.map((entry) => entry.reason).join(" and ")}. Web guidance is being applied to a native codebase, and the iOS and Android references never load.`,
			fix: `Ask the user whether \`## Platform\` should be \`${suggested}\`. If it should, write the value and load the matching native reference before designing.`,
		}),
	];
}

/**
 * Sidecar drift: a retired location, a schema version behind, or an older sidecar than the
 * DESIGN.md it extends. `sidecarCandidates` comes from the path resolver, canonical first.
 */
function checkDesignSidecar({
	designPath,
	sidecarCandidates = [],
	projectRoot,
}: {
	readonly designPath?: string | null;
	readonly sidecarCandidates?: readonly string[];
	readonly projectRoot?: string | null;
}): StalenessFinding[] {
	const findings: StalenessFinding[] = [];
	const canonical = sidecarCandidates[0] || null;
	const present = sidecarCandidates.find((candidate) => fs.existsSync(candidate)) || null;
	if (!present || !projectRoot) return findings;

	const relPresent = toRelative(present, projectRoot);

	if (canonical && path.resolve(present) !== path.resolve(canonical)) {
		findings.push(
			finding({
				id: "design-sidecar-legacy-path",
				artifact: "design.json",
				path: relPresent,
				severity: "auto",
				summary: `The design sidecar sits at ${relPresent}, a location kept only for backward compatibility.`,
				fix: `Move it to ${toRelative(canonical, projectRoot)} the next time the sidecar is written. No user decision is needed.`,
			}),
		);
	}

	const sidecar = readJson(present);
	const schemaVersion = readSidecarSchemaVersion(sidecar);
	if (sidecar && (schemaVersion === null || schemaVersion < DESIGN_SIDECAR_SCHEMA_VERSION)) {
		findings.push(
			finding({
				id: "design-sidecar-schema-outdated",
				artifact: "design.json",
				path: relPresent,
				severity: "route",
				summary: `${relPresent} is schemaVersion ${schemaVersion === null ? "unset" : schemaVersion}; the current sidecar is ${DESIGN_SIDECAR_SCHEMA_VERSION}. Token primitives moved to the DESIGN.md frontmatter, so the old shape carries values that are now read from two places.`,
				fix: "Offer `document` to regenerate the sidecar. It reads the existing DESIGN.md, so no interview is needed.",
			}),
		);
	}

	if (designPath) {
		const designMtime = mtimeMs(designPath);
		const sidecarMtime = mtimeMs(present);
		if (designMtime !== null && sidecarMtime !== null && designMtime > sidecarMtime) {
			findings.push(
				finding({
					id: "design-sidecar-stale",
					artifact: "design.json",
					path: relPresent,
					severity: "mention",
					summary: `DESIGN.md was edited after ${relPresent} was generated, so the sidecar's ramps, shadows, motion tokens, and component snippets may contradict it.`,
					fix: "Offer `document` to refresh the sidecar, preserving DESIGN.md.",
				}),
			);
		}
	}

	return findings;
}

/**
 * Unrecognized keys in the shared and local configs. A key nothing reads is
 * indistinguishable from a working setting until someone checks, which is how a singular
 * `ignoreRule` silences nothing for months.
 */
function checkConfig({ projectRoot, repoRoot }: { readonly projectRoot?: string | null; readonly repoRoot?: string | null }): StalenessFinding[] {
	const findings: StalenessFinding[] = [];
	const roots = [...new Set([projectRoot, repoRoot].filter((root): root is string => !!root).map((root) => path.resolve(root)))];

	for (const root of roots) {
		for (const name of ["config.json", "config.local.json"]) {
			const filePath = path.join(root, ".impeccable", name);
			const raw = readJson(filePath);
			if (!raw) continue;
			const rel = toRelative(filePath, projectRoot || root);

			const unknownTop = Object.keys(raw).filter((key) => !KNOWN_CONFIG_KEYS.has(key));
			if (unknownTop.length > 0) {
				findings.push(
					finding({
						id: "config-unknown-keys",
						artifact: "config.json",
						path: rel,
						severity: "mention",
						summary: `${rel} has top-level key(s) nothing reads: ${unknownTop.map((key) => `\`${key}\``).join(", ")}. Recognized keys are ${[...KNOWN_CONFIG_KEYS].map((key) => `\`${key}\``).join(", ")}.`,
						fix: "Report the exact keys to the user. A near-miss of a real key is a setting that has never applied.",
					}),
				);
			}

			if (Object.prototype.hasOwnProperty.call(raw, "buildPath") && !BUILD_PATH_VALUES.includes(raw.buildPath as string)) {
				findings.push(
					finding({
						id: "config-invalid-build-path",
						artifact: "config.json",
						path: rel,
						severity: "mention",
						summary: `${rel} sets \`buildPath\` to ${JSON.stringify(raw.buildPath)}, which nothing reads. The values are ${BUILD_PATH_VALUES.map((value) => `\`${value}\``).join(" and ")}.`,
						fix: "Report the value. An unread `buildPath` does not fall back to the other path; it falls back to the default, so a project meaning `code` has been building comp-led.",
					}),
				);
			}

			const detector = raw.detector;
			if (detector && typeof detector === "object" && !Array.isArray(detector)) {
				const unknownDetector = Object.keys(detector).filter((key) => !KNOWN_DETECTOR_KEYS.has(key));
				if (unknownDetector.length > 0) {
					findings.push(
						finding({
							id: "config-unknown-detector-keys",
							artifact: "config.json",
							path: rel,
							severity: "mention",
							summary: `${rel} has \`detector\` key(s) nothing reads: ${unknownDetector.map((key) => `\`${key}\``).join(", ")}. Recognized keys are ${[...KNOWN_DETECTOR_KEYS].map((key) => `\`${key}\``).join(", ")}.`,
							fix: "Report the exact keys. `ignoreRule` for `ignoreRules` is the common one, and it silences nothing.",
						}),
					);
				}
			}
		}
	}
	return findings;
}

/**
 * No recorded build-path preference on a project that plainly does visual direction work.
 *
 * Not drift in the usual sense: the setting is newer than the project, so every project that
 * predates it lands here at once. That is why it is gated twice — on a product record and on
 * evidence of the work the setting governs — and why it hands the question to the reader
 * instead of assuming an answer. Image generation is the real precondition, and it leaves no
 * trace on disk.
 */
function checkBuildPathUnset({
	projectRoot,
	repoRoot,
	product,
}: {
	readonly projectRoot?: string | null;
	readonly repoRoot?: string | null;
	readonly product?: string | null;
}): StalenessFinding[] {
	if (!projectRoot || !product) return [];
	const roots = [...new Set([projectRoot, repoRoot].filter((root): root is string => !!root).map((root) => path.resolve(root)))];

	for (const root of roots) {
		for (const name of ["config.json", "config.local.json"]) {
			const raw = readJson(path.join(root, ".impeccable", name));
			// Any declared value ends this, valid or not: an invalid one already has its own
			// finding, and two reports of one key is noise.
			if (raw && Object.prototype.hasOwnProperty.call(raw, "buildPath")) return [];
		}
	}

	const evidence = DIRECTION_WORK_PATHS.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));
	if (evidence.length === 0) return [];

	return [
		finding({
			id: "config-build-path-unset",
			artifact: "config.json",
			path: ".impeccable/config.json",
			severity: "mention",
			summary: "This project has run visual direction work but records no `buildPath`, so every direction round takes the comp-first default without anyone having chosen it.",
			fix: 'Only when image generation exists in your tool surface, offer the choice once: **comp-first** (an image sets the bar before any code; bolder composition, slower) or **code-first** (build directly; ambition carried by the direction contract; leaner, faster). Write the answer to `.impeccable/config.json` as `"buildPath": "comp"` or `"buildPath": "code"`, merging with the keys already there. Without image generation there is no choice to record: stay silent.',
		}),
	];
}

/**
 * A brief whose primary target no longer exists still resolves, and is still injected as
 * authority for a surface that is gone. Route and URL targets have no file to check.
 */
function checkSurfaceBriefs({
	candidates = [],
	projectRoot,
}: {
	readonly candidates?: readonly BriefCandidate[];
	readonly projectRoot?: string | null;
}): StalenessFinding[] {
	if (!projectRoot) return [];
	const orphaned: BriefCandidate[] = [];

	for (const brief of candidates) {
		const target = brief?.primaryTarget;
		if (!target || typeof target !== "string") continue;
		if (/^https?:\/\//i.test(target) || target.startsWith("route:")) continue;
		if (!fs.existsSync(path.join(projectRoot, target))) orphaned.push(brief);
	}
	if (orphaned.length === 0) return [];

	return [
		finding({
			id: "surface-brief-orphaned",
			artifact: "surface brief",
			path: orphaned.map((brief) => brief.path).filter(Boolean).join(", ") || null,
			severity: "mention",
			summary: `${orphaned.length} persisted surface brief(s) name a primary target that no longer exists: ${orphaned.map((brief) => `${brief.path} → ${brief.primaryTarget}`).join("; ")}.`,
			fix: "Ask whether the surface moved (repoint the brief) or was removed (delete the brief). Until then the brief is authority for a file that is gone.",
		}),
	];
}

/**
 * `projectRoots` globs that match no directory. When every pattern misses, candidate
 * discovery returns nothing, the repo root silently becomes the active project, and no other
 * signal fires.
 *
 * Takes the candidate list rather than computing it: the boot path has already paid for that
 * walk, and this must not pay for it twice.
 */
function checkProjectRoots({
	patterns = [],
	candidates = [],
	configuredIn = ".impeccable/config.json",
}: {
	readonly patterns?: readonly string[];
	readonly candidates?: readonly WorkspaceCandidate[];
	readonly configuredIn?: string;
}): StalenessFinding[] {
	const positive = patterns.filter((pattern) => pattern && !String(pattern).trim().startsWith("!"));
	if (positive.length === 0 || candidates.length > 0) return [];
	return [
		finding({
			id: "config-project-roots-match-nothing",
			artifact: "config.json",
			path: configuredIn,
			severity: "mention",
			summary: `\`projectRoots\` declares ${positive.map((pattern) => `\`${pattern}\``).join(", ")}, but no directory matches any of them, so the repo root is being treated as the active project.`,
			fix: "Report the patterns and ask which directories they should name. A renamed workspace folder is the usual cause.",
		}),
	];
}

/**
 * Workspaces that inherit the repo-root PRODUCT.md. Inheritance is a feature, not a defect,
 * so this is information for the doctor pass rather than a boot finding: the judgment is
 * whether the inherited record actually describes that app.
 */
function describeWorkspaceContext(candidates: readonly WorkspaceCandidate[] = []): Array<Record<string, unknown>> {
	return candidates.map((candidate) => ({
		name: candidate.name,
		path: candidate.path,
		productStatus: candidate.productStatus,
		productPath: candidate.productPath,
		designStatus: candidate.designStatus,
		designPath: candidate.designPath,
	}));
}

/** The groups a boot report shows, keyed by artifact so a deeper report can interleave. */
export interface BootFindingGroups {
	readonly product: StalenessFinding[];
	readonly nativePlatform: StalenessFinding[];
	readonly designSidecar: StalenessFinding[];
	readonly config: StalenessFinding[];
	readonly buildPath: StalenessFinding[];
	readonly surfaceBriefs: StalenessFinding[];
	readonly projectRoots: StalenessFinding[];
}

/**
 * Everything a boot can afford, grouped by artifact. `extras` carries values the caller has
 * already computed, so nothing is recomputed here.
 */
function collectBootFindingGroups(
	ctx: StalenessContext | null | undefined,
	extras: {
		readonly absDesignPath?: string | null;
		readonly sidecarCandidates?: readonly string[];
		readonly projectRootPatterns?: readonly string[];
		readonly targetCandidates?: readonly WorkspaceCandidate[];
	} = {},
): Partial<BootFindingGroups> {
	if (!ctx) return {};
	const projectRoot = ctx.projectRoot || process.cwd();

	return {
		product: checkProduct(ctx.product, ctx.productPath || "PRODUCT.md"),
		// Checked only once a PRODUCT.md exists: without one the boot already routes into
		// init, which asks for the platform directly, and a second signal is noise.
		nativePlatform: ctx.product
			? checkNativePlatformEvidence({ projectRoot, platform: ctx.platform, product: ctx.product, productPath: ctx.productPath })
			: [],
		designSidecar: checkDesignSidecar({
			designPath: extras.absDesignPath || null,
			sidecarCandidates: extras.sidecarCandidates || [],
			projectRoot,
		}),
		config: checkConfig({ projectRoot, repoRoot: ctx.repoRoot }),
		buildPath: checkBuildPathUnset({ projectRoot, repoRoot: ctx.repoRoot, product: ctx.product }),
		surfaceBriefs: checkSurfaceBriefs({ candidates: ctx.surfaceBriefCandidates, projectRoot }),
		projectRoots: extras.projectRootPatterns
			? checkProjectRoots({ patterns: extras.projectRootPatterns, candidates: extras.targetCandidates || [] })
			: [],
	};
}

/** The flattened boot findings. */
function collectBootFindings(
	ctx: StalenessContext | null | undefined,
	extras: Parameters<typeof collectBootFindingGroups>[1] = {},
): StalenessFinding[] {
	return Object.values(collectBootFindingGroups(ctx, extras)).flat();
}

export {
	checkBuildPathUnset,
	checkConfig,
	checkDesignSidecar,
	checkNativePlatformEvidence,
	checkProduct,
	checkProjectRoots,
	checkSurfaceBriefs,
	collectBootFindingGroups,
	collectBootFindings,
	describeWorkspaceContext,
	designSidecarCandidatesFor,
	hasSection,
	toRelative,
};
