/**
 * Notice throttling and directive rendering for staleness findings. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A boot already carries the product record, the design system, a surface brief, native
 * references, and an update directive. An unthrottled staleness block would push real context
 * out of attention and train the agent to open every session with housekeeping, so the rules
 * are strict:
 *
 * - One directive for the whole set, never one per finding.
 * - A `mention` or `route` finding surfaces at most once a week per project. A finding the
 *   user already declined to act on must not reappear tomorrow.
 * - `auto` findings are not throttled and are never shown to the user: they are migrations
 *   the next write performs anyway, so the agent needs the note every session and the user
 *   needs it never.
 *
 * State lives in the user's home directory, not the project, so no gitignore entry is owed
 * and a clone does not inherit someone else's dismissals.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RENOTIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The throttle state file. Resolved per call so a test can redirect it. */
function cachePath(): string {
	return process.env.IMPECCABLE_STALENESS_CACHE || path.join(os.homedir(), ".impeccable", "staleness-check.json");
}

interface StalenessCache {
	projects: Record<string, Record<string, number>>;
}

function readCache(): StalenessCache {
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath(), "utf-8")) as Partial<StalenessCache>;
		return raw && typeof raw === "object" && raw.projects ? { projects: raw.projects } : { projects: {} };
	} catch {
		return { projects: {} };
	}
}

/**
 * Drop project entries whose newest stamp has aged past the renotify window. They would be
 * re-notified on the next boot anyway, so keeping them only lets the file accumulate one entry
 * per directory the engine has ever booted in, scratch dirs included.
 */
function pruneCache(cache: StalenessCache, now: number): StalenessCache {
	const projects: Record<string, Record<string, number>> = {};
	for (const [key, entries] of Object.entries(cache.projects || {})) {
		if (!entries || typeof entries !== "object") continue;
		const stamps = Object.values(entries).filter((value): value is number => typeof value === "number");
		if (stamps.length > 0 && now - Math.max(...stamps) < RENOTIFY_INTERVAL_MS) projects[key] = entries;
	}
	return { projects };
}

function writeCache(cache: StalenessCache): void {
	try {
		const filePath = cachePath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(cache));
	} catch {
		// Best effort: a read-only home directory means the notice repeats next session, which
		// is strictly better than failing the boot.
	}
}

function readJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Opt out with `IMPECCABLE_NO_STALENESS_CHECK=1` or `"stalenessCheck": false`. Local config
 * overrides shared, matching how the update check resolves.
 */
function stalenessCheckDisabled(roots: readonly string[] = [process.cwd()]): boolean {
	if (process.env.IMPECCABLE_NO_STALENESS_CHECK) return true;

	let value: boolean | undefined;
	for (const root of roots) {
		if (!root) continue;
		for (const name of ["config.json", "config.local.json"]) {
			const raw = readJson(path.join(root, ".impeccable", name));
			if (raw && typeof raw.stalenessCheck === "boolean") value = raw.stalenessCheck;
		}
	}
	return value === false;
}

/** The finding fields the notice needs. */
export interface NoticeFinding {
	readonly id: string;
	readonly artifact: string;
	readonly path: string | null;
	readonly severity: "auto" | "mention" | "route";
	readonly summary: string;
	readonly fix: string;
}

/**
 * Drop findings already surfaced for this project inside the renotify window and stamp the
 * ones that survive. `auto` findings pass through untouched and unstamped.
 */
function filterFreshFindings<T extends NoticeFinding>(
	findings: readonly T[],
	{ projectRoot, now = Date.now() }: { readonly projectRoot?: string | null; readonly now?: number } = {},
): T[] {
	if (findings.length === 0) return [];

	const auto = findings.filter((entry) => entry.severity === "auto");
	const notifiable = findings.filter((entry) => entry.severity !== "auto");
	if (notifiable.length === 0) return auto;

	const key = path.resolve(projectRoot || process.cwd());
	const cache = readCache();
	const seen = cache.projects[key] && typeof cache.projects[key] === "object" ? cache.projects[key] : {};

	const fresh = notifiable.filter((entry) => {
		const last = seen[entry.id];
		return !(typeof last === "number" && now - last < RENOTIFY_INTERVAL_MS);
	});

	// Forget stamps for findings that no longer fire, so a recurrence after a real fix is
	// reported again instead of being suppressed by an old stamp. This must run even when
	// nothing is fresh: the common shape is one finding fixed while another is still inside
	// its window.
	const live = new Set(notifiable.map((entry) => entry.id));
	const next: Record<string, number> = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
	for (const entry of fresh) next[entry.id] = now;

	if (JSON.stringify(next) !== JSON.stringify(seen)) {
		const pruned = pruneCache(cache, now);
		pruned.projects[key] = next;
		writeCache(pruned);
	}
	return [...auto, ...fresh];
}

/**
 * The single boot directive, or null when nothing survived throttling.
 *
 * The text is an instruction to the agent, not a report to the user: it says what to do per
 * severity, that a deprecated field is binding for the session, and that none of it may
 * reorder the requested task.
 */
function buildStalenessDirective(findings: readonly NoticeFinding[]): string | null {
	if (findings.length === 0) return null;

	const payload = findings.map((entry) => ({
		id: entry.id,
		artifact: entry.artifact,
		path: entry.path,
		severity: entry.severity,
		summary: entry.summary,
		fix: entry.fix,
	}));

	const hasReportable = findings.some((entry) => entry.severity !== "auto");
	const lines = [
		`CONTEXT_STALE:\n${JSON.stringify(payload, null, 2)}`,
		"Impeccable's own project files have drifted from what this version reads. Do not stop, reorder, or expand the requested task for any of this.",
		"By severity: `auto` is a migration the next write to that file performs anyway, so apply it then and do not raise it with the user. `mention` gets one short line in your reply with the offered fix. `route` names the command that owns the repair; offer it, and run it only if the user asks.",
		"A finding that reports a deprecated field is binding: treat that field as absent for every decision in this session, whatever value it holds.",
	];
	if (hasReportable) {
		lines.push(
			"Surface the reportable findings once, after the task response, in at most two sentences. They are already throttled, so say them plainly rather than hedging about whether they matter.",
		);
	}
	return lines.join(" ");
}

export { buildStalenessDirective, cachePath, filterFreshFindings, pruneCache, RENOTIFY_INTERVAL_MS, stalenessCheckDisabled };
export type { StalenessCache };
