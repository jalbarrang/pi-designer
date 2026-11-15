/**
 * The staleness checks too expensive for a boot: git history, workspace sweeps, ignore-list
 * validation, and retired locations. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The boot tier answers "did an older version write this". This tier also asks "does it still
 * describe the code", which no file comparison can settle alone. Where the answer needs
 * judgment, the finding reports a measured proxy and says so: a large commit count means a
 * document is worth re-reading, not that it is wrong.
 *
 * The hook-installation check is deliberately absent. Upstream verifies the hook manifests of
 * six other harnesses; pi registers no hooks, so there is no manifest to verify and no
 * "installed but disabled" contradiction to catch.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { StalenessFinding } from "./staleness.ts";

const VISUAL_SOURCE_DIRS: readonly string[] = ["src", "app", "pages", "components", "site", "styles", "public"];

/** Retired live-mode locations. The path helpers still read them; reporting them lets the fallbacks go. */
const LEGACY_LIVE_PATHS: readonly string[] = [".impeccable-live.json", ".impeccable-live"];

function finding(entry: StalenessFinding): StalenessFinding {
	return entry;
}

function readJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function toRelative(filePath: string | null | undefined, root: string): string | null {
	if (!filePath) return null;
	const rel = path.relative(root, filePath);
	return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : filePath;
}

/** A trimmed command output, or null when git is missing, slow, or unhappy. */
function git(args: readonly string[], cwd: string): string | null {
	try {
		return execFileSync("git", args as string[], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * How much UI work has landed since the design record was last touched, measured in commits
 * to the visual source directories.
 *
 * This is a proxy and is reported as one. Silent outside a git repo, on an untracked record,
 * and when the count is small enough to be ordinary maintenance.
 */
function checkDesignDrift({
	designPath,
	projectRoot,
	threshold = 25,
}: {
	readonly designPath?: string | null;
	readonly projectRoot?: string | null;
	readonly threshold?: number;
}): StalenessFinding[] {
	if (!designPath || !projectRoot) return [];
	if (!git(["rev-parse", "--is-inside-work-tree"], projectRoot)) return [];

	const relDesign = toRelative(designPath, projectRoot);
	if (!relDesign) return [];
	const lastDesignCommit = git(["log", "-1", "--format=%H", "--", relDesign], projectRoot);
	if (!lastDesignCommit) return [];

	const dirs = VISUAL_SOURCE_DIRS.filter((dir) => fs.existsSync(path.join(projectRoot, dir)));
	if (dirs.length === 0) return [];

	const log = git(["log", "--oneline", `${lastDesignCommit}..HEAD`, "--", ...dirs], projectRoot);
	if (log === null) return [];
	const commits = log ? log.split("\n").filter(Boolean).length : 0;
	if (commits < threshold) return [];

	const when = git(["log", "-1", "--format=%ad", "--date=short", "--", relDesign], projectRoot);
	return [
		finding({
			id: "design-md-drift",
			artifact: "DESIGN.md",
			path: relDesign,
			severity: "route",
			summary: `${commits} commits have touched ${dirs.join(", ")} since ${relDesign} was last edited${when ? ` (${when})` : ""}. This counts commits, not contradictions: it says the document is worth re-reading, not that it is wrong.`,
			fix: "Read DESIGN.md against the current tokens and components before trusting it as authority. If it has genuinely drifted, `document` regenerates it from the code.",
		}),
	];
}

/** True when a coverage value carries something: a non-empty string, a populated array, a populated object. */
function hasCoverageValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasCoverageValue);
	if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasCoverageValue);
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 && !/^(?:\[\s*\]|\{\s*\})$/.test(trimmed);
	}
	return false;
}

/** The marker a seed record carries, telling a reader it was written before any code existed. */
const SEED_DESIGN_MARKERS: readonly string[] = ["/", "$"].map(
	(prefix) => `<!-- SEED: established with the user before implementation; re-run ${prefix}impeccable document once there's code to capture the actual tokens and components. -->`,
);

/** The model subset this reads, so it does not import the parser. */
export interface DesignModelLike {
	readonly [section: string]: unknown;
	readonly frontmatter?: Record<string, unknown> | null;
}

/**
 * Canonical sections that carry nothing. Distinct from drift: a section can be absent because
 * it never applied, so this is a documentation gap for a human to judge, never an error.
 */
function checkDesignCoverage({
	design,
	designPath,
	parseDesignMd,
}: {
	readonly design?: string | null;
	readonly designPath?: string | null;
	readonly parseDesignMd?: ((markdown: string) => DesignModelLike) | null;
}): StalenessFinding[] {
	if (!design || typeof parseDesignMd !== "function") return [];

	let model: DesignModelLike;
	try {
		model = parseDesignMd(design);
	} catch {
		return [];
	}

	const isSeed = SEED_DESIGN_MARKERS.some((marker) => design.includes(marker));
	const requiredSections = isSeed ? ["colors", "typography"] : ["colors", "typography", "components"];
	const missing = requiredSections.filter((section) => !model[section] && !hasCoverageValue(model.frontmatter?.[section]));
	if (missing.length === 0) return [];

	return [
		finding({
			id: "design-md-coverage",
			artifact: "DESIGN.md",
			path: designPath ?? null,
			severity: "mention",
			summary: `${designPath || "DESIGN.md"} has no ${missing.join(", ")} section. Agents generating new screens get no normative guidance for those, and the live design panel renders generic approximations in their place.`,
			fix: "Ask whether the section never applied or was never written. `document` fills it from the code if the project has the answer in its CSS.",
		}),
	];
}

/**
 * Ignore entries that no longer match anything: rule ids the engine dropped or renamed, and
 * file paths that are gone. Both read as working suppressions until someone checks, and a dead
 * rule ignore also hides that the rule left.
 */
function checkDetectorIgnores({
	projectRoot,
	knownRuleIds = null,
}: {
	readonly projectRoot?: string | null;
	readonly knownRuleIds?: ReadonlySet<string> | null;
}): StalenessFinding[] {
	const findings: StalenessFinding[] = [];
	if (!projectRoot) return findings;

	for (const name of ["config.json", "config.local.json"]) {
		const filePath = path.join(projectRoot, ".impeccable", name);
		const raw = readJson(filePath);
		const detector = raw?.detector;
		if (!detector || typeof detector !== "object") continue;
		const rel = toRelative(filePath, projectRoot);

		const ignoreRules = (detector as { ignoreRules?: unknown }).ignoreRules;
		if (knownRuleIds && Array.isArray(ignoreRules)) {
			const unknown = ignoreRules
				.map((rule) => String(rule || "").trim().toLowerCase())
				.filter((rule) => rule && rule !== "*" && !knownRuleIds.has(rule));
			if (unknown.length > 0) {
				findings.push(
					finding({
						id: "detector-ignore-rules-unknown",
						artifact: "config.json",
						path: rel,
						severity: "mention",
						summary: `${rel} ignores rule id(s) the detector does not have: ${unknown.map((rule) => `\`${rule}\``).join(", ")}. Either the rule was renamed or removed, or the id was mistyped and has never suppressed anything.`,
						fix: "Report the exact ids. Removing them is safe; keeping a dead ignore hides that the rule is gone.",
					}),
				);
			}
		}

		const ignoreFiles = (detector as { ignoreFiles?: unknown }).ignoreFiles;
		if (Array.isArray(ignoreFiles)) {
			const missing = ignoreFiles
				.map((entry) => String(entry || "").trim())
				.filter((entry) => entry && !entry.includes("*") && !fs.existsSync(path.join(projectRoot, entry)));
			if (missing.length > 0) {
				findings.push(
					finding({
						id: "detector-ignore-files-missing",
						artifact: "config.json",
						path: rel,
						severity: "mention",
						summary: `${rel} ignores file path(s) that no longer exist: ${missing.map((entry) => `\`${entry}\``).join(", ")}.`,
						fix: "Ask whether the file moved (repoint the entry) or was deleted (drop it). A stale entry silently stops covering the file that replaced it.",
					}),
				);
			}
		}
	}
	return findings;
}

/** Live-mode state in a retired location. Read through fallbacks, safe to delete once nothing runs. */
function checkLegacyLiveState({ projectRoot }: { readonly projectRoot?: string | null }): StalenessFinding[] {
	if (!projectRoot) return [];
	const present = LEGACY_LIVE_PATHS.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));
	if (present.length === 0) return [];

	return [
		finding({
			id: "legacy-live-state",
			artifact: "live state",
			path: present.join(", "),
			severity: "auto",
			summary: `Live-mode state sits in retired location(s): ${present.map((rel) => `\`${rel}\``).join(", ")}. Current live mode writes under \`.impeccable/live/\`.`,
			fix: "These are read only through backward-compatible fallbacks and are safe to delete once no live session is running. No user decision is needed.",
		}),
	];
}

/** A discovered workspace, as this check reads one. */
export interface WorkspaceInput {
	readonly name: string;
	readonly path: string;
	readonly productStatus?: string;
	readonly productPath?: string | null;
	readonly designStatus?: string;
	readonly designPath?: string | null;
}

/** One workspace line in the report. */
export interface WorkspaceReport {
	readonly name: string;
	readonly path: string;
	readonly productStatus: string | undefined;
	readonly productPath: string | null | undefined;
	readonly designStatus: string | undefined;
	readonly designPath: string | null | undefined;
	readonly platform: string | null;
}

/**
 * Per-workspace context, plus the case worth acting on: a workspace with native build files
 * inheriting a repo-root record that says web. That app gets web guidance and never loads the
 * native references, and nothing at boot reports it because the root record parses cleanly.
 */
function checkWorkspaces({
	repoRoot,
	candidates = [],
	checkNativePlatformEvidence,
	extractPlatform,
	readFile,
}: {
	readonly repoRoot?: string | null;
	readonly candidates?: readonly WorkspaceInput[];
	readonly checkNativePlatformEvidence?: (input: {
		readonly projectRoot: string;
		readonly platform: string | null;
		readonly product: string | null;
		readonly productPath: string | null | undefined;
	}) => StalenessFinding[];
	readonly extractPlatform?: ((product: string | null) => string | null) | null;
	readonly readFile?: ((filePath: string) => string | null) | null;
}): { findings: StalenessFinding[]; workspaces: WorkspaceReport[] } {
	if (!repoRoot || candidates.length === 0) return { findings: [], workspaces: [] };

	const findings: StalenessFinding[] = [];
	const workspaces: WorkspaceReport[] = [];

	for (const candidate of candidates) {
		const workspaceRoot = path.join(repoRoot, candidate.path);
		const productPath = candidate.productPath ? path.join(repoRoot, candidate.productPath) : null;
		const product = productPath && readFile ? readFile(productPath) : null;
		const platform = extractPlatform ? extractPlatform(product) : null;

		workspaces.push({
			name: candidate.name,
			path: candidate.path,
			productStatus: candidate.productStatus,
			productPath: candidate.productPath,
			designStatus: candidate.designStatus,
			designPath: candidate.designPath,
			platform: platform || (product ? "web (default)" : null),
		});

		if (!checkNativePlatformEvidence) continue;
		const native = checkNativePlatformEvidence({ projectRoot: workspaceRoot, platform, product, productPath: candidate.productPath });
		for (const entry of native) {
			findings.push(
				finding({
					id: "workspace-platform-native-evidence",
					artifact: "PRODUCT.md",
					path: candidate.productPath || `${candidate.path}/PRODUCT.md`,
					severity: "mention",
					summary: `Workspace \`${candidate.path}\` ${candidate.productStatus === "inherited" ? "inherits the repo-root PRODUCT.md" : "has a PRODUCT.md"} that resolves to web, but the workspace itself carries native build files. ${entry.summary}`,
					fix:
						candidate.productStatus === "inherited"
							? `Give \`${candidate.path}\` its own PRODUCT.md with the right \`## Platform\`. An inherited record cannot describe two platforms at once.`
							: entry.fix,
				}),
			);
		}
	}

	const inherited = workspaces.filter((entry) => entry.productStatus === "inherited");
	if (inherited.length > 0) {
		findings.push(
			finding({
				id: "workspace-context-inherited",
				artifact: "PRODUCT.md",
				path: null,
				severity: "mention",
				summary: `${inherited.length} of ${workspaces.length} workspace(s) inherit the repo-root PRODUCT.md: ${inherited.map((entry) => `\`${entry.path}\``).join(", ")}. Inheritance is intended; whether one record truthfully describes these apps is not something this check can tell.`,
				fix: "Ask the user whether the inherited record describes each app. Where it does not, `init` in that workspace writes a child PRODUCT.md that overrides it.",
			}),
		);
	}

	return { findings, workspaces };
}

/** True when the visual source directories exist at all, which is what drift needs to measure. */
function hasVisualSources(projectRoot: string): boolean {
	return VISUAL_SOURCE_DIRS.some((dir) => fs.existsSync(path.join(projectRoot, dir)));
}

export {
	checkDesignCoverage,
	checkDesignDrift,
	checkDetectorIgnores,
	checkLegacyLiveState,
	checkWorkspaces,
	hasCoverageValue,
	hasVisualSources,
	LEGACY_LIVE_PATHS,
	SEED_DESIGN_MARKERS,
	VISUAL_SOURCE_DIRS,
};
