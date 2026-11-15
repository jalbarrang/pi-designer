/**
 * The cheap, deterministic signals a bare session reads before choosing a command. Ported
 * from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * This gathers and never judges: no scoring, no detector run, no writes. The reader reasons
 * over the raw signals with the command catalog in hand. Every probe is best-effort and the
 * output is always valid.
 *
 * The interesting part is `git`: the merge base is detected rather than assumed, because a
 * hardcoded main/master list diffs a develop-based repo against the wrong branch and drags
 * the whole integration divergence into the scan target list.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadContext } from "./context.ts";
import { extractPlatform } from "./lib/platform.ts";
import { readLatestSnapshotAcrossTargets } from "./critique-storage.ts";

/** True when there is code here at all, not just context files. */
function hasCode(cwd: string): boolean {
	if (fs.existsSync(path.join(cwd, "package.json"))) return true;
	for (const dir of ["src", "app", "pages", "site", "public", "components", "lib"]) {
		if (fs.existsSync(path.join(cwd, dir))) return true;
	}
	return false;
}

/** The most recent critique snapshot across all targets, summarized. */
export interface CritiqueSignal {
	readonly slug: unknown;
	readonly score: number | null;
	readonly p0: number | null;
	readonly p1: number | null;
	readonly timestamp: unknown;
	readonly file: string;
}

function latestCritique(cwd: string): CritiqueSignal | null {
	try {
		const latest = readLatestSnapshotAcrossTargets({ cwd });
		if (!latest) return null;

		const get = (key: string): unknown => latest.meta[key] ?? null;
		const num = (value: unknown): number | null => {
			if (value == null || (typeof value === "string" && value.trim() === "")) return null;
			const n = Number(value);
			return Number.isFinite(n) ? n : null;
		};

		return {
			slug: get("slug"),
			score: num(get("total_score") ?? get("score")),
			p0: num(get("p0_count") ?? get("p0")),
			p1: num(get("p1_count") ?? get("p1")),
			timestamp: get("timestamp"),
			file: path.relative(cwd, latest.path),
		};
	} catch {
		return null;
	}
}

/** The branch, the detected merge base, and the files changed against it. */
export interface GitSignal {
	readonly isRepo: boolean;
	readonly branch: string | null;
	readonly base: string | null;
	readonly changedFiles: readonly string[];
	readonly changedCount: number;
}

/**
 * Branch plus a scope hint.
 *
 * The merge target is detected, most specific first: the branch's configured upstream, then
 * each remote's advertised default branch, then a develop branch if one exists, then the
 * conventional integration names. All of that is withheld when the current branch IS an
 * integration branch, or when the checkout is detached: the scope hint is then the working
 * tree, and no signal may override it.
 */
function gitSignals(cwd: string): GitSignal {
	const run = (args: readonly string[], { trim = true }: { readonly trim?: boolean } = {}): string | null => {
		try {
			const out = execFileSync("git", args as string[], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
			return trim ? out.trim() : out;
		} catch {
			return null;
		}
	};

	if (run(["rev-parse", "--is-inside-work-tree"]) !== "true") {
		return { isRepo: false, branch: null, base: null, changedFiles: [], changedCount: 0 };
	}

	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
	const remotes = (run(["remote"]) || "").split("\n").filter(Boolean);

	// The upstream is read as a FULL symbolic ref: refs/heads is a local upstream, refs/remotes
	// is remote-tracking. No string guessing on the abbreviated form survives contact with
	// reality — a local upstream named `release/2.0` is one branch name.
	const resolveUpstream = (): { name: string; rev: string } | null => {
		const full = run(["rev-parse", "--symbolic-full-name", "@{u}"]);
		if (!full) return null;
		if (full.startsWith("refs/heads/")) {
			const name = full.slice("refs/heads/".length);
			return { name, rev: name };
		}
		if (full.startsWith("refs/remotes/")) {
			const rest = full.slice("refs/remotes/".length);
			const index = rest.indexOf("/");
			if (index > 0) return { name: rest.slice(index + 1), rev: rest };
		}
		return null;
	};

	const conventional = ["develop", "main", "master"];
	const remoteHeads: Array<{ name: string; rev: string }> = [];
	for (const remote of [...new Set(["origin", ...remotes])]) {
		// The symref's prefix is the remote just queried, so it is stripped directly; the remote
		// need not appear in `git remote` output for a partial clone to fabricate refs.
		const ref = run(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
		if (ref && ref.startsWith(`${remote}/`)) remoteHeads.push({ name: ref.slice(remote.length + 1), rev: ref });
	}

	// On an integration branch the scope hint is the working tree, and an origin/HEAD naming a
	// different integration branch must not override it. A non-standard default like `trunk` is
	// guarded the same way, and a detached checkout has no branch identity to diff.
	const onIntegrationBranch = branch === "HEAD" || (branch !== null && conventional.includes(branch)) || remoteHeads.some((head) => head.name === branch);

	let base: string | null = null;
	let baseRev: string | null = null;

	if (!onIntegrationBranch) {
		const upstream = resolveUpstream();
		const remoteOrder = ["origin", ...remotes.filter((name) => name !== "origin")];
		const revsFor = (name: string): string[] => [name, ...remoteOrder.map((remote) => `${remote}/${name}`)];
		const candidates: Array<{ name: string; revs: string[] }> = [];
		const seen = new Set<string>();

		const addCandidate = (name: string | null, revs: readonly string[]) => {
			if (!name || name === branch || seen.has(name)) return;
			seen.add(name);
			candidates.push({ name, revs: [...revs] });
		};

		// The upstream tracks the actual merge target, so its own rev wins over a possibly stale
		// local branch of the same name.
		if (upstream) addCandidate(upstream.name, [upstream.rev]);

		// An existing develop marks a git-flow repo, where features merge to develop even when
		// the platform default was never flipped off main. A remote's advertised default prefers
		// its own remote-tracking rev over a stale local checkout, which is why the develop
		// candidate leads with it when the remote default IS develop.
		const advertisedRevs = (name: string): string[] => remoteHeads.filter((head) => head.name === name).map((head) => head.rev);
		addCandidate("develop", [...new Set([...advertisedRevs("develop"), ...revsFor("develop")])]);
		for (const head of remoteHeads) addCandidate(head.name, [...new Set([head.rev, ...revsFor(head.name)])]);
		for (const name of ["main", "master"]) addCandidate(name, revsFor(name));

		for (const candidate of candidates) {
			const rev = candidate.revs.find((r) => run(["rev-parse", "--verify", "--quiet", r]) !== null);
			if (!rev) continue;
			base = candidate.name;
			baseRev = rev;
			break;
		}
	}

	const diffBase = base && branch && branch !== base ? base : null;
	const fromDiff = diffBase && baseRev ? run(["diff", "--name-only", `${baseRev}...HEAD`]) : null;

	// Porcelain lines are `XY PATH`: two status characters, a space, then the path. The combined
	// output is not trimmed, because an unstaged-modified line starts with a leading space and a
	// global trim would eat the first line's status column.
	const fromStatus = run(["-c", "core.quotepath=false", "status", "--porcelain"], { trim: false });

	let changed: string[] = [];
	if (fromDiff) {
		changed = fromDiff.split("\n").filter(Boolean);
	} else if (fromStatus) {
		changed = fromStatus
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const rest = line.slice(3);
				const arrow = rest.indexOf(" -> ");
				return arrow === -1 ? rest : rest.slice(arrow + 4);
			});
	}

	return { isRepo: true, branch, base: diffBase, changedFiles: changed.slice(0, 50), changedCount: changed.length };
}

/** Ports a local dev server usually answers on. */
const COMMON_DEV_PORTS: readonly number[] = [4321, 3000, 5173, 5174, 8080, 8000, 4200];

/** True when something answers on the port. */
function probePort(port: number, timeout = 250): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = new net.Socket();
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				// Nothing to clean up.
			}
			resolve(ok);
		};
		sock.setTimeout(timeout);
		sock.once("connect", () => finish(true));
		sock.once("timeout", () => finish(false));
		sock.once("error", () => finish(false));
		sock.connect(port, "127.0.0.1");
	});
}

/** Which common dev ports answer, sorted. */
async function devServerSignals(): Promise<{ running: boolean; ports: number[] }> {
	const open: number[] = [];
	await Promise.all(
		COMMON_DEV_PORTS.map(async (port) => {
			if (await probePort(port)) open.push(port);
		}),
	);
	open.sort((a, b) => a - b);
	return { running: open.length > 0, ports: open };
}

/** Extensions the detector scans, mirroring its walk. */
const SCANNABLE_EXT: ReadonlySet<string> = new Set([".html", ".htm", ".css", ".scss", ".jsx", ".tsx", ".js", ".ts", ".vue", ".svelte", ".astro"]);

/** Where UI source usually lives. */
const SOURCE_DIRS: readonly string[] = ["src", "app", "components", "pages", "public"];

/**
 * True when a changed path sits under a hidden or dependency/build directory: a vendored harness
 * install, a build artifact, or a dependency. Mirrors the detector's walk rule, so a git-changes
 * target cannot resurface a path the walker would never visit.
 */
function isVendoredPath(rel: string): boolean {
	const dirSegments = rel.split(/[\\/]/).slice(0, -1);
	return dirSegments.some(
		(seg) =>
			(seg.startsWith(".") && seg !== ".vitepress" && seg !== ".vuepress" && seg !== ".storybook") ||
			seg === "node_modules" ||
			seg === "dist" ||
			seg === "build" ||
			seg === "__pycache__",
	);
}

/** Where a scan should point, and how that was decided. */
export interface ScanSignal {
	readonly targets: readonly string[];
	readonly via: "git-changes" | "source-dir" | "html" | "root" | null;
}

/**
 * Local paths a scan should point at, never a URL: a URL means a browser render, and a probed
 * port may not even belong to this project. A dirty tree wins (it is what the user is working
 * on and it is small), then the source directories that exist, then a root HTML entry, then the
 * project root when there is code but no conventional source dir.
 */
function scanTargets(cwd: string, git: GitSignal): ScanSignal {
	if (git.isRepo && git.changedFiles.length > 0) {
		const changed = git.changedFiles
			.filter((file) => SCANNABLE_EXT.has(path.extname(file).toLowerCase()))
			.filter((file) => !isVendoredPath(file))
			.filter((file) => fs.existsSync(path.join(cwd, file)));
		if (changed.length > 0) return { targets: changed.slice(0, 50), via: "git-changes" };
	}

	const dirs = SOURCE_DIRS.filter((dir) => fs.existsSync(path.join(cwd, dir)));
	if (dirs.length > 0) return { targets: dirs, via: "source-dir" };

	if (fs.existsSync(path.join(cwd, "index.html"))) return { targets: ["index.html"], via: "html" };
	if (hasCode(cwd)) return { targets: ["."], via: "root" };
	return { targets: [], via: null };
}

/** Everything a bare session reads before choosing a command. */
export interface ContextSignals {
	readonly setup: {
		readonly hasProduct: boolean;
		readonly productPath: string | null;
		readonly hasDesign: boolean;
		readonly designPath: string | null;
		readonly hasCode: boolean;
		readonly platform: string | null;
	};
	readonly critique: { readonly latest: CritiqueSignal | null };
	readonly git: GitSignal;
	readonly devServer: { readonly running: boolean; readonly ports: readonly number[] };
	readonly scan: ScanSignal;
}

/** Gather the signals for a directory. Every probe is best-effort. */
async function gatherSignals(cwd: string = process.cwd()): Promise<ContextSignals> {
	const ctx = loadContext(cwd);
	const git = gitSignals(cwd);

	return {
		setup: {
			hasProduct: ctx.hasProduct,
			productPath: ctx.productPath,
			hasDesign: ctx.hasDesign,
			designPath: ctx.designPath,
			hasCode: hasCode(cwd),
			platform: extractPlatform(ctx.product),
		},
		critique: { latest: latestCritique(cwd) },
		git,
		devServer: await devServerSignals(),
		scan: scanTargets(cwd, git),
	};
}

export { COMMON_DEV_PORTS, devServerSignals, gatherSignals, gitSignals, hasCode, isVendoredPath, latestCritique, probePort, scanTargets };
