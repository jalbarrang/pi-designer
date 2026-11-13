/**
 * Vendors the Pi build of Impeccable from the upstream repo into this extension.
 *
 * Upstream (github.com/pbakaus/impeccable, mirrored at ~/fun/drekki/impeccable)
 * is a build system: `skill/SKILL.src.md` is the source and `bun run build:skills`
 * generates one tree per provider, including `.pi/` for Pi. Those trees bake
 * project-relative paths (`.pi/skills/impeccable/scripts/impeccable`) into the
 * guidance, which is correct for a repo-root install and wrong for a user-level
 * extension. So this script copies the generated Pi tree and rewrites those
 * paths to the extension's own absolute location.
 *
 * Usage, from this extension directory:
 *   bun scripts/sync-upstream.mjs
 *   bun scripts/sync-upstream.mjs --source /path/to/impeccable
 *   bun scripts/sync-upstream.mjs --dry-run
 *
 * The engine binary is NOT copied: the bundled `scripts/impeccable` launcher
 * downloads the version-pinned release into ~/.impeccable/bin/<version>/ and
 * verifies its sha256 sidecar on first use.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_DEST = join(HERE, "skill");
/** Upstream provider output for Pi, relative to the upstream repo root. */
const SKILL_SOURCE = join(".pi", "skills", "impeccable");
const DEFAULT_UPSTREAM = "/Users/jalbarran/fun/drekki/impeccable";
/** Text files carrying baked-in paths; binaries would be corrupted by a rewrite. */
const REWRITABLE = /\.(md|json|js|mjs|cjs|sh|cmd|txt|toml|ya?ml)$/i;
/** What upstream bakes into its Pi build, and what a relocated install must say. */
const BAKED_PREFIX = ".pi/skills/impeccable";
const BAKED_SCRIPTS = `${BAKED_PREFIX}/scripts`;

function parseArgs(argv) {
	const args = { source: process.env.IMPECCABLE_UPSTREAM ?? DEFAULT_UPSTREAM, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--source") args.source = argv[++i];
		else if (argv[i] === "--dry-run") args.dryRun = true;
		else throw new Error(`unknown argument: ${argv[i]}`);
	}
	return { ...args, source: resolve(args.source) };
}

/** Recursively list files under `dir`, as paths relative to `base` with forward slashes. */
function listFiles(dir, base = dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full, base));
		else out.push(relative(base, full).split("\\").join("/"));
	}
	return out;
}

/** Read `version: x.y.z` from SKILL.md frontmatter. */
function skillVersion(skillDir) {
	const frontmatter = readFileSync(join(skillDir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return frontmatter?.[1].match(/^version:\s*(.+)$/m)?.[1].trim() ?? "unknown";
}

function upstreamCommit(source) {
	try {
		const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim()
			? " (working tree dirty)"
			: "";
		return `${sha.slice(0, 12)}${dirty}`;
	} catch {
		return "unknown";
	}
}

const options = parseArgs(process.argv.slice(2));
const sourceSkill = join(options.source, SKILL_SOURCE);

if (!existsSync(join(sourceSkill, "SKILL.md"))) {
	console.error(
		`No Impeccable Pi build at ${sourceSkill}\nRun \`bun run build:skills\` in ${options.source}, or pass --source <repo>.`,
	);
	process.exit(1);
}

const files = listFiles(sourceSkill);
const before = files.length;
const manifest = {
	source: options.source,
	sourceSkill: SKILL_SOURCE,
	commit: upstreamCommit(options.source),
	skillVersion: skillVersion(sourceSkill),
	engineVersion: readFileSync(join(sourceSkill, "scripts", "VERSION"), "utf8").trim(),
	rewrittenFrom: BAKED_SCRIPTS,
	rewrittenTo: join(SKILL_DEST, "scripts"),
};
console.log(`Impeccable ${manifest.skillVersion} (engine ${manifest.engineVersion}) at ${manifest.commit}`);
console.log(`Vendoring ${before} files from ${sourceSkill}`);

if (options.dryRun) {
	console.log(`Would write ${SKILL_DEST} and rewrite ${BAKED_SCRIPTS} -> ${manifest.rewrittenTo}`);
	process.exit(0);
}

rmSync(SKILL_DEST, { recursive: true, force: true });
mkdirSync(SKILL_DEST, { recursive: true });
cpSync(sourceSkill, SKILL_DEST, { recursive: true, preserveTimestamps: true });

// Rewrite the baked-in paths. `<skill-base-dir>` is what the skill documents,
// but a literal absolute path means every instruction stays executable even
// when the runtime reports no base directory.
let rewrittenFiles = 0;
let rewrittenOccurrences = 0;
for (const file of listFiles(SKILL_DEST)) {
	if (!REWRITABLE.test(file)) continue;
	const target = join(SKILL_DEST, file);
	const text = readFileSync(target, "utf8");
	if (!text.includes(BAKED_SCRIPTS)) continue;

	const occurrences = text.split(BAKED_SCRIPTS).length - 1;
	writeFileSync(target, text.split(BAKED_SCRIPTS).join(manifest.rewrittenTo), { mode: statSync(target).mode });
	rewrittenFiles++;
	rewrittenOccurrences += occurrences;
}

// Fail loudly if upstream changes its path shape: a silent miss leaves the agent
// running commands against a directory that does not exist.
const leftovers = listFiles(SKILL_DEST).filter(
	(file) => REWRITABLE.test(file) && readFileSync(join(SKILL_DEST, file), "utf8").includes(BAKED_PREFIX),
);
if (leftovers.length > 0) {
	console.error(`Unrewritten ${BAKED_PREFIX} references remain in:\n  ${leftovers.join("\n  ")}`);
	console.error("Upstream changed its generated paths; update sync-upstream.mjs before using this tree.");
	process.exit(1);
}

manifest.rewrittenFiles = rewrittenFiles;
manifest.rewrittenOccurrences = rewrittenOccurrences;
manifest.files = before;
writeFileSync(join(SKILL_DEST, "UPSTREAM.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

// The launcher must stay executable: it is what provisions the engine.
const launcher = join(SKILL_DEST, "scripts", "impeccable");
if (!(statSync(launcher).mode & 0o111)) {
	console.error(`warning: ${launcher} is not executable; run chmod +x on it`);
}

console.log(`Rewrote ${rewrittenOccurrences} path reference(s) in ${rewrittenFiles} file(s)`);
console.log(`Wrote ${SKILL_DEST}`);
