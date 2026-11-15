/**
 * The paths the artifacts live at, resolved per project. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Every one of these goes through the project resolution rather than the working directory,
 * because a command run from a subdirectory must still find the project's own records. The
 * retired locations stay readable: a project created before a move keeps working.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot, type ContextOptions } from "../context.ts";
import { designSidecarCandidatesFor } from "./staleness.ts";
import { IMPECCABLE_COMMAND_PREFIX } from "./provider.ts";

const IMPECCABLE_DIR = ".impeccable";
const LIVE_DIR = "live";
const CRITIQUE_DIR = "critique";

/** `<project>/.impeccable`. */
function getImpeccableDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(resolveProjectRoot(cwd, options), IMPECCABLE_DIR);
}

/** The canonical design sidecar path. */
function getDesignSidecarPath(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getImpeccableDir(cwd, options), "design.json");
}

/** Every place a design sidecar may live, canonical first. */
function getDesignSidecarCandidates(cwd: string = process.cwd(), contextDir: string = cwd, options: ContextOptions = {}): string[] {
	return designSidecarCandidatesFor(resolveProjectRoot(cwd, options), contextDir);
}

/** The sidecar that actually exists, or null. */
function resolveDesignSidecarPath(cwd: string = process.cwd(), contextDir: string = cwd, options: ContextOptions = {}): string | null {
	return getDesignSidecarCandidates(cwd, contextDir, options).find((filePath) => fs.existsSync(filePath)) || null;
}

/** `<project>/.impeccable/live`. */
function getLiveDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getImpeccableDir(cwd, options), LIVE_DIR);
}

function getLiveConfigPath(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getLiveDir(cwd, options), "config.json");
}

/** The retired live config location, beside the scripts. */
function getLegacyLiveConfigPath(scriptsDir: string): string {
	return path.join(scriptsDir, "config.json");
}

/**
 * The live config in play: an env override first, then the canonical path, then the retired
 * one, and the canonical path anyway when neither exists (so a first write lands correctly).
 */
function resolveLiveConfigPath({
	cwd = process.cwd(),
	scriptsDir,
	env = process.env,
	targetPath,
}: {
	readonly cwd?: string;
	readonly scriptsDir?: string | null;
	readonly env?: Record<string, string | undefined>;
	readonly targetPath?: string | null;
} = {}): string {
	const configured = env.IMPECCABLE_LIVE_CONFIG?.trim();
	if (configured) return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);

	const primary = getLiveConfigPath(cwd, targetPath ? { targetPath } : {});
	if (fs.existsSync(primary)) return primary;

	if (scriptsDir) {
		const legacy = getLegacyLiveConfigPath(scriptsDir);
		if (fs.existsSync(legacy)) return legacy;
	}
	return primary;
}

function getLiveServerPath(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getLiveDir(cwd, options), "server.json");
}

function getLegacyLiveServerPath(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(resolveProjectRoot(cwd, options), ".impeccable-live.json");
}

/** The live helper's pid is reachable. EPERM means it exists but belongs to another user. */
function isLiveServerPidReachable(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
	}
}

/** A live server's recorded info and where it was found, cleaning up a dead pid's file. */
function readLiveServerInfo(
	cwd: string = process.cwd(),
	options: ContextOptions = {},
): { readonly info: Record<string, unknown>; readonly path: string } | null {
	for (const filePath of [getLiveServerPath(cwd, options), getLegacyLiveServerPath(cwd, options)]) {
		try {
			const info = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
			if (info && typeof info.pid === "number" && !isLiveServerPidReachable(info.pid)) {
				try {
					fs.unlinkSync(filePath);
				} catch {
					// A file that cannot be removed is still stale; the next read retries.
				}
				continue;
			}
			return { info, path: filePath };
		} catch {
			// Missing or unreadable: try the next location.
		}
	}
	return null;
}

function writeLiveServerInfo(cwd: string = process.cwd(), info: unknown, options: ContextOptions = {}): string {
	const filePath = getLiveServerPath(cwd, options);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(info));
	return filePath;
}

function removeLiveServerInfo(cwd: string = process.cwd(), options: ContextOptions = {}): void {
	for (const filePath of [getLiveServerPath(cwd, options), getLegacyLiveServerPath(cwd, options)]) {
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Already gone.
		}
	}
}

/**
 * Session ids become path segments, and they arrive from CLI arguments and HTTP payloads, so
 * anything with a separator or `..` must be rejected before it reaches `path.join`, which
 * would happily escape `.impeccable/live/`. Real ids are short slugs.
 */
function safeSessionId(id: unknown): string {
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`invalid session id: ${String(id)}`);
	return id;
}

function getLiveSessionsDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getLiveDir(cwd, options), "sessions");
}

function getLegacyLiveSessionsDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(resolveProjectRoot(cwd, options), ".impeccable-live", "sessions");
}

function getLiveAnnotationsDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getLiveDir(cwd, options), "annotations");
}

function getLegacyLiveAnnotationsDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(resolveProjectRoot(cwd, options), ".impeccable-live", "annotations");
}

/** `<project>/.impeccable/critique`. */
function getCritiqueDir(cwd: string = process.cwd(), options: ContextOptions = {}): string {
	return path.join(getImpeccableDir(cwd, options), CRITIQUE_DIR);
}

export {
	CRITIQUE_DIR,
	IMPECCABLE_DIR,
	IMPECCABLE_COMMAND_PREFIX,
	getCritiqueDir,
	getDesignSidecarCandidates,
	getDesignSidecarPath,
	getImpeccableDir,
	getLegacyLiveAnnotationsDir,
	getLegacyLiveConfigPath,
	getLegacyLiveServerPath,
	getLegacyLiveSessionsDir,
	getLiveAnnotationsDir,
	getLiveConfigPath,
	getLiveDir,
	getLiveServerPath,
	getLiveSessionsDir,
	isLiveServerPidReachable,
	LIVE_DIR,
	readLiveServerInfo,
	removeLiveServerInfo,
	resolveDesignSidecarPath,
	resolveLiveConfigPath,
	safeSessionId,
	writeLiveServerInfo,
};
