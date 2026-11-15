/**
 * The scan command: what `/designer detect` runs.
 *
 * Everything the reference's `detect.mjs` did in a child process, in process: resolve the project's
 * config for its ignore filters, load the design system the file belongs to, hand the HTML engine its
 * parser if one is installed, scan, and format the report. The comp-round notice rides along, because a
 * passing scan is not a finished build.
 */
import path from "node:path";
import { filterDetectionFindings, readDetectionConfig, shouldIgnoreDetectionFile } from "../config.ts";
import { formatFindings, scanTargets } from "../detect/scan.ts";
import type { DetectionConfig, ScanOptions } from "../detect/scan.ts";
import type { DesignScope } from "../types.ts";
import { loadDesignSystemForCwd } from "../detect/design-system.ts";
import { compRoundNotice } from "./detect-command.ts";
import { loadHtmlModules } from "./html-modules.ts";

/** The config seam, built from the project's `.impeccable` files. */
function detectionConfigFor(cwd: string): DetectionConfig {
	const config = readDetectionConfig(cwd);
	return {
		shouldIgnoreFile: (filePath, root) => shouldIgnoreDetectionFile(filePath, root, config),
		filterFindings: (findings) => filterDetectionFindings(findings, config),
		designSystem: config.designSystem,
	};
}

/** One scan, as a host needs it: the report, the text to show, and whether it failed. */
interface ScanRun {
	readonly findings: number;
	readonly text: string;
	readonly notice: string | null;
	/** True when the HTML engine ran without a parser and said so. */
	readonly degraded: boolean;
	readonly warnings: readonly string[];
}

/**
 * Scan targets in the working directory.
 *
 * With no targets, the working directory is scanned: a bare `/designer detect` should say something
 * true about the project rather than nothing.
 */
async function runScan({
	targets = [],
	cwd = process.cwd(),
	advisory = true,
	json = false,
	scopes = [],
}: {
	readonly targets?: readonly string[];
	readonly cwd?: string;
	readonly advisory?: boolean;
	/** Machine-readable findings, the shape a caller parses rather than reads. */
	readonly json?: boolean;
	/** Narrow to one or both design scopes, the way the skill's `--scope` does. */
	readonly scopes?: readonly DesignScope[];
} = {}): Promise<ScanRun> {
	const warnings: string[] = [];
	const modules = await loadHtmlModules();

	const options: ScanOptions = {
		cwd,
		modules,
		config: detectionConfigFor(cwd),
		designSystem: loadDesignSystemForCwd(cwd),
		inlineIgnores: true,
		onWarning: (message) => warnings.push(message),
	};

	// Targets arrive as the user typed them, relative to the project: resolve them here, because the scan
	// resolves its own paths against the process, not against the directory the command was given.
	const resolved = (targets.length > 0 ? targets : ["."]).map((target) => (path.isAbsolute(target) ? target : path.resolve(cwd, target)));

	const report = await scanTargets(resolved, {
		...options,
		includeAdvisory: advisory,
		...(scopes.length > 0 ? { scopes } : {}),
	} as ScanOptions);

	const findings = advisory ? report.findings : report.findings.filter((f) => f.advisory !== true);
	return {
		findings: findings.length,
		text: formatFindings(findings, json, false),
		notice: compRoundNotice(cwd),
		degraded: modules === null,
		warnings: [...warnings, ...report.warnings],
	};
}

export { detectionConfigFor, runScan };
export type { ScanRun };
