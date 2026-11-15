/**
 * The context loader: which project is active, where its product and design records live,
 * which surface brief applies, and whether the project already has a visual world. Ported
 * from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Resolution order, first match wins:
 *
 * 1. The active project root, when it holds PRODUCT.md or DESIGN.md. An explicit `--target`
 *    selects it: the workspace child in a monorepo, or the nearest directory around the
 *    target carrying context files in an ordinary repo.
 * 2. The active project's `.agents/context/`, then `docs/`.
 * 3. The repo root's context, the same way, as a fallback whenever the active project is
 *    nested below it.
 * 4. `IMPECCABLE_CONTEXT_DIR`, only consulted when the others are empty.
 * 5. The active project root, as the "nothing found" default.
 *
 * Two things upstream does that are deliberately absent here: the once-a-day network update
 * check (pi owns installs and upgrades) and the CLI's markdown assembly (pi composes its own
 * prompt sections from `loadContext`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSurfaceBrief, type SurfaceBriefResolution } from "./lib/surface-briefs.ts";
import { extractPlatform as extractPlatformValue } from "./lib/platform.ts";

const PRODUCT_NAMES = ["PRODUCT.md", "Product.md", "product.md"];
const DESIGN_NAMES = ["DESIGN.md", "Design.md", "design.md"];
const FALLBACK_DIRS = [".agents/context", "docs"];
const MONOREPO_MARKER_FILES = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];
const MONOREPO_FALLBACK_PROJECT_DIRS = ["apps", "packages"];

const WORKSPACE_DISCOVERY_IGNORED_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	"coverage",
	"vendor",
	"vendors",
]);

const VISUAL_SOURCE_DIRS = ["src", "app", "pages", "components", "site", "public", "styles"];
const STYLE_EXTENSIONS: ReadonlySet<string> = new Set([".css", ".scss", ".sass", ".less", ".styl"]);
const UI_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro"]);
const VISUAL_SCAN_FILE_LIMIT = 250;
const VISUAL_SCAN_DEPTH_LIMIT = 4;

/** Where a `--target` points, for the resolver. */
export interface ContextOptions {
	readonly targetPath?: string | null;
}

/** The resolved locations, before any file is read. */
export interface ResolvedContext {
	readonly contextDir: string;
	readonly productPath: string | null;
	readonly designPath: string | null;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly isMonorepo: boolean;
	readonly targetDir: string;
}

/** A discovered workspace, with how its context resolves. */
export interface TargetCandidate {
	readonly name: string;
	readonly path: string;
	readonly targetExample: string;
	readonly productStatus: ContextSourceStatus;
	readonly productPath: string | null;
	readonly designStatus: ContextSourceStatus;
	readonly designPath: string | null;
}

/** How a context file relates to the project it was found for. */
export type ContextSourceStatus = "child" | "inherited" | "missing" | "fallback";

/** A surface brief as the loader reports it. */
export interface LoadedSurfaceBrief {
	readonly slug: string | null;
	readonly path: string;
	readonly primaryTarget: string | null;
	readonly relatedTargets: readonly string[];
}

/** Everything a caller needs to decide what a session is working on. */
export interface LoadedContext {
	readonly hasProduct: boolean;
	readonly product: string | null;
	readonly productPath: string | null;
	readonly hasDesign: boolean;
	readonly design: string | null;
	readonly designPath: string | null;
	readonly contextDir: string;
	readonly productContextDir: string | null;
	readonly designContextDir: string | null;
	readonly hasSurfaceBrief: boolean;
	readonly surfaceBrief: string | null;
	readonly surfaceBriefPath: string | null;
	readonly surfaceBriefReason: string;
	readonly surfaceBriefCandidates: readonly LoadedSurfaceBrief[];
	readonly hasVisualImplementation: boolean;
	readonly platform: string | null;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly isMonorepo: boolean;
}

function readJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function firstExisting(dir: string, names: readonly string[]): string | null {
	for (const name of names) {
		const abs = path.join(dir, name);
		if (fs.existsSync(abs)) return abs;
	}
	return null;
}

function safeRead(p: string | null | undefined): string | null {
	if (!p) return null;
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

function hasTargetOption(options: ContextOptions | null | undefined): boolean {
	return !!(options && typeof options === "object" && options.targetPath && String(options.targetPath).trim());
}

function isPathInside(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
	return path.resolve(candidate) === path.resolve(root) || isPathInside(candidate, root);
}

function escapeRegExp(value: string): string {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Workspace patterns ────────────────────────────────────────────────────

function stripYamlInlineComment(line: string): string {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") {
			quote = quote === ch ? null : quote || ch;
			continue;
		}
		if (ch === "#" && !quote) return line.slice(0, i);
	}
	return line;
}

function unquoteYamlValue(value: string): string {
	return String(value || "")
		.trim()
		.replace(/^['"]|['"]$/g, "");
}

function parseYamlFlowList(body: string): string[] {
	const items: string[] = [];
	let quote: string | null = null;
	let current = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if ((ch === '"' || ch === "'") && body[i - 1] !== "\\") {
			quote = quote === ch ? null : quote || ch;
			current += ch;
			continue;
		}
		if (ch === "," && !quote) {
			const value = unquoteYamlValue(current);
			if (value) items.push(value);
			current = "";
			continue;
		}
		current += ch;
	}
	const value = unquoteYamlValue(current);
	if (value) items.push(value);
	return items;
}

function normalizeWorkspacePattern(pattern: unknown): string {
	return String(pattern || "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/^\.\//, "")
		.replace(/\/+$/, "");
}

function segmentMatches(patternSegment: string, relSegment: string): boolean {
	if (patternSegment === "*") return true;
	if (!patternSegment.includes("*")) return patternSegment === relSegment;
	const re = new RegExp(`^${escapeRegExp(patternSegment).replace(/\\\*/g, "[^/]*")}$`);
	return re.test(relSegment);
}

/** Explicit `projectRoots` globs from `.impeccable` config, in file order. */
function readImpeccableProjectRoots(repoRoot: string): string[] {
	const patterns: string[] = [];
	for (const name of ["config.json", "config.local.json"]) {
		const cfg = readJson(path.join(repoRoot, ".impeccable", name));
		const roots = cfg?.projectRoots;
		if (!Array.isArray(roots)) continue;
		for (const entry of roots) {
			if (typeof entry === "string" && entry.trim()) patterns.push(entry.trim());
		}
	}
	return patterns;
}

function readPackageWorkspaces(repoRoot: string): string[] {
	const pkg = readJson(path.join(repoRoot, "package.json"));
	const workspaces = pkg?.workspaces;
	if (Array.isArray(workspaces)) return workspaces.filter((entry): entry is string => typeof entry === "string");
	const packages = (workspaces as { packages?: unknown } | undefined)?.packages;
	if (Array.isArray(packages)) return packages.filter((entry): entry is string => typeof entry === "string");
	return [];
}

function readLernaWorkspaces(repoRoot: string): string[] {
	const lerna = readJson(path.join(repoRoot, "lerna.json"));
	return Array.isArray(lerna?.packages) ? lerna.packages.filter((entry): entry is string => typeof entry === "string") : [];
}

function readPnpmWorkspaces(repoRoot: string): string[] {
	try {
		const body = fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf-8");
		const patterns: string[] = [];
		let inPackages = false;
		for (const line of body.split(/\r?\n/)) {
			const trimmed = stripYamlInlineComment(line).trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const flowMatch = trimmed.match(/^packages:\s*\[(.*)\]\s*$/);
			if (flowMatch) {
				patterns.push(...parseYamlFlowList(flowMatch[1]));
				inPackages = false;
				continue;
			}
			if (/^packages:\s*$/.test(trimmed)) {
				inPackages = true;
				continue;
			}
			if (inPackages && /^[A-Za-z0-9_-]+:\s*/.test(trimmed)) break;
			if (inPackages) {
				const match = trimmed.match(/^-\s*(.+)$/);
				if (match) patterns.push(unquoteYamlValue(match[1]));
			}
		}
		return patterns;
	} catch {
		return [];
	}
}

/**
 * Project boundaries come from two sources, in precedence order: explicit `projectRoots`
 * globs, then package-manager workspace declarations. A path matched by any Impeccable
 * pattern — positive or negated — is governed by that group alone; package-manager patterns
 * only apply to paths the first group does not match. Within a group, negations win.
 */
function readProjectPatternGroups(repoRoot: string): [string[], string[]] {
	return [
		readImpeccableProjectRoots(repoRoot),
		[...readPackageWorkspaces(repoRoot), ...readPnpmWorkspaces(repoRoot), ...readLernaWorkspaces(repoRoot)].filter(Boolean),
	];
}

function readProjectPatterns(repoRoot: string): string[] {
	return readProjectPatternGroups(repoRoot).flat();
}

function workspacePatternMatchesRel(pattern: string, relSegments: readonly string[]): boolean {
	const patternSegments = normalizeWorkspacePattern(pattern).split("/").filter(Boolean);
	if (patternSegments.length === 0) return false;

	if (patternSegments.includes("**")) {
		const firstGlobIndex = patternSegments.findIndex((segment) => segment.includes("*"));
		const literalPrefix = firstGlobIndex === -1 ? patternSegments : patternSegments.slice(0, firstGlobIndex);
		if (relSegments.length < literalPrefix.length + 1) return false;
		for (let i = 0; i < literalPrefix.length; i++) {
			if (!segmentMatches(literalPrefix[i], relSegments[i])) return false;
		}
		return true;
	}

	if (relSegments.length < patternSegments.length) return false;
	for (let i = 0; i < patternSegments.length; i++) {
		if (!segmentMatches(patternSegments[i], relSegments[i])) return false;
	}
	return true;
}

function isExcludedByWorkspacePattern(relSegments: readonly string[], patterns: readonly string[]): boolean {
	return patterns.some((rawPattern) => {
		const pattern = normalizeWorkspacePattern(rawPattern);
		if (!pattern.startsWith("!")) return false;
		return workspacePatternMatchesRel(pattern.slice(1), relSegments);
	});
}

function nearestPackageRootBetween(repoRoot: string, targetDir: string, stopDir: string): string | null {
	let dir: string = path.resolve(targetDir);
	const stop = path.resolve(stopDir || repoRoot);
	const root = path.resolve(repoRoot);
	while (dir && dir !== stop && isPathInsideOrEqual(dir, root)) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function projectRootFromDoubleStarPattern(repoRoot: string, relSegments: readonly string[], patternSegments: readonly string[]): string | null {
	const firstGlobIndex = patternSegments.findIndex((segment) => segment.includes("*"));
	const literalPrefix = firstGlobIndex === -1 ? patternSegments : patternSegments.slice(0, firstGlobIndex);
	if (relSegments.length < literalPrefix.length + 1) return null;
	for (let i = 0; i < literalPrefix.length; i++) {
		if (!segmentMatches(literalPrefix[i], relSegments[i])) return null;
	}

	const prefixDir = path.join(repoRoot, ...literalPrefix);
	const targetDir = path.join(repoRoot, ...relSegments);
	const packageRoot = nearestPackageRootBetween(repoRoot, targetDir, prefixDir);
	if (packageRoot) return packageRoot;
	return path.join(repoRoot, ...relSegments.slice(0, literalPrefix.length + 1));
}

function projectRootFromWorkspacePattern(repoRoot: string, relSegments: readonly string[], rawPattern: string): string | null {
	const pattern = normalizeWorkspacePattern(rawPattern);
	if (!pattern || pattern.startsWith("!")) return null;
	const patternSegments = pattern.split("/").filter(Boolean);
	if (patternSegments.length === 0) return null;

	if (patternSegments.includes("**")) return projectRootFromDoubleStarPattern(repoRoot, relSegments, patternSegments);
	if (relSegments.length < patternSegments.length) return null;
	for (let i = 0; i < patternSegments.length; i++) {
		if (!segmentMatches(patternSegments[i], relSegments[i])) return null;
	}
	return path.join(repoRoot, ...relSegments.slice(0, patternSegments.length));
}

// ─── Discovery ─────────────────────────────────────────────────────────────

function isIgnoredWorkspaceDiscoveryDir(name: string): boolean {
	return name.startsWith(".") || WORKSPACE_DISCOVERY_IGNORED_DIRS.has(name);
}

function isCandidateProjectRoot(dir: string): boolean {
	return !!(
		fs.existsSync(path.join(dir, "package.json")) ||
		firstExisting(dir, [...PRODUCT_NAMES, ...DESIGN_NAMES]) ||
		fs.existsSync(path.join(dir, "src")) ||
		fs.existsSync(path.join(dir, "app")) ||
		fs.existsSync(path.join(dir, "pages")) ||
		fs.existsSync(path.join(dir, "public"))
	);
}

function directChildDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !isIgnoredWorkspaceDiscoveryDir(entry.name))
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

function walkDirs(root: string, visit: (dir: string) => void): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
		const dir = path.join(root, entry.name);
		visit(dir);
		walkDirs(dir, visit);
	}
}

function expandSimplePattern(repoRoot: string, patternSegments: readonly string[], index = 0, current = repoRoot): string[] {
	if (index >= patternSegments.length) return fs.existsSync(current) ? [current] : [];
	const segment = patternSegments[index];

	if (!segment.includes("*")) return expandSimplePattern(repoRoot, patternSegments, index + 1, path.join(current, segment));

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(current, { withFileTypes: true });
	} catch {
		return [];
	}

	const roots: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
		if (!segmentMatches(segment, entry.name)) continue;
		roots.push(...expandSimplePattern(repoRoot, patternSegments, index + 1, path.join(current, entry.name)));
	}
	return roots;
}

function discoverRootsForPattern(repoRoot: string, rawPattern: string): string[] {
	const pattern = normalizeWorkspacePattern(rawPattern);
	if (!pattern || pattern.startsWith("!")) return [];
	const segments = pattern.split("/").filter(Boolean);
	if (segments.length === 0) return [];

	const firstGlobIndex = segments.findIndex((segment) => segment.includes("*"));
	const literalPrefix = firstGlobIndex === -1 ? segments : segments.slice(0, firstGlobIndex);
	const base = path.join(repoRoot, ...literalPrefix);
	if (!fs.existsSync(base)) return [];

	if (segments.includes("**")) {
		const packageRoots: string[] = [];
		walkDirs(base, (dir) => {
			if (dir !== base && isCandidateProjectRoot(dir)) packageRoots.push(dir);
		});
		if (packageRoots.length > 0) return packageRoots;
		return directChildDirs(base);
	}

	return expandSimplePattern(repoRoot, segments);
}

function findTargetExample(repoRoot: string, projectRoot: string): string {
	const examples = [
		"src/App.jsx",
		"src/App.tsx",
		"src/main.jsx",
		"src/main.tsx",
		"src/index.jsx",
		"src/index.ts",
		"app/page.tsx",
		"pages/index.tsx",
		"public/index.html",
	];
	for (const rel of examples) {
		const abs = path.join(projectRoot, rel);
		if (fs.existsSync(abs)) return path.relative(repoRoot, abs).split(path.sep).join("/");
	}
	return path.relative(repoRoot, projectRoot).split(path.sep).join("/");
}

/**
 * How a discovered folder relates to its context file: `child` when the file sits directly
 * in the app root, `inherited` when it resolves from the repo root, `missing` when there is
 * none, and `fallback` for a subdirectory or an `IMPECCABLE_CONTEXT_DIR` override.
 */
function contextSourceStatus(filePath: string | null, repoRoot: string, projectRoot: string): ContextSourceStatus {
	if (!filePath) return "missing";
	const absPath = path.resolve(filePath);
	const absProjectRoot = path.resolve(projectRoot);
	const absRepoRoot = path.resolve(repoRoot);

	if (isPathInsideOrEqual(absPath, absProjectRoot)) return path.dirname(absPath) === absProjectRoot ? "child" : "fallback";
	if (absProjectRoot !== absRepoRoot && isPathInsideOrEqual(absPath, absRepoRoot)) return "inherited";
	return "fallback";
}

function contextSourcePath(filePath: string | null, repoRoot: string): string | null {
	if (!filePath) return null;
	const rel = path.relative(repoRoot, filePath);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
	return filePath;
}

// ─── Project resolution ────────────────────────────────────────────────────

function resolveTargetDir(cwd: string, options: ContextOptions = {}): string {
	const targetPath = options && typeof options === "object" ? options.targetPath : null;
	if (!targetPath || !String(targetPath).trim()) return cwd;

	const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
	try {
		const stat = fs.statSync(abs);
		return stat.isDirectory() ? abs : path.dirname(abs);
	} catch {
		return path.extname(abs) ? path.dirname(abs) : abs;
	}
}

function hasGitBoundary(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git"));
}

function hasFallbackWorkspaceChildren(dir: string): boolean {
	for (const name of MONOREPO_FALLBACK_PROJECT_DIRS) {
		const base = path.join(dir, name);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(base, { withFileTypes: true });
		} catch {
			continue;
		}
		if (entries.some((entry) => entry.isDirectory() && !isIgnoredWorkspaceDiscoveryDir(entry.name))) return true;
	}
	return false;
}

function isMonorepoRoot(dir: string): boolean {
	if (readProjectPatterns(dir).some((pattern) => !normalizeWorkspacePattern(pattern).startsWith("!"))) return true;
	if (!MONOREPO_MARKER_FILES.some((file) => fs.existsSync(path.join(dir, file)))) return false;
	return hasFallbackWorkspaceChildren(dir);
}

/**
 * The nearest monorepo root above `startDir`, or null. The monorepo check comes before the
 * `.git` boundary on purpose: a workspace root carrying its own `.git` is still recognized.
 * The trade-off is deliberate — a directory with a monorepo marker but no patterns and no
 * `apps`/`packages` children is not a root, so its `.git` stops the walk.
 */
function findMonorepoRoot(startDir: string): string | null {
	let dir = path.resolve(startDir);
	const homeDir = path.resolve(os.homedir());
	for (;;) {
		if (dir === homeDir) return null;
		if (isMonorepoRoot(dir)) return dir;
		if (hasGitBoundary(dir)) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveLocalContextDir(root: string): string | null {
	if (firstExisting(root, [...PRODUCT_NAMES, ...DESIGN_NAMES])) return root;
	for (const rel of FALLBACK_DIRS) {
		const candidate = path.resolve(root, rel);
		if (firstExisting(candidate, [...PRODUCT_NAMES, ...DESIGN_NAMES])) return candidate;
	}
	return null;
}

function resolveEnvContextDir(cwd: string): string | null {
	const envDir = process.env.IMPECCABLE_CONTEXT_DIR;
	if (!envDir || !envDir.trim()) return null;
	const trimmed = envDir.trim();
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

/**
 * With an explicit `--target` in an ordinary repository, a nested product's own context wins.
 * Walks from the target up to — but not including — the invocation root, and returns the
 * nearest directory carrying context files, in the canonical spot or a fallback dir. Context
 * files only, not `package.json`: without the monorepo root fallback, a `package.json` marker
 * would strand a target inside a plain subpackage, away from the root PRODUCT.md.
 */
function nearestTargetContextRoot(absCwd: string, targetDir: string): string | null {
	if (!isPathInside(targetDir, absCwd)) return null;
	const rootFallbackDirs = FALLBACK_DIRS.map((rel) => path.resolve(absCwd, rel));

	let dir: string = path.resolve(targetDir);
	while (dir && dir !== absCwd) {
		if (!rootFallbackDirs.includes(dir) && resolveLocalContextDir(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function nearestProjectLikeRoot(repoRoot: string, targetDir: string): string | null {
	let dir: string = path.resolve(targetDir);
	const stop = path.resolve(repoRoot);
	while (dir && dir !== stop) {
		if (firstExisting(dir, [...PRODUCT_NAMES, ...DESIGN_NAMES]) || fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function resolveWorkspaceProjectRoot(repoRoot: string, targetDir: string): string | null {
	const rel = path.relative(repoRoot, targetDir);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return repoRoot;
	const relSegments = rel.split(path.sep).filter(Boolean);

	for (const patterns of readProjectPatternGroups(repoRoot)) {
		if (isExcludedByWorkspacePattern(relSegments, patterns)) return repoRoot;
		for (const pattern of patterns) {
			const projectRoot = projectRootFromWorkspacePattern(repoRoot, relSegments, pattern);
			if (projectRoot) return projectRoot;
		}
	}

	if (relSegments.length >= 2 && MONOREPO_FALLBACK_PROJECT_DIRS.includes(relSegments[0])) {
		return path.join(repoRoot, relSegments[0], relSegments[1]);
	}

	return nearestProjectLikeRoot(repoRoot, targetDir) ?? repoRoot;
}

interface ResolvedProject {
	readonly targetDir: string;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly isMonorepo: boolean;
}

function resolveProject(cwd: string = process.cwd(), options: ContextOptions = {}): ResolvedProject {
	const absCwd = path.resolve(cwd);
	const targetDir = resolveTargetDir(absCwd, options);

	let repoRoot = findMonorepoRoot(targetDir);
	if (!repoRoot && targetDir !== absCwd) {
		const cwdRepoRoot = findMonorepoRoot(absCwd);
		if (cwdRepoRoot && isPathInside(targetDir, cwdRepoRoot)) repoRoot = cwdRepoRoot;
	}

	if (!repoRoot) {
		return {
			targetDir,
			projectRoot: nearestTargetContextRoot(absCwd, targetDir) || absCwd,
			repoRoot: absCwd,
			isMonorepo: false,
		};
	}

	return {
		targetDir,
		projectRoot: resolveWorkspaceProjectRoot(repoRoot, targetDir) || repoRoot,
		repoRoot,
		isMonorepo: true,
	};
}

function resolveContext(cwd: string = process.cwd(), options: ContextOptions = {}): ResolvedContext {
	const absCwd = path.resolve(cwd);
	const project = resolveProject(absCwd, options);
	const projectContextDir = resolveLocalContextDir(project.projectRoot);
	// Per-file inheritance from the repo root whenever the active project is nested below it:
	// monorepo children and explicit-target nested products behave the same way.
	const rootContextDir = project.repoRoot !== project.projectRoot ? resolveLocalContextDir(project.repoRoot) : null;

	let productPath =
		(projectContextDir ? firstExisting(projectContextDir, PRODUCT_NAMES) : null) ||
		(rootContextDir ? firstExisting(rootContextDir, PRODUCT_NAMES) : null);
	let designPath =
		(projectContextDir ? firstExisting(projectContextDir, DESIGN_NAMES) : null) ||
		(rootContextDir ? firstExisting(rootContextDir, DESIGN_NAMES) : null);

	let envContextDir: string | null = null;
	if (!productPath && !designPath) {
		envContextDir = resolveEnvContextDir(absCwd);
		if (envContextDir) {
			productPath = firstExisting(envContextDir, PRODUCT_NAMES);
			designPath = firstExisting(envContextDir, DESIGN_NAMES);
		}
	}

	return {
		contextDir: productPath ? path.dirname(productPath) : designPath ? path.dirname(designPath) : envContextDir || project.projectRoot,
		productPath,
		designPath,
		projectRoot: project.projectRoot,
		repoRoot: project.repoRoot,
		isMonorepo: project.isMonorepo,
		targetDir: project.targetDir,
	};
}

/** The directory whose context files govern this invocation. */
function resolveContextDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return resolveContext(cwd, options).contextDir;
}

/** The active project root, after target and workspace resolution. */
function resolveProjectRoot(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return resolveProject(cwd, options).projectRoot;
}

function resolveCandidateContextSummary(repoRoot: string, projectRoot: string, targetPath: string): Pick<TargetCandidate, "productStatus" | "productPath" | "designStatus" | "designPath"> {
	const ctx = resolveContext(repoRoot, { targetPath });
	return {
		productStatus: contextSourceStatus(ctx.productPath, repoRoot, projectRoot),
		productPath: contextSourcePath(ctx.productPath, repoRoot),
		designStatus: contextSourceStatus(ctx.designPath, repoRoot, projectRoot),
		designPath: contextSourcePath(ctx.designPath, repoRoot),
	};
}

/**
 * A discovered folder is selectable only when picking it resolves back to itself. Impeccable
 * `projectRoots` patterns govern every path they match: a negation drops the candidate, and a
 * positive match with a different boundary drops it too, because the boundary root is already
 * its own candidate. Paths the Impeccable group does not match fall through to the
 * package-manager negations.
 */
function isSelectableCandidate(repoRoot: string, rel: string, patternGroups: [string[], string[]]): boolean {
	const relSegments = rel.split("/").filter(Boolean);
	const [impeccablePatterns, packagePatterns] = patternGroups;

	if (isExcludedByWorkspacePattern(relSegments, impeccablePatterns)) return false;
	for (const pattern of impeccablePatterns) {
		const boundary = projectRootFromWorkspacePattern(repoRoot, relSegments, pattern);
		if (boundary) return path.resolve(boundary) === path.resolve(path.join(repoRoot, ...relSegments));
	}
	return !isExcludedByWorkspacePattern(relSegments, packagePatterns);
}

/** Every workspace child of a repo root, with how each one's context resolves. */
function discoverTargetCandidates(repoRoot: string): TargetCandidate[] {
	const roots = new Map<string, string>();
	const patternGroups = readProjectPatternGroups(repoRoot);

	for (const patterns of patternGroups) {
		for (const pattern of patterns) {
			for (const root of discoverRootsForPattern(repoRoot, pattern)) {
				roots.set(path.relative(repoRoot, root).split(path.sep).join("/"), root);
			}
		}
	}

	if (MONOREPO_MARKER_FILES.some((file) => fs.existsSync(path.join(repoRoot, file)))) {
		for (const name of MONOREPO_FALLBACK_PROJECT_DIRS) {
			const base = path.join(repoRoot, name);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(base, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
				const root = path.join(base, entry.name);
				roots.set(path.relative(repoRoot, root).split(path.sep).join("/"), root);
			}
		}
	}

	return [...roots.entries()]
		.filter(([rel]) => rel && !rel.startsWith(".."))
		.filter(([rel]) => isSelectableCandidate(repoRoot, rel, patternGroups))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([rel, root]) => {
			const targetExample = findTargetExample(repoRoot, root);
			return {
				name: path.basename(root),
				path: rel,
				targetExample,
				...resolveCandidateContextSummary(repoRoot, root, targetExample),
			};
		});
}

/** What a caller must choose between when no target was given and the active project is the repo root. */
export interface TargetSelection {
	readonly targetPath: null;
	readonly projectRoot: string;
	readonly repoRoot: string;
	readonly targetCandidates: readonly TargetCandidate[];
}

/**
 * The workspace list a caller should present when it has no target and the active project is
 * a monorepo root. Null means "nothing to choose": not a monorepo, already narrowed to a
 * child, or no discoverable children at all — in which case the repo root is the active
 * project rather than an unanswerable prompt.
 */
function resolveTargetSelection(cwd: string = process.cwd(), options: ContextOptions = {}): TargetSelection | null {
	if (hasTargetOption(options)) return null;

	const project = resolveProject(cwd);
	if (!project.isMonorepo || !project.projectRoot || !project.repoRoot) return null;
	if (path.resolve(project.projectRoot) !== path.resolve(project.repoRoot)) return null;

	const targetCandidates = discoverTargetCandidates(project.repoRoot);
	if (targetCandidates.length === 0) return null;

	return { targetPath: null, projectRoot: project.projectRoot, repoRoot: project.repoRoot, targetCandidates };
}

// ─── Reading ───────────────────────────────────────────────────────────────

/**
 * Best-effort evidence that the project already has an incumbent visual implementation.
 * A design document is not the only source of design authority: real tokens, chosen type, and
 * a component system in code must not be mistaken for a greenfield identity merely because
 * the document is absent. The scan is bounded (250 files, four levels) and conservative: a
 * package.json or one empty scaffold component is not enough, a tokenized stylesheet or
 * several styled components is.
 */
function hasVisualImplementation(projectRoot: string | null | undefined): boolean {
	if (!projectRoot) return false;
	const root = path.resolve(projectRoot);

	const queue: Array<{ dir: string; depth: number }> = [];
	for (const rel of VISUAL_SOURCE_DIRS) {
		const dir = path.join(root, rel);
		if (fs.existsSync(dir)) queue.push({ dir, depth: 0 });
	}

	let scannedFiles = 0;
	let styledComponents = 0;

	const inspectFile = (filePath: string): boolean => {
		const ext = path.extname(filePath).toLowerCase();
		if (!STYLE_EXTENSIONS.has(ext) && !UI_EXTENSIONS.has(ext)) return false;

		const base = path.basename(filePath).toLowerCase();
		if (/\.min\.[a-z]+$/.test(base)) return false;
		if (scannedFiles++ >= VISUAL_SCAN_FILE_LIMIT) return false;

		let body: string;
		try {
			body = fs.readFileSync(filePath, "utf-8").slice(0, 64 * 1024);
		} catch {
			return false;
		}

		// Comments are stripped so the evidence is real code, not prose about it.
		const evidence = body
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/^\s*\/\/.*$/gm, "");

		if (STYLE_EXTENSIONS.has(ext)) {
			const customProperties = evidence.match(/--[a-z0-9_-]+\s*:/gi)?.length ?? 0;
			const visualDeclarations = evidence.match(/\b(?:color|background(?:-color)?|border(?:-color)?|font-family)\s*:/gi)?.length ?? 0;
			if (/\b(?:tokens?|theme|design-system)\b/.test(base) && evidence.trim().length > 80) return true;
			if (customProperties >= 3 || visualDeclarations >= 5) return true;
		}

		if ((ext === ".html" || ext === ".htm") && evidence.length > 600 && /<style\b|<link[^>]+stylesheet/i.test(evidence)) return true;

		if (![".html", ".htm"].includes(ext) && evidence.length > 300) {
			const embeddedCustomProperties = evidence.match(/--[a-z0-9_-]+\s*:/gi)?.length ?? 0;
			const embeddedVisualDeclarations = evidence.match(/\b(?:color|background(?:-color)?|border(?:-color)?|font-family)\s*:/gi)?.length ?? 0;
			const classTokens = [...evidence.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/gi)].reduce(
				(count, match) => count + match[1].trim().split(/\s+/).length,
				0,
			);
			if ((embeddedCustomProperties >= 3 && embeddedVisualDeclarations >= 3) || embeddedVisualDeclarations >= 5 || classTokens >= 12) return true;
		}

		if (![".html", ".htm"].includes(ext) && evidence.length > 300 && /class(?:Name)?\s*=|style\s*=|styled\(|css`/i.test(evidence)) {
			styledComponents += 1;
			if (styledComponents >= 3) return true;
		}
		return false;
	};

	// Root-level authored surfaces and styles are common in small projects.
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (entry.isFile() && inspectFile(path.join(root, entry.name))) return true;
		}
	} catch {
		// Unreadable root: no evidence.
	}

	while (queue.length > 0 && scannedFiles < VISUAL_SCAN_FILE_LIMIT) {
		const current = queue.shift();
		if (!current) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (current.depth >= VISUAL_SCAN_DEPTH_LIMIT || entry.name.startsWith(".") || WORKSPACE_DISCOVERY_IGNORED_DIRS.has(entry.name)) continue;
				queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
			} else if (entry.isFile() && inspectFile(path.join(current.dir, entry.name))) {
				return true;
			}
			if (scannedFiles >= VISUAL_SCAN_FILE_LIMIT) break;
		}
	}
	return styledComponents >= 3;
}

/**
 * The first non-empty line under a bare `## <heading>` section of a product record, or null
 * when the section is absent or empty. The heading match is exact, so a near-miss heading does
 * not shadow the real field.
 */
function extractSectionValue(product: string | null | undefined, heading: string): string | null {
	if (!product) return null;
	const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
	const lines = product.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (!headingRe.test(lines[i].trim())) continue;
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			// A new heading before any value means the section is empty.
			if (/^#{1,6}\s/.test(next)) return null;
			if (next) return next;
		}
	}
	return null;
}

/**
 * Everything a caller needs to decide what the session is working on.
 *
 * The surface brief resolves against the project root, and a named target narrows it: with no
 * target, a single brief applies and several do not.
 */
function loadContext(cwd: string = process.cwd(), options: ContextOptions = {}): LoadedContext {
	const resolved = resolveContext(cwd, options);
	const absCwd = path.resolve(cwd);
	const productPath = resolved.productPath;
	const designPath = resolved.designPath;
	const product = productPath ? safeRead(productPath) : null;
	const design = designPath ? safeRead(designPath) : null;
	const platform = extractPlatformValue(product);

	const surfaceResolution: SurfaceBriefResolution = resolveSurfaceBrief(
		resolved.projectRoot,
		hasTargetOption(options) ? (options.targetPath as string) : null,
	);
	const surfaceBrief = surfaceResolution.brief;

	return {
		hasProduct: !!product,
		product,
		productPath: productPath ? path.relative(absCwd, productPath) : null,
		hasDesign: !!design,
		design,
		designPath: designPath ? path.relative(absCwd, designPath) : null,
		contextDir: resolved.contextDir,
		productContextDir: productPath ? path.dirname(productPath) : null,
		designContextDir: designPath ? path.dirname(designPath) : null,
		hasSurfaceBrief: !!surfaceBrief,
		surfaceBrief: surfaceBrief?.text ?? null,
		surfaceBriefPath: surfaceBrief?.path ? path.relative(absCwd, surfaceBrief.path) : null,
		surfaceBriefReason: surfaceResolution.reason,
		surfaceBriefCandidates: surfaceResolution.candidates.map((brief) => ({
			slug: brief.slug,
			path: brief.path ? path.relative(absCwd, brief.path) : "",
			primaryTarget: brief.primaryTarget,
			relatedTargets: brief.relatedTargets,
		})),
		hasVisualImplementation: hasVisualImplementation(resolved.projectRoot),
		platform,
		projectRoot: resolved.projectRoot,
		repoRoot: resolved.repoRoot,
		isMonorepo: resolved.isMonorepo,
	};
}

export {
	discoverTargetCandidates,
	extractSectionValue,
	findMonorepoRoot,
	hasVisualImplementation,
	isMonorepoRoot,
	loadContext,
	PRODUCT_NAMES,
	DESIGN_NAMES,
	readProjectPatternGroups,
	resolveContext,
	resolveContextDir,
	resolveProjectRoot,
	resolveTargetSelection,
	WORKSPACE_DISCOVERY_IGNORED_DIRS,
};
