/**
 * Reads and checks a DESIGN.md the way the format spec defines it.
 * Spec: github.com/google-labs-code/design.md (version: alpha)
 *
 * Three severities, chosen from what the spec actually says:
 * - error   — the spec mandates a rejection (malformed YAML, missing `name`,
 *             duplicate section headings).
 * - warning — the spec says something SHOULD hold (section order, required
 *             sections unless listed in `omitted`, `colors.primary`, a token
 *             reference that does not resolve).
 * - note    — the spec says to accept this and carry on (unknown headings,
 *             unknown token names, optional fields that are absent).
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type Severity = "error" | "warning" | "note";

export interface Finding {
	severity: Severity;
	message: string;
	/** 1-based line in the document, when the finding can be located. */
	line?: number;
}

export interface DesignMeta {
	/** Frontmatter `name`: the spec's one required field. */
	name?: string;
	/** One-line routing text: `description`, else the Overview prose. */
	summary?: string;
}

export interface DesignAnalysis {
	meta: DesignMeta;
	findings: Finding[];
	/** Canonical section titles found in the body, in document order. */
	sections: string[];
	/** Number of token references checked, for the status line. */
	references: number;
}

/** Canonical sections and their spec-sanctioned aliases, in required order. */
const SECTIONS = [
	{ title: "Overview", aliases: ["overview", "brand & style"] },
	{ title: "Colors", aliases: ["colors"] },
	{ title: "Typography", aliases: ["typography"] },
	{ title: "Layout", aliases: ["layout", "layout & spacing"] },
	{ title: "Elevation & Depth", aliases: ["elevation & depth", "elevation"] },
	{ title: "Shapes", aliases: ["shapes"] },
	{ title: "Components", aliases: ["components"] },
	{ title: "Do's and Don'ts", aliases: ["do's and don'ts", "dos and don'ts"] },
] as const;

/** Component token properties the spec defines. */
const COMPONENT_PROPERTIES = new Set([
	"backgroundColor",
	"textColor",
	"typography",
	"rounded",
	"padding",
	"size",
	"height",
	"width",
]);

const TOKEN_REFERENCE = /^\{([^{}]+)\}$/;
const SUMMARY_MAX_CHARS = 400;
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

/** Collapse YAML block scalars and wrapped prose into a single line. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Keep text readable on one line: end it at a sentence when one is near the limit. */
export function truncate(text: string | undefined): string | undefined {
	if (!text) return undefined;
	if (text.length <= SUMMARY_MAX_CHARS) return text;

	const clipped = text.slice(0, SUMMARY_MAX_CHARS);
	const sentenceEnd = Math.max(
		clipped.lastIndexOf(". "),
		clipped.lastIndexOf("! "),
		clipped.lastIndexOf("? "),
	);
	return sentenceEnd > 80 ? clipped.slice(0, sentenceEnd + 1) : `${clipped.trimEnd()}…`;
}

/** First meaningful prose line of a body, used when the frontmatter is silent. */
function firstProseLine(body: string, skipHeadings = false): string | undefined {
	let inFence = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("```") || line.startsWith("~~~")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (skipHeadings && /^#{1,6}\s/.test(line)) continue;

		const text = line
			.replace(/^#{1,6}\s*/, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/\*\*|`/g, "")
			.trim();
		// Skip blanks, frontmatter leftovers, rules, and table separators.
		if (!text || /^---$/.test(text) || /^[|>#*_\-=~]+$/.test(text)) continue;
		return text;
	}
	return undefined;
}

/**
 * First prose line of the spec's Overview section. The spec fixes that heading
 * and its order, so it is the best routing text when `description` is absent.
 */
function overviewLine(body: string): string | undefined {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+(overview|brand & style)\s*$/i.test(line.trim()));
	if (start === -1) return undefined;
	return firstProseLine(lines.slice(start + 1).join("\n"), true);
}

/** Normalize a heading for alias matching (curly apostrophes vary by author). */
function normalizeHeading(text: string): string {
	return text.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

/** Split the document around its frontmatter, keeping body line offsets. */
function splitDocument(content: string): { yaml: string | null; body: string; bodyStart: number } {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines[0]?.trim() !== "---") return { yaml: null, body: content, bodyStart: 0 };

	for (let index = 1; index < lines.length; index++) {
		if (lines[index].trim() === "---") {
			return {
				yaml: lines.slice(1, index).join("\n"),
				body: lines.slice(index + 1).join("\n"),
				bodyStart: index + 1,
			};
		}
	}
	// An opening delimiter with no closing one is malformed; treat it as one document.
	return { yaml: null, body: content, bodyStart: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a `{colors.primary}` style reference against the parsed frontmatter. */
function resolveReference(frontmatter: Record<string, unknown>, reference: string): unknown {
	let node: unknown = frontmatter;
	for (const segment of reference.split(".")) {
		if (!isRecord(node)) return undefined;
		node = node[segment];
		if (node === undefined) return undefined;
	}
	return node;
}

/** Every `{a.b.c}` string in the frontmatter, with the path it sits at. */
function collectReferences(node: unknown, path: string[] = []): Array<{ reference: string; path: string[] }> {
	if (typeof node === "string") {
		const match = TOKEN_REFERENCE.exec(node.trim());
		return match ? [{ reference: match[1]!, path }] : [];
	}
	if (Array.isArray(node)) return node.flatMap((item, index) => collectReferences(item, [...path, String(index)]));
	if (isRecord(node)) {
		return Object.entries(node).flatMap(([key, value]) => collectReferences(value, [...path, key]));
	}
	return [];
}

/** Sections intentionally omitted, as plain names or `{ section, reason }` entries. */
function omittedSections(frontmatter: Record<string, unknown>): Set<string> {
	const raw = frontmatter.omitted;
	if (!Array.isArray(raw)) return new Set();

	const names = new Set<string>();
	for (const entry of raw) {
		if (typeof entry === "string") names.add(normalizeHeading(entry));
		else if (isRecord(entry) && typeof entry.section === "string") names.add(normalizeHeading(entry.section));
	}
	return names;
}

/** Read + check a DESIGN.md. Never throws: bad YAML becomes an error finding. */
export function analyzeDesign(content: string): DesignAnalysis {
	const findings: Finding[] = [];
	const { yaml, body, bodyStart } = splitDocument(content);

	let frontmatter: Record<string, unknown> = {};
	let yamlParsed = false;
	if (yaml !== null) {
		try {
			frontmatter = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
			yamlParsed = true;
		} catch (error) {
			findings.push({
				severity: "error",
				message: `frontmatter is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : "parse failed"}`,
				line: 1,
			});
		}
	} else {
		findings.push({
			severity: "warning",
			message: "no YAML frontmatter: the spec's machine-readable tokens are its normative half",
		});
	}

	// Locate a frontmatter key's line: line 1 is the opening `---`.
	const lineOfKey = (key: string): number | undefined => {
		if (yaml === null) return undefined;
		const index = yaml.split("\n").findIndex((line) => new RegExp(`^\\s*${key}\\s*:`).test(line));
		return index === -1 ? undefined : index + 2;
	};

	// --- frontmatter fields ---
	let name: string | undefined;
	let declaredDescription: string | undefined;
	if (yamlParsed) {
		if (typeof frontmatter.name === "string" && frontmatter.name.trim()) name = oneLine(frontmatter.name);
		else {
			findings.push({
				severity: "error",
				message: "frontmatter is missing a `name` (the spec's only required field)",
				line: lineOfKey("name"),
			});
		}

		if (typeof frontmatter.description === "string") declaredDescription = oneLine(frontmatter.description);
		else {
			findings.push({
				severity: "note",
				message: "no `description`: routing falls back to the Overview prose",
				line: lineOfKey("description"),
			});
		}

		if (typeof frontmatter.version !== "string") {
			findings.push({
				severity: "note",
				message: "no `version`: the spec's current version is alpha",
				line: lineOfKey("version"),
			});
		} else if (frontmatter.version !== "alpha") {
			findings.push({
				severity: "note",
				message: `unknown version "${frontmatter.version}": the spec's current version is alpha`,
				line: lineOfKey("version"),
			});
		}
	}

	// --- body sections ---
	const headingLines = body.split("\n");
	const seen: Array<{ index: number; line: number; heading: string }> = [];
	for (let index = 0; index < headingLines.length; index++) {
		const match = /^##\s+(.+?)\s*$/.exec(headingLines[index]!);
		if (!match) continue;

		const heading = normalizeHeading(match[1]!);
		const sectionIndex = SECTIONS.findIndex((section) =>
			(section.aliases as readonly string[]).includes(heading),
		);
		if (sectionIndex === -1) {
			findings.push({
				severity: "note",
				message: `unknown section "${match[1]!.trim()}" (the spec says preserve it, not error)`,
				line: bodyStart + index + 1,
			});
			continue;
		}
		seen.push({ index: sectionIndex, line: bodyStart + index + 1, heading: SECTIONS[sectionIndex]!.title });
	}

	for (let i = 1; i < seen.length; i++) {
		if (seen[i]!.index === seen[i - 1]!.index) {
			findings.push({
				severity: "error",
				message: `duplicate "${seen[i]!.heading}" section (the spec rejects the file)`,
				line: seen[i]!.line,
			});
		}
	}

	const orderBreaks = seen.filter((entry, i) => i > 0 && entry.index < seen[i - 1]!.index);
	for (const entry of orderBreaks) {
		findings.push({
			severity: "warning",
			message: `"${entry.heading}" is out of the spec's section order`,
			line: entry.line,
		});
	}

	if (yamlParsed) {
		const omitted = omittedSections(frontmatter);
		const missing = SECTIONS.filter(
			(section, index) =>
				!seen.some((entry) => entry.index === index) && !omitted.has(normalizeHeading(section.title)),
		);
		if (missing.length > 0) {
			findings.push({
				severity: "warning",
				message: `missing section(s): ${missing.map((section) => section.title).join(", ")} (add them or list them in \`omitted\`)`,
			});
		}

		// The spec requires at least the primary color, unless Colors is omitted.
		const colors = frontmatter.colors;
		if (!omitted.has(normalizeHeading("Colors"))) {
			if (!isRecord(colors) || colors.primary === undefined) {
				findings.push({
					severity: "warning",
					message: "no `colors.primary`: the spec requires at least the primary palette",
					line: lineOfKey("colors"),
				});
			}
		}
	}

	// --- token references ---
	let references = 0;
	if (yamlParsed) {
		for (const { reference, path } of collectReferences(frontmatter)) {
			references++;
			const resolved = resolveReference(frontmatter, reference);
			if (resolved === undefined) {
				findings.push({
					severity: "warning",
					message: `token reference {${reference}} in ${path.join(".")} does not resolve`,
				});
				continue;
			}
			// Composite references are only allowed inside `components`.
			if (isRecord(resolved) && path[0] !== "components") {
				findings.push({
					severity: "warning",
					message: `token reference {${reference}} in ${path.join(".")} points at a group, but the spec allows that only inside \`components\``,
				});
			}
		}

		for (const [component, properties] of Object.entries(isRecord(frontmatter.components) ? frontmatter.components : {})) {
			if (!isRecord(properties)) continue;
			for (const property of Object.keys(properties)) {
				if (COMPONENT_PROPERTIES.has(property)) continue;
				findings.push({
					severity: "note",
					message: `unknown component property "${property}" on ${component} (the spec accepts it with a warning)`,
				});
			}
		}
	}

	findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0));

	return {
		meta: { name, summary: truncate(declaredDescription || overviewLine(body) || firstProseLine(body, true)) },
		findings,
		sections: seen.map((entry) => entry.heading),
		references,
	};
}

/** Count findings by severity, for one-line summaries. */
export function countFindings(findings: Finding[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { error: 0, warning: 0, note: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

/**
 * Stable identity for one finding across reads, so a report can compare the current file with the
 * findings this session saw when it first opened the file. Line numbers stay out: an edit above a
 * warning shifts it without making it a new problem.
 */
export function findingKey(finding: Finding): string {
	return `${finding.severity}\u0000${finding.message}`;
}

/** Human-readable report used by `/designer validate`. */
export function formatFindings(findings: Finding[], preExisting?: ReadonlySet<string>): string[] {
	const marks: Record<Severity, string> = { error: "\u2717", warning: "!", note: "\u00b7" };
	return findings.map((finding) => {
		const where = finding.line ? ` (line ${finding.line})` : "";
		const already = preExisting?.has(findingKey(finding)) ? " [pre-existing]" : "";
		return `${marks[finding.severity]} ${finding.severity}${where}: ${finding.message}${already}`;
	});
}

/** One-line verdict: `0 errors, 2 warnings, 1 note`. */
export function summarize(findings: Finding[]): string {
	const counts = countFindings(findings);
	return (["error", "warning", "note"] as const)
		.map((severity) => `${counts[severity]} ${counts[severity] === 1 ? severity : `${severity}s`}`)
		.join(", ");
}
