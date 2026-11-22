#!/usr/bin/env bun
/**
 * Import Impeccable's guidance into this extension's corpus.
 *
 * The guidance used to ship as a vendored skill tree (`SKILL.md` plus `reference/*.md`), because a
 * skill was the only way to keep it lazy. The engine now carries it: `guidance/corpus.ts` holds the
 * text, `design_check` returns it, and no file path is resolved at runtime.
 *
 * This script is the importer that produced that corpus. It replaces the tree wholesale, so running
 * it again discards local edits — use it only to import a newer upstream on purpose, and read the
 * diff first.
 *
 * Usage:
 *   bun extensions/designer/scripts/import-guidance.mjs --source <dir>
 *   bun extensions/designer/scripts/import-guidance.mjs --source <dir> --dry-run
 *
 * `--source` points at the skill directory to import: the one holding `SKILL.md` and `reference/`.
 * Upstream builds it at `.pi/skills/impeccable`, so `--source <upstream-checkout>/.pi/skills/impeccable`
 * after `bun run build:skills`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sourceArg = args.indexOf("--source");
const source = sourceArg === -1 ? null : args[sourceArg + 1];

if (!source) {
	console.error("import-guidance: --source <skill directory> is required");
	process.exit(2);
}

const root = path.resolve(source);
const skillFile = path.join(root, "SKILL.md");
const metadataFile = path.join(root, "scripts", "command-metadata.json");
const corpusFile = path.resolve(import.meta.dir, "..", "guidance", "corpus.ts");

/** Every markdown file under the source, keyed by its path relative to the source root. */
function markdownFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...markdownFiles(full));
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out.sort();
}

/** The body of a markdown file, with YAML frontmatter removed. */
function stripFrontmatter(text) {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 1);
	return after === -1 ? "" : text.slice(after + 1);
}

const files = markdownFiles(root);
const keys = new Set(files.map((file) => path.relative(root, file).split(path.sep).join("/")));
/** Links this script could not resolve, reported instead of written silently. */
const unresolved = [];

/**
 * Rewrite a cross-reference into a guidance key.
 *
 * The guidance used to point at sibling files, and the model resolved those paths by hand. It now
 * names them as keys the `design_check` tool reads: `[reference/audit.md](reference/audit.md)` and
 * `[ios.md](ios.md)` both become a backticked key, which the corpus's own convention explains.
 */
function rewriteLinks(text, key) {
	const from = path.posix.dirname(key);
	return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, target) => {
		if (!target.endsWith(".md") && !target.includes(".md#")) return whole;
		// Absolute links leave the corpus, so they stay links.
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
		const [file] = target.split("#");
		const resolved = path.posix.normalize(path.posix.join(from, file));
		if (!keys.has(resolved)) {
			unresolved.push(`${key}: ${target}`);
			return whole;
		}
		return `\`${resolved}\``;
	});
}

const guidance = {};
for (const file of files) {
	const key = path.relative(root, file).split(path.sep).join("/");
	// The router is hand-written in `guidance/router.ts`: it is prose this package maintains, not
	// imported prose, so an import must not overwrite it.
	if (key === "SKILL.md") continue;
	guidance[key] = rewriteLinks(stripFrontmatter(readFileSync(file, "utf8")).trim(), key);
}

const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
const playbooks = Object.fromEntries(
	Object.entries(metadata)
		.map(([name, entry]) => [name, typeof entry?.description === "string" ? entry.description : name])
		.sort(([a], [b]) => a.localeCompare(b)),
);

const emit = (value) => JSON.stringify(value, null, "\t");

/**
 * Provenance is recorded here, not read: nothing loads this file at runtime. A re-import updates the
 * commit and version from the flags when they are given, and leaves the rest alone.
 */
const provenanceFile = path.resolve(import.meta.dir, "..", "guidance", "UPSTREAM.json");
let provenance = {};
try {
	provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
} catch {
	provenance = { source: "https://github.com/pbakaus/impeccable", sourceSkill: ".pi/skills/impeccable" };
}
const flag = (name) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? null : (args[index + 1] ?? null);
};
if (flag("commit")) provenance.commit = flag("commit");
if (flag("version")) provenance.skillVersion = flag("version");

const body = `/**
 * Impeccable's guidance, carried by the engine.
 *
 * Imported from ${provenance.source} at ${provenance.commit} (skill ${provenance.skillVersion}),
 * Apache-2.0; see NOTICE. \`scripts/import-guidance.mjs\` produced the first version of this file and
 * can replace it wholesale. From here the text is edited in place: it is this package's guidance now.
 *
 * Keys are guidance keys, not paths. A key inside the text — \`reference/audit.md\` — is read with
 * \`design_check\`, action \`guide\`, name that key. \`PLAYBOOKS\` is the routing table: name to one-line
 * description, with the body at \`reference/<name>.md\`. The router lives in \`router.ts\` and is not
 * imported.
 */

/** Guidance bodies by key. */
export const GUIDANCE: Readonly<Record<string, string>> = ${emit(guidance)};

/** Playbook names and their one-line descriptions, for completion and routing. */
export const PLAYBOOKS: Readonly<Record<string, string>> = ${emit(playbooks)};
`;

if (unresolved.length > 0) {
	console.error(`import-guidance: ${unresolved.length} cross-reference(s) point outside the corpus:`);
	for (const line of unresolved) console.error(`  ${line}`);
	console.error("Fix those in the source tree, or add the missing files, before importing.");
	process.exit(1);
}

if (dryRun) {
	console.log(`import-guidance: would write ${Object.keys(guidance).length} guidance keys and ${Object.keys(playbooks).length} playbooks to ${corpusFile}`);
} else {
	writeFileSync(corpusFile, body);
	writeFileSync(provenanceFile, `${JSON.stringify(provenance, null, "\t")}\n`);
	console.log(`import-guidance: wrote ${Object.keys(guidance).length} guidance keys and ${Object.keys(playbooks).length} playbooks to ${corpusFile}`);
}
