/**
 * The scan entry point: walk targets, pick an engine per file, annotate, filter, and
 * format. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * Upstream this is a CLI: it reads `process.argv`, writes to stdout, and exits with a code.
 * Here it is a function set — the same work with the process boundary removed, so pi can
 * call it in-process and decide its own output and exit semantics.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterByScopes, RULE_SCOPES } from "../core/registry/antipatterns.ts";
import { loadDesignSystemForTarget, type DesignSystem } from "./design-system.ts";
import { detectHtml, type HtmlModules } from "./static-html/html.ts";
import { detectText } from "./text.ts";
import { buildImportGraph, detectFrameworkConfig, HTML_EXTENSIONS, isPortListening, walkDir, type FrameworkFingerprint } from "./files.ts";
import type { DesignScope, Finding } from "../types.ts";

// ─── Output formatting ─────────────────────────────────────────────────────

function formatFindingSummary(count: number): string {
	return `${count} anti-pattern${count === 1 ? "" : "s"} found.`;
}

/** The local filesystem path behind a `file://` URL, or null when it cannot be mapped. */
function fileUrlToLocalPath(url: string): string | null {
	try {
		return fileURLToPath(url);
	} catch {
		return null;
	}
}

/**
 * Advisory findings are detected but never treated as failures: they list in a separate,
 * dimmed section, stay out of the failure count that drives the exit code, and carry
 * `advisory: true` in JSON so a consumer can filter them.
 */
function isAdvisory(finding: Finding | null | undefined): boolean {
	return !!finding && finding.advisory === true;
}

function partitionAdvisory(findings: readonly Finding[]): { primary: Finding[]; advisory: Finding[] } {
	const primary: Finding[] = [];
	const advisory: Finding[] = [];
	for (const f of findings) (isAdvisory(f) ? advisory : primary).push(f);
	return { primary, advisory };
}

/** ANSI dim when the stream is a terminal; advisory output is chrome, so it stays quiet otherwise. */
function dim(text: string, isTTY = false): string {
	return isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}

function formatFindingsBody(findings: readonly Finding[]): string[] {
	const grouped: Record<string, Finding[]> = {};
	for (const f of findings) {
		if (!grouped[f.file]) grouped[f.file] = [];
		grouped[f.file].push(f);
	}

	const out: string[] = [];
	for (const [file, items] of Object.entries(grouped)) {
		const importers = (items[0] as Finding & { importedBy?: string[] }).importedBy;
		const importNote = importers?.length ? ` (imported by ${importers.join(", ")})` : "";
		out.push(`\n${file}${importNote}`);
		for (const item of items) {
			out.push(`  ${item.line ? `line ${item.line}: ` : ""}[${item.antipattern}] ${item.snippet}`);
			out.push(`    → ${item.description}`);
		}
	}
	return out;
}

function formatAdvisorySection(advisory: readonly Finding[], isTTY = false): string {
	if (advisory.length === 0) return "";
	const lines = [`\n${dim("── Advisory (not counted as failures) ──", isTTY)}`];
	for (const line of formatFindingsBody(advisory)) lines.push(dim(line, isTTY));
	lines.push(dim(`\n${advisory.length} advisory note${advisory.length === 1 ? "" : "s"}. Suppress with --no-advisory.`, isTTY));
	return lines.join("\n");
}

/**
 * The text or JSON report. JSON keeps every finding in one array (advisory ones flagged);
 * text splits the advisory notes into their own section and counts only the rest as
 * failures.
 */
function formatFindings(findings: readonly Finding[], jsonMode: boolean, isTTY = false): string {
	if (jsonMode) return JSON.stringify(findings, null, 2);

	const { primary, advisory } = partitionAdvisory(findings);
	const out = [...formatFindingsBody(primary)];
	out.push(`\n${formatFindingSummary(primary.length)}`);
	const advisorySection = formatAdvisorySection(advisory, isTTY);
	if (advisorySection) out.push(advisorySection);
	return out.join("\n");
}

// ─── Configuration seam ────────────────────────────────────────────────────

/**
 * The project-config hooks a scan applies. Upstream reads `.impeccable/config.json` here;
 * pi takes the two filters as an interface, so the config module can plug in without the
 * scan depending on it.
 */
export interface DetectionConfig {
	/** True when the file is excluded by `detector.ignoreFiles`. */
	shouldIgnoreFile?(filePath: string, cwd: string): boolean;
	/** Drop findings suppressed by `detector.ignoreRules` / `detector.ignoreValues`. */
	filterFindings?<T extends Finding>(findings: readonly T[]): T[];
	/** False when `detector.designSystem.enabled` is off. */
	readonly designSystem?: { readonly enabled?: boolean };
}

// ─── Per-file dispatch ─────────────────────────────────────────────────────

export interface ScanOptions {
	/** The HTML parser. Without it, HTML files fall back to the text engine and say so. */
	readonly modules?: HtmlModules | null;
	readonly inlineIgnores?: boolean;
	readonly designSystem?: DesignSystem | null;
	readonly viewport?: { readonly width: number; readonly height: number };
	readonly config?: DetectionConfig | null;
	/** Resolve a file's own design system; defaults to the per-root walk. */
	readonly loadDesignSystem?: (filePath: string) => DesignSystem | null;
	readonly onWarning?: (message: string) => void;
	readonly confirmScan?: (message: string) => boolean | Promise<boolean>;
	/** Probe a detected framework's dev server and hint about a URL scan. */
	readonly probeFramework?: boolean;
	readonly cwd?: string;
}

/** Findings for one file, by the engine its extension calls for. */
async function detectLocalFile(filePath: string, options: ScanOptions = {}): Promise<Finding[]> {
	if (HTML_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
		return detectHtml(filePath, {
			modules: options.modules ?? null,
			designSystem: options.designSystem ?? null,
			inlineIgnores: options.inlineIgnores,
			onDegraded: options.onWarning,
		});
	}
	return detectText(fs.readFileSync(filePath, "utf-8"), filePath, {
		designSystem: options.designSystem,
		inlineIgnores: options.inlineIgnores,
	});
}

/**
 * Findings for stdin content. A hook payload naming an existing file is scanned through
 * that file's engine; anything else is scanned as text.
 */
async function handleStdin(
	input: string,
	optionsFor: ((filePath: string | null) => ScanOptions) | ScanOptions = () => ({}),
): Promise<Finding[]> {
	const resolve = typeof optionsFor === "function" ? optionsFor : () => optionsFor;
	try {
		const parsed = JSON.parse(input) as { tool_input?: { file_path?: string } };
		const fp = parsed?.tool_input?.file_path;
		if (fp && fs.existsSync(fp)) return detectLocalFile(fp, resolve(fp));
	} catch {
		// Not JSON: scan the input as text.
	}
	return detectText(input, "<stdin>", { inlineIgnores: resolve(null).inlineIgnores });
}

// ─── Scans ─────────────────────────────────────────────────────────────────

export interface ScanResult {
	readonly findings: Finding[];
	/** Warnings the caller may surface: a missing parser, an unreadable stylesheet, a dev server. */
	readonly warnings: string[];
}

/** Findings for a single file. */
async function scanFile(filePath: string, options: ScanOptions = {}): Promise<Finding[]> {
	return detectLocalFile(filePath, options);
}

/**
 * Findings for a directory: walk it, build the import graph so a finding can name what
 * imports the file, resolve each file's own design system, and scan.
 *
 * The design file resolves per file, never from the working directory: scanning project B
 * from inside project A applies B's rules, or none.
 */
async function scanDirectory(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
	const cwd = options.cwd ?? process.cwd();
	const warnings: string[] = [];
	const warn = (message: string) => {
		warnings.push(message);
		options.onWarning?.(message);
	};

	const files = walkDir(dir).filter((file) => !options.config?.shouldIgnoreFile?.(file, cwd));

	// A dev server that is running would give a better scan than the files do; say so
	// rather than silently producing a weaker answer.
	if (options.probeFramework !== false) {
		const framework = detectFrameworkConfig(dir);
		if (framework) {
			const probe = await isPortListening(framework.port, framework.fingerprint as FrameworkFingerprint);
			if (probe.listening && probe.matched) {
				warn(`${framework.name} dev server detected on localhost:${framework.port}. For more accurate results, scan the running site instead of the files.`);
			} else if (probe.listening && !probe.matched) {
				warn(`${framework.name} project detected (${path.basename(framework.configPath)}). Port ${framework.port} is in use by another service; start the ${framework.name} dev server and scan via URL for best results.`);
			} else {
				warn(`${framework.name} project detected (${path.basename(framework.configPath)}). Start the dev server and scan via URL for best results.`);
			}
		}
	}

	const graph = buildImportGraph(files);
	const importedBy = new Map<string, Set<string>>();
	for (const [importer, imports] of graph) {
		for (const imported of imports) {
			const set = importedBy.get(imported);
			if (set) set.add(importer);
			else importedBy.set(imported, new Set([importer]));
		}
	}

	const cache = new Map<string, DesignSystem | null>();
	const resolveDesignSystem = options.loadDesignSystem ?? ((filePath: string) => loadDesignSystemForTarget(filePath, { cache, cwd }));

	const findings: Finding[] = [];
	for (const file of files) {
		const fileOptions: ScanOptions = options.designSystem
			? options
			: { ...options, designSystem: resolveDesignSystem(file) };
		const fileFindings = await detectLocalFile(file, fileOptions);

		const importers = importedBy.get(file);
		if (importers && importers.size > 0) {
			const names = [...importers].map((f) => path.basename(f));
			for (const f of fileFindings) (f as Finding & { importedBy?: string[] }).importedBy = names;
		}
		findings.push(...fileFindings);
	}

	return { findings, warnings };
}

export interface ScanTargetsOptions extends ScanOptions {
	readonly scopes?: readonly DesignScope[];
	readonly includeAdvisory?: boolean;
	/** Scan a URL through the browser engine. Supplied by the caller, which owns the browser. */
	readonly scanUrl?: (url: string, options: ScanOptions) => Promise<Finding[]>;
}

/**
 * Findings for a mixed list of targets: files, directories, and URLs. Applies the project
 * config's ignore filters, the `--scope` narrowing, and the advisory option, in the order
 * the CLI applies them.
 */
async function scanTargets(targets: readonly string[], options: ScanTargetsOptions = {}): Promise<ScanResult> {
	const cwd = options.cwd ?? process.cwd();
	const warnings: string[] = [];
	const warn = (message: string) => {
		warnings.push(message);
		options.onWarning?.(message);
	};
	const collecting: ScanOptions = { ...options, onWarning: warn };

	let findings: Finding[] = [];
	const paths = targets.length > 0 ? targets : [cwd];
	const urlRe = /^(?:https?|file):\/\//i;

	for (const target of paths) {
		if (urlRe.test(target)) {
			if (!options.scanUrl) {
				warn(`Cannot scan ${target}: no URL scanner supplied.`);
				continue;
			}
			// A file:// URL points at a local artifact, so its design system resolves from
			// that file's project. A remote URL has no local project and gets no design rules.
			const localPath = /^file:/i.test(target) ? fileUrlToLocalPath(target) : null;
			const urlOptions = localPath && !options.designSystem
				? { ...collecting, designSystem: (options.loadDesignSystem ?? ((p: string) => loadDesignSystemForTarget(p, { cwd })))(localPath) }
				: collecting;
			try {
				findings.push(...(await options.scanUrl(target, urlOptions)));
			} catch (error) {
				warn(`Error scanning ${target}: ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}

		const resolved = path.resolve(target);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			warn(`cannot access ${target}`);
			continue;
		}

		if (stat.isDirectory()) {
			const result = await scanDirectory(resolved, collecting);
			warnings.push(...result.warnings);
			findings.push(...result.findings);
			continue;
		}

		if (options.config?.shouldIgnoreFile?.(resolved, cwd)) continue;
		const fileDesignSystem = options.designSystem ?? (options.loadDesignSystem ?? ((p: string) => loadDesignSystemForTarget(p, { cwd })))(resolved);
		findings.push(...(await detectLocalFile(resolved, { ...collecting, designSystem: fileDesignSystem })));
	}

	if (options.config?.filterFindings) findings = options.config.filterFindings(findings);
	if (options.scopes && options.scopes.length > 0) findings = [...filterByScopes(findings, options.scopes)];
	if (options.includeAdvisory === false) findings = findings.filter((f) => !isAdvisory(f));

	return { findings, warnings };
}

/** The exit status the CLI used: 2 when a non-advisory finding exists, 0 otherwise. */
function exitCodeFor(findings: readonly Finding[]): 0 | 2 {
	return partitionAdvisory(findings).primary.length > 0 ? 2 : 0;
}

/** The usage text, kept because it doubles as the feature list. */
function printUsage(): string {
	return `Usage: impeccable detect [options] [file-or-dir-or-url...]

Scan files or URLs for UI anti-patterns and design quality issues.

Options:
  --json              Output results as JSON
  --quiet             In text mode, only print the final findings count
  --scope <name>      Only report rules in the given design domain
                      (type, layout). Comma-separated: ${[...RULE_SCOPES].join(", ")}
  --viewport <WxH>    Browser viewport for URL scans (default 1280x800)
  --no-config         Do not apply project config, detector ignores, inline
                      ignore comments, or DESIGN.md
  --no-inline-ignores Do not honor in-file impeccable-disable* comments
  --no-design-system  Do not load local DESIGN.md / .impeccable/design.json
  --no-advisory       Suppress advisory findings entirely (e.g. em-dash overuse)
  --help              Show this help message`;
}

export {
	detectLocalFile,
	dim,
	exitCodeFor,
	fileUrlToLocalPath,
	formatAdvisorySection,
	formatFindingSummary,
	formatFindings,
	formatFindingsBody,
	handleStdin,
	isAdvisory,
	partitionAdvisory,
	printUsage,
	scanDirectory,
	scanFile,
	scanTargets,
};
