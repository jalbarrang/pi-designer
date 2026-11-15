/**
 * The doctor: a deep pass over a project's artifacts, reporting drift and applying only the
 * migrations that carry no decision. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The boot check reports what a session can afford to measure; this runs everything — git
 * drift, the per-workspace sweep, ignore-list validation against the live rule catalog, and
 * retired locations.
 *
 * `applyFixes` is deliberately narrow: it performs only the migrations marked `auto`, the ones
 * with no judgment in them — move a sidecar out of a retired location, stamp the product
 * record. Anything that needs an answer (a platform value, whether an inherited record still
 * describes an app, whether a document has drifted from the code) is reported and left alone.
 * Findings are not errors, so the result carries no failure state of its own.
 */
import fs from "node:fs";
import path from "node:path";
import { loadContext, resolveTargetSelection, type LoadedContext } from "./context.ts";
import { parseTargetOptions } from "./lib/target-args.ts";
import { parseDesignMd } from "./lib/design-parser.ts";
import {
	PRODUCT_SCHEMA_VERSION,
	readProductSchemaVersion,
	stampProductSchema,
} from "./lib/artifact-schema.ts";
import {
	checkNativePlatformEvidence,
	collectBootFindingGroups,
	designSidecarCandidatesFor,
	toRelative,
	type StalenessFinding,
} from "./lib/staleness.ts";
import {
	checkDesignCoverage,
	checkDesignDrift,
	checkDetectorIgnores,
	checkLegacyLiveState,
	checkWorkspaces,
	VISUAL_SOURCE_DIRS,
	type WorkspaceReport,
	type DesignModelLike,
} from "./lib/staleness-deep.ts";
import { extractPlatform } from "./lib/platform.ts";
import { ANTIPATTERNS } from "./core/registry/antipatterns.ts";
import { IMPECCABLE_COMMAND } from "./lib/provider.ts";

function safeRead(filePath: string | null | undefined): string | null {
	if (!filePath) return null;
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/** Options for a doctor run, matching the command line's flags. */
export interface DoctorOptions {
	readonly targetPath?: string | null;
	/** Apply the `auto` migrations. */
	readonly fix?: boolean;
}

/** Everything a report carries, before it is rendered. */
export interface DoctorReport {
	readonly ctx: LoadedContext;
	readonly projectRoot: string;
	readonly absProductPath: string | null;
	readonly sidecarCandidates: readonly string[];
	readonly findings: readonly StalenessFinding[];
	readonly workspaces: readonly WorkspaceReport[];
	readonly ruleRegistryAvailable: boolean;
}

/** The rule ids the bundled detector knows, which is what an ignore list is validated against. */
function loadKnownRuleIds(): Set<string> | null {
	try {
		if (!Array.isArray(ANTIPATTERNS)) return null;
		return new Set(ANTIPATTERNS.map((rule) => String(rule.id).toLowerCase()));
	} catch {
		return null;
	}
}

/** The project root patterns a repo declares, for the "matches nothing" check. */
function readProjectRootPatterns(repoRoot: string | null | undefined): string[] {
	if (!repoRoot) return [];
	const patterns: string[] = [];
	for (const name of ["config.json", "config.local.json"]) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, ".impeccable", name), "utf-8")) as { projectRoots?: unknown };
			if (!Array.isArray(raw?.projectRoots)) continue;
			for (const entry of raw.projectRoots) {
				if (typeof entry === "string" && entry.trim()) patterns.push(entry.trim());
			}
		} catch {
			// Missing or malformed: nothing to check.
		}
	}
	return patterns;
}

/** The full report: boot findings plus the expensive tier, in one list. */
function collect(cwd: string = process.cwd(), options: DoctorOptions = {}): DoctorReport {
	const targetOptions = options.targetPath ? { targetPath: options.targetPath } : {};
	const ctx = loadContext(cwd, targetOptions);
	const projectRoot = ctx.projectRoot || cwd;
	const absProductPath = ctx.productPath ? path.resolve(cwd, ctx.productPath) : null;
	const absDesignPath = ctx.designPath ? path.resolve(cwd, ctx.designPath) : null;
	const sidecarCandidates = designSidecarCandidatesFor(projectRoot, ctx.contextDir);
	const knownRuleIds = loadKnownRuleIds();

	const selection = resolveTargetSelection(cwd, targetOptions);
	const workspaceCandidates = selection?.targetCandidates ?? [];

	const workspaceResult = checkWorkspaces({
		repoRoot: ctx.repoRoot,
		candidates: workspaceCandidates,
		checkNativePlatformEvidence,
		extractPlatform,
		readFile: safeRead,
	});

	const bootFindings = collectBootFindingGroups(ctx, {
		absDesignPath,
		sidecarCandidates,
		projectRootPatterns: readProjectRootPatterns(ctx.repoRoot),
		targetCandidates: workspaceCandidates,
	});

	const findings: StalenessFinding[] = [
		...(bootFindings.product ?? []),
		...(bootFindings.nativePlatform ?? []),
		...(bootFindings.designSidecar ?? []),
		...checkDesignDrift({ designPath: absDesignPath, projectRoot }),
		...checkDesignCoverage({ design: ctx.design, designPath: ctx.designPath, parseDesignMd: (markdown: string) => parseDesignMd(markdown) as unknown as DesignModelLike }),
		...(bootFindings.config ?? []),
		...(bootFindings.buildPath ?? []),
		...checkDetectorIgnores({ projectRoot, knownRuleIds }),
		...(bootFindings.surfaceBriefs ?? []),
		...checkLegacyLiveState({ projectRoot }),
		...(bootFindings.projectRoots ?? []),
		...workspaceResult.findings,
	];

	return {
		ctx,
		projectRoot,
		absProductPath,
		sidecarCandidates,
		findings,
		workspaces: workspaceResult.workspaces,
		ruleRegistryAvailable: knownRuleIds !== null,
	};
}

/** What a fix run did, and what it deliberately left for the user. */
export interface FixResult {
	readonly applied: readonly string[];
	readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/**
 * Apply only the migrations that carry no decision. A migration that would overwrite an
 * existing file, or delete live session state, is left for the user.
 */
function applyFixes(report: DoctorReport): FixResult {
	const applied: string[] = [];
	const skipped: Array<{ id: string; reason: string }> = [];

	for (const entry of report.findings) {
		if (entry.severity !== "auto") {
			skipped.push({ id: entry.id, reason: "needs a decision from the user" });
			continue;
		}

		if (entry.id === "design-sidecar-legacy-path") {
			const canonical = report.sidecarCandidates[0];
			const present = report.sidecarCandidates.find((candidate) => fs.existsSync(candidate));
			if (!canonical || !present || path.resolve(canonical) === path.resolve(present)) continue;
			if (fs.existsSync(canonical)) {
				skipped.push({ id: entry.id, reason: `${toRelative(canonical, report.projectRoot)} already exists; not overwriting` });
				continue;
			}
			fs.mkdirSync(path.dirname(canonical), { recursive: true });
			fs.renameSync(present, canonical);
			applied.push(`Moved ${toRelative(present, report.projectRoot)} to ${toRelative(canonical, report.projectRoot)}.`);
			continue;
		}

		if (entry.id === "legacy-live-state") {
			// Reported, never deleted: a running live session still reads these, and losing session
			// state to a doctor run is worse than a stale file.
			skipped.push({ id: entry.id, reason: "delete by hand once no live session is running" });
			continue;
		}

		skipped.push({ id: entry.id, reason: "no automatic migration implemented" });
	}

	// Stamping the product record is additive and safe, and it is what stops a later version
	// proposing an interview the user has already sat through.
	const productPath = report.absProductPath;
	if (productPath && report.ctx.product && readProductSchemaVersion(report.ctx.product) === null && !report.findings.some((entry) => entry.id === "product-schema-legacy")) {
		fs.writeFileSync(productPath, stampProductSchema(report.ctx.product), "utf-8");
		applied.push(`Stamped ${toRelative(productPath, report.projectRoot)} as product-schema ${PRODUCT_SCHEMA_VERSION}.`);
	}

	return { applied, skipped };
}

const SEVERITY_LABEL: Readonly<Record<string, string>> = {
	auto: "automatic",
	mention: "worth saying",
	route: "needs a command",
};

/** The human-readable report: findings grouped by what the reader must do about each. */
function renderText(report: DoctorReport, fixes: FixResult | null = null, cwd: string = process.cwd()): string {
	const lines: string[] = [];

	lines.push(`Impeccable doctor: ${toRelative(report.projectRoot, cwd) || "."}`);
	if (report.ctx.isMonorepo) lines.push(`Monorepo, repo root ${toRelative(report.ctx.repoRoot, cwd) || "."}.`);
	lines.push("");

	if (report.findings.length === 0) {
		lines.push("No drift found. Every artifact matches what this version reads.");
	} else {
		for (const severity of ["route", "mention", "auto"]) {
			const group = report.findings.filter((entry) => entry.severity === severity);
			if (group.length === 0) continue;
			lines.push(`${SEVERITY_LABEL[severity]} (${group.length}):`);
			for (const entry of group) {
				lines.push(`  ${entry.id}${entry.path ? `  [${entry.path}]` : ""}`);
				lines.push(`    ${entry.summary}`);
				lines.push(`    → ${entry.fix}`);
			}
			lines.push("");
		}
	}

	if (report.workspaces.length > 0) {
		lines.push("Workspaces:");
		for (const workspace of report.workspaces) {
			lines.push(
				`  ${workspace.path}  product: ${workspace.productStatus}  design: ${workspace.designStatus}${workspace.platform ? `  platform: ${workspace.platform}` : ""}`,
			);
		}
		lines.push("");
	}

	if (!report.ruleRegistryAvailable) {
		lines.push("Note: the bundled detector could not be resolved, so ignored rule ids were not validated.");
		lines.push("");
	}

	if (fixes) {
		lines.push(fixes.applied.length > 0 ? "Applied:" : "Applied nothing.");
		for (const entry of fixes.applied) lines.push(`  ${entry}`);
		// "Needs a decision" is the default reason, so listing it would say nothing.
		const held = fixes.skipped.filter((entry) => entry.reason !== "needs a decision from the user");
		if (held.length > 0) {
			lines.push("Left alone:");
			for (const entry of held) lines.push(`  ${entry.id}: ${entry.reason}`);
		}
	} else if (report.findings.some((entry) => entry.severity === "auto")) {
		lines.push(`Run the doctor with \`--fix\` to apply the automatic migrations, or \`${IMPECCABLE_COMMAND} doctor\` to work through all of them.`);
	}

	return lines.join("\n");
}

/** The machine-readable form: the same report plus what a fix run did. */
function renderJson(report: DoctorReport, fixes: FixResult | null = null): string {
	return JSON.stringify(
		{
			projectRoot: report.projectRoot,
			repoRoot: report.ctx.repoRoot,
			isMonorepo: report.ctx.isMonorepo,
			productPath: report.ctx.productPath,
			designPath: report.ctx.designPath,
			platform: report.ctx.platform,
			ruleRegistryAvailable: report.ruleRegistryAvailable,
			findings: report.findings,
			workspaces: report.workspaces,
			...(fixes ? { fixes } : {}),
		},
		null,
		2,
	);
}

/** The usage text. */
function usage(): string {
	return [
		"Usage: doctor [--json] [--fix] [--target <path>]",
		"",
		"Report drift between this project's Impeccable artifacts and what the",
		"installed version reads: PRODUCT.md, DESIGN.md and its sidecar,",
		".impeccable/config.json, surface briefs, and the design hook.",
		"",
		"  --json           Emit findings as JSON.",
		'  --fix            Apply the mechanical migrations (severity "auto") only.',
		"  --target <path>  Select a workspace in a monorepo.",
	].join("\n");
}

/**
 * A whole doctor run: collect, optionally fix, and render in the requested form. This is the
 * one function a command needs; the renderers and `collect`/`applyFixes` stay exported for a
 * caller that wants the report without the text.
 */
function runDoctor({
	cwd = process.cwd(),
	args = [] as readonly string[],
	json = false,
}: {
	readonly cwd?: string;
	readonly args?: readonly string[];
	readonly json?: boolean;
} = {}): string {
	const targetOptions = parseTargetOptions(args, { strict: true });
	const fix = args.includes("--fix");
	const report = collect(cwd, { ...targetOptions, fix });
	const fixes = fix ? applyFixes(report) : null;
	return json ? renderJson(report, fixes) : renderText(report, fixes, cwd);
}

export { applyFixes, collect, renderJson, renderText, runDoctor, usage, VISUAL_SOURCE_DIRS };
