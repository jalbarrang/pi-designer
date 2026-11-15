/**
 * Critique persistence: a per-target snapshot written after a critique run, and the reads the
 * polish workflow and the trend line need. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Each run writes `.impeccable/critique/<timestamp>__<slug>.md` with small YAML frontmatter
 * carrying the score and the P0/P1 counts. The slug comes from the *resolved* artifact, never
 * from prose, because slug stability across runs is what makes a trend readable.
 *
 * Snapshots also record the target's identity and a byte fingerprint. A slug is lossy — two
 * distinct targets can normalize to one — so identity is what keeps one target's backlog from
 * hiding another's, and a fingerprint is what makes a snapshot describe the bytes it was
 * written against.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getCritiqueDir } from "./lib/impeccable-paths.ts";
import { slugFromTarget } from "./lib/target-slug.ts";

/** A filename-safe UTC timestamp: hyphens for separators, trailing `Z`. */
function nowFilenameStamp(date: Date = new Date()): string {
	return date
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace(/-\d+Z$/, "Z");
}

/** The absolute path of a local target, or null for a URL or an empty target. */
function resolveLocalTargetPath(target: string | null | undefined, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	if (!target || /^https?:\/\//i.test(target)) return null;
	return path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
}

/**
 * A canonical identity for a target: the URL's origin and path, or the absolute file path.
 * This is what separates two targets a lossy slug would merge.
 */
function resolveTargetIdentity(target: string | null | undefined, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	if (!target || typeof target !== "string") return null;

	if (/^https?:\/\//i.test(target)) {
		try {
			const url = new URL(target);
			const pathname = url.pathname.replace(/\/+$/, "") || "/";
			return `url:${url.origin}${pathname}`;
		} catch {
			return null;
		}
	}

	const filePath = resolveLocalTargetPath(target, { cwd });
	return filePath ? `file:${filePath}` : null;
}

/**
 * A byte fingerprint for a local file target, or null for a URL or non-file.
 *
 * It describes bytes on purpose, not Git state or mtime: a critique often assesses an
 * uncommitted file, and a later polish run should inherit that backlog when the bytes are
 * unchanged regardless of staging.
 */
function fingerprintTarget(target: string | null | undefined, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	const filePath = resolveLocalTargetPath(target, { cwd });
	if (!filePath) return null;
	try {
		if (!fs.statSync(filePath).isFile()) return null;
		return `sha256:${createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
	} catch {
		return null;
	}
}

function serializeFrontmatter(obj: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) continue;
		const str = typeof value === "string" ? value : String(value);
		// Strings with `:` or `#` are quoted so the reader stays simple.
		const needsQuotes = typeof value === "string" && /[:#]/.test(str);
		lines.push(`${key}: ${needsQuotes ? JSON.stringify(str) : str}`);
	}
	lines.push("---");
	return lines.join("\n");
}

function parseFrontmatter(text: string): Record<string, unknown> {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const out: Record<string, unknown> = {};

	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const raw = line.slice(colon + 1).trim();

		if (/^".*"$/.test(raw)) {
			try {
				out[key] = JSON.parse(raw);
				continue;
			} catch {
				// Not JSON after all: keep the text.
			}
		} else if (/^-?\d+$/.test(raw)) {
			out[key] = Number(raw);
			continue;
		} else if (raw === "true" || raw === "false") {
			out[key] = raw === "true";
			continue;
		}
		out[key] = raw;
	}
	return out;
}

const SNAPSHOT_FILENAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:~\d{4})?__.+\.md$/;

/** One stored snapshot. */
export interface CritiqueSnapshot {
	readonly path: string;
	readonly body: string;
	readonly meta: Record<string, unknown>;
}

/**
 * Write a snapshot for `slug`. `meta` carries the frontmatter keys the trend reads; `body` is
 * the human-readable report. Returns the absolute path written.
 */
function writeSnapshot({
	slug,
	meta,
	body,
	cwd = process.cwd(),
	now = new Date(),
}: {
	readonly slug: string;
	readonly meta?: Record<string, unknown>;
	readonly body: string;
	readonly cwd?: string;
	readonly now?: Date;
}): string {
	if (!slug) throw new Error("writeSnapshot requires a slug");

	const dir = getCritiqueDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const timestamp = nowFilenameStamp(now);
	// The computed keys come last so caller metadata cannot clobber them and leave a filename
	// disagreeing with its own frontmatter.
	const front = serializeFrontmatter({ ...meta, timestamp, slug });
	const contents = `${front}\n${body.trim()}\n`;

	// Two critiques can finish in the same UTC second, so creation is exclusive and the
	// collision suffix is fixed-width: concurrent writers cannot replace history, and lexical
	// ordering still puts the newest entry last.
	for (let collision = 0; collision <= 9999; collision += 1) {
		const suffix = collision === 0 ? "" : `~${String(collision).padStart(4, "0")}`;
		const filePath = path.join(dir, `${timestamp}${suffix}__${slug}.md`);
		try {
			fs.writeFileSync(filePath, contents, { encoding: "utf-8", flag: "wx" });
			return filePath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
	}
	throw new Error(`Too many critique snapshots for ${slug} at ${timestamp}`);
}

/** Snapshot files matching a filename suffix, oldest to newest. */
function listSnapshots(suffix: string, cwd: string): string[] {
	const dir = getCritiqueDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((name) => SNAPSHOT_FILENAME.test(name) && name.endsWith(suffix))
		.sort()
		.map((name) => path.join(dir, name));
}

function readSnapshot(filePath: string | null | undefined): CritiqueSnapshot | null {
	if (!filePath) return null;
	const body = fs.readFileSync(filePath, "utf-8");
	return { path: filePath, body, meta: parseFrontmatter(body) };
}

function snapshotTargetIdentity(snapshot: CritiqueSnapshot | null | undefined): string | null {
	const identity = snapshot?.meta.target_identity;
	if (typeof identity === "string") return identity;
	const targetPath = snapshot?.meta.target_path;
	return typeof targetPath === "string" ? `file:${targetPath}` : null;
}

function readNewestSnapshot(slug: string, { cwd = process.cwd() }: { readonly cwd?: string } = {}): CritiqueSnapshot | null {
	return readSnapshot(listSnapshots(`__${slug}.md`, cwd).at(-1));
}

function readNewestSnapshotForIdentity(slug: string, targetIdentity: string | null, { cwd = process.cwd() }: { readonly cwd?: string } = {}): CritiqueSnapshot | null {
	const matches = listSnapshots(`__${slug}.md`, cwd)
		.map(readSnapshot)
		.filter((snapshot): snapshot is CritiqueSnapshot => !!snapshot && snapshotTargetIdentity(snapshot) === targetIdentity);
	return matches.at(-1) ?? null;
}

/** The most recent open snapshot for `slug`, or null when the newest is closed. */
function readLatestSnapshot(slug: string, { cwd = process.cwd() }: { readonly cwd?: string } = {}): CritiqueSnapshot | null {
	const latest = readNewestSnapshot(slug, { cwd });
	return latest?.meta.closed === true ? null : latest;
}

/**
 * Mark one exact snapshot closed without deleting the score history the trend reads.
 *
 * Exact identity matters: a newer critique may land after polish reads its backlog, and that
 * newer snapshot must stay live. `snapshotFile` may be an absolute path or a basename.
 */
function closeSnapshot(snapshotFile: string | null | undefined, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	if (!snapshotFile || typeof snapshotFile !== "string") return null;

	const dir = path.resolve(getCritiqueDir(cwd));
	const snapshotPath = path.isAbsolute(snapshotFile) ? path.resolve(snapshotFile) : path.resolve(dir, snapshotFile);
	const filename = path.basename(snapshotPath);
	// Only a snapshot in the critique directory may be rewritten, which keeps a caller-supplied
	// path from reaching any other file.
	if (path.dirname(snapshotPath) !== dir || !SNAPSHOT_FILENAME.test(filename)) return null;

	let snapshot: CritiqueSnapshot | null;
	try {
		if (!fs.lstatSync(snapshotPath).isFile()) return null;
		snapshot = readSnapshot(snapshotPath);
	} catch {
		return null;
	}
	if (!snapshot || snapshot.meta.closed === true) return null;

	const closedBody = snapshot.body.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, "$1\nclosed: true$2");
	if (closedBody === snapshot.body) throw new Error(`Cannot close snapshot without frontmatter: ${snapshot.path}`);

	fs.writeFileSync(snapshot.path, closedBody, "utf-8");
	return snapshot.path;
}

/**
 * The most recent open snapshot across every target, or null.
 *
 * Slugs are lossy, so each identity's latest state is tracked independently: closing one
 * target cannot hide another's backlog. Once a slug has any identity-aware snapshot, its older
 * identity-less records are no longer independently routable and must not resurface.
 */
function readLatestSnapshotAcrossTargets({ cwd = process.cwd() }: { readonly cwd?: string } = {}): CritiqueSnapshot | null {
	const snapshots = listSnapshots(".md", cwd)
		.map(readSnapshot)
		.filter((snapshot): snapshot is CritiqueSnapshot => !!snapshot);

	const identifiedSlugs = new Set(
		snapshots.filter((snapshot) => snapshotTargetIdentity(snapshot)).map((snapshot) => snapshot.meta.slug as string),
	);

	const latestByTarget = new Map<string, CritiqueSnapshot>();
	for (const snapshot of snapshots) {
		const slug = snapshot.meta.slug;
		if (!slug) continue;
		const targetIdentity = snapshotTargetIdentity(snapshot);
		if (!targetIdentity && identifiedSlugs.has(slug as string)) continue;
		latestByTarget.set(targetIdentity || `slug:${slug}`, snapshot);
	}

	return (
		[...latestByTarget.values()]
			.filter((snapshot) => snapshot.meta.closed !== true)
			.sort((a, b) => a.path.localeCompare(b.path))
			.at(-1) ?? null
	);
}

/** The last `limit` snapshots' frontmatter, oldest to newest. */
function readTrend(slug: string, { limit = 5, cwd = process.cwd() }: { readonly limit?: number; readonly cwd?: string } = {}): Array<Record<string, unknown>> {
	const all = listSnapshots(`__${slug}.md`, cwd);
	return all.slice(-limit).map((file) => parseFrontmatter(fs.readFileSync(file, "utf-8")));
}

/** True when the value is already a slug rather than a path or URL. */
function isReadySlug(value: string | null | undefined): boolean {
	const text = value || "";
	return /^[a-z0-9-]+$/.test(text) && !text.includes("/");
}

/** A slug from either a ready slug or a concrete target. */
function coerceSlug(value: string | null | undefined): string | null {
	if (!value) return null;
	if (isReadySlug(value)) return value;
	return slugFromTarget(value);
}

/**
 * Write a snapshot for a target, stamping the identity and byte fingerprint the way the
 * command line does. The helper owns both, not the caller's metadata, so a snapshot always
 * describes the bytes it was written against and two targets that share a slug stay apart.
 */
function writeSnapshotForTarget({
	target,
	slug,
	meta = {},
	body,
	cwd = process.cwd(),
	now = new Date(),
}: {
	readonly target: string;
	readonly slug?: string;
	readonly meta?: Record<string, unknown>;
	readonly body: string;
	readonly cwd?: string;
	readonly now?: Date;
}): string {
	const resolvedSlug = slug ?? coerceSlug(target);
	if (!resolvedSlug) throw new Error("writeSnapshotForTarget requires a slug or a resolvable target");

	const clean = { ...meta };
	delete clean.target_fingerprint;
	delete clean.target_path;
	delete clean.target_identity;

	const targetIdentity = resolveTargetIdentity(target, { cwd });
	if (targetIdentity) clean.target_identity = targetIdentity;
	const targetFingerprint = fingerprintTarget(target, { cwd });
	if (targetFingerprint) {
		clean.target_fingerprint = targetFingerprint;
		clean.target_path = resolveLocalTargetPath(target, { cwd });
	}

	return writeSnapshot({ slug: resolvedSlug, meta: clean, body, cwd, now });
}

/**
 * The `latest` lookup, in one call instead of a CLI exit code.
 *
 * `status` is what the command line would have exited with: `ok` when a snapshot is returned,
 * `none` when there is none or it is closed, and `ambiguous` when a bare slug collides with a
 * local file of that name. The caller decides how to report it.
 */
export interface LatestSnapshotResult {
	readonly status: "ok" | "none" | "ambiguous";
	readonly snapshot?: CritiqueSnapshot;
	readonly message?: string;
}

/** Resolve the snapshot a polish run should read for a target. */
function resolveLatestSnapshot(target: string, { cwd = process.cwd() }: { readonly cwd?: string } = {}): LatestSnapshotResult {
	const slug = coerceSlug(target);
	if (!slug) return { status: "none" };

	const targetFingerprint = fingerprintTarget(target, { cwd });
	const targetPath = resolveLocalTargetPath(target, { cwd });
	const targetIdentity = resolveTargetIdentity(target, { cwd });
	const readySlug = isReadySlug(target);

	const newestForSlug = readNewestSnapshot(slug, { cwd });
	if (!newestForSlug) return { status: "none" };

	// A concrete target selects the newest snapshot for its exact identity, not merely the
	// newest filename for a lossy slug.
	let latest = readNewestSnapshotForIdentity(slug, targetIdentity, { cwd });
	if (!latest && !readySlug) latest = readNewestSnapshotForIdentity(slug, null, { cwd });
	if (!latest) latest = newestForSlug;
	if (latest.meta.closed === true) return { status: "none" };

	const recordedIdentity = snapshotTargetIdentity(latest);
	const matchingIdentity = recordedIdentity === targetIdentity;

	// A bare slug is a supported lookup, but when a same-named local file exists the request is
	// ambiguous unless that file owns the snapshot's identity.
	if (readySlug && !recordedIdentity) return { status: "ambiguous", message: "ambiguous legacy snapshot target; use an explicit ./path or full URL" };
	if (readySlug && targetPath && fs.existsSync(targetPath) && !matchingIdentity) {
		return { status: "ambiguous", message: "ambiguous snapshot slug; use an explicit ./path or remove the local name collision" };
	}

	const concreteTarget = !readySlug || matchingIdentity;
	if (concreteTarget && recordedIdentity && !matchingIdentity) return { status: "none" };

	if (concreteTarget && targetPath && latest.meta.target_fingerprint !== targetFingerprint) {
		// The file changed since the critique: the backlog no longer describes it.
		closeSnapshot(latest.path, { cwd });
		return { status: "none" };
	}

	return { status: "ok", snapshot: latest };
}

/** The `close` command's ownership check, as a function. */
function closeSnapshotForTarget(slugArgument: string, snapshotFile: string, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	const slug = coerceSlug(slugArgument);
	if (!slug) return null;

	const basename = path.basename(snapshotFile);
	if (basename !== snapshotFile || !SNAPSHOT_FILENAME.test(snapshotFile) || !snapshotFile.endsWith(`__${slug}.md`)) return null;

	const snapshotPath = path.join(getCritiqueDir(cwd), snapshotFile);
	const snapshot = readSnapshot(snapshotPath);
	if (!snapshot) return null;

	// A slug and a filename cannot prove ownership, because two targets can share a slug.
	// A snapshot that carries an identity must match the supplied target.
	const recordedIdentity = snapshotTargetIdentity(snapshot);
	if (recordedIdentity && recordedIdentity !== resolveTargetIdentity(slugArgument, { cwd })) return null;

	return closeSnapshot(snapshotFile, { cwd });
}

export {
	closeSnapshot,
	closeSnapshotForTarget,
	coerceSlug,
	fingerprintTarget,
	isReadySlug,
	nowFilenameStamp,
	readLatestSnapshot,
	readLatestSnapshotAcrossTargets,
	readTrend,
	resolveLatestSnapshot,
	resolveLocalTargetPath,
	resolveTargetIdentity,
	SNAPSHOT_FILENAME,
	slugFromTarget,
	writeSnapshot,
	writeSnapshotForTarget,
};
