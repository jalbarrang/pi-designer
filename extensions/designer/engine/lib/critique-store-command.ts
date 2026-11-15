/**
 * The critique store, as a command: `slug`, `latest`, `write`, `trend` and `close`.
 *
 * The storage itself is `critique-storage.ts`, compared against the reference. This layer is the five
 * operations the playbooks call, returning text a session reads instead of writing to stdout, so a
 * caller owns its exit codes and a "nothing stored yet" is a sentence rather than a failure.
 */
import fs from "node:fs";
import path from "node:path";
import { closeSnapshotForTarget, readTrend, resolveLatestSnapshot, slugFromTarget, writeSnapshotForTarget } from "../critique-storage.ts";

/** What one store command produced. */
interface StoreResult {
	readonly text: string;
	readonly failed?: boolean;
}

/** The subcommands the playbooks use, in the order they document them. */
const STORE_COMMANDS: readonly string[] = ["slug", "latest", "write", "trend", "close"];

/**
 * Run one store subcommand.
 *
 * `write` takes a body file, because a critique report is long enough that passing it as an argument
 * would be a quoting hazard. `close` names the snapshot file `latest` returned, and refuses anything
 * that is not a snapshot for that slug — the store never deletes a file it did not write.
 */
function runCritiqueStore({ args, cwd = process.cwd() }: { readonly args: readonly string[]; readonly cwd?: string }): StoreResult {
	const [command, ...rest] = args;
	const positional = rest.filter((value) => !value.startsWith("--"));
	const json = rest.includes("--json");

	if (command === "latest") {
		const target = positional[0];
		if (!target) return { text: "usage: critique-storage latest <target> [--json]", failed: true };

		const result = resolveLatestSnapshot(target, { cwd });
		if (result.status === "none") return { text: `no snapshot stored for ${target}` };
		if (result.status === "ambiguous") return { text: result.message ?? `several snapshots match ${target}; name the file with close`, failed: true };

		const snapshot = result.snapshot as { path: string; meta: Record<string, unknown> };
		if (json) return { text: JSON.stringify({ path: snapshot.path, ...snapshot.meta }, null, 2) };
		const score = snapshot.meta.total_score ?? snapshot.meta.score ?? "unscored";
		return { text: `${snapshot.path}\nscore ${String(score)}  p0 ${String(snapshot.meta.p0_count ?? 0)}  p1 ${String(snapshot.meta.p1_count ?? 0)}` };
	}

	if (command === "write") {
		const [target, bodyFile] = positional;
		if (!target || !bodyFile) return { text: "usage: critique-storage write <target> <body-file>", failed: true };

		let body: string;
		try {
			body = fs.readFileSync(path.isAbsolute(bodyFile) ? bodyFile : path.resolve(cwd, bodyFile), "utf-8");
		} catch (error) {
			return { text: `cannot read ${bodyFile}: ${(error as Error).message}`, failed: true };
		}

		// The score keys ride in as metadata: upstream reads them from an environment variable, which is a
		// quoting hazard for a caller, so here they are a flag.
		let meta: Record<string, unknown> = {};
		const metaIndex = rest.indexOf("--meta");
		if (metaIndex !== -1 && rest[metaIndex + 1]) {
			try {
				meta = JSON.parse(rest[metaIndex + 1]) as Record<string, unknown>;
			} catch {
				return { text: "--meta must be a JSON object", failed: true };
			}
		}

		try {
			return { text: writeSnapshotForTarget({ target, meta, body, cwd }) };
		} catch (error) {
			return { text: (error as Error).message, failed: true };
		}
	}

	if (command === "trend") {
		const [target, limitText] = positional;
		if (!target) return { text: "usage: critique-storage trend <target> [limit]", failed: true };

		const limit = limitText ? Number(limitText) : 5;
		const slug = slugFromTarget(target, { cwd });
		if (!slug) return { text: `cannot derive a slug from ${target}`, failed: true };
		const rows = readTrend(slug, { limit: Number.isFinite(limit) && limit > 0 ? limit : 5, cwd });
		if (rows.length === 0) return { text: `no snapshots stored for ${target}` };
		return {
			text: rows
				.map((row) => `${String(row.timestamp ?? "?")}  score ${String(row.total_score ?? row.score ?? "-")}  p0 ${String(row.p0_count ?? 0)}  p1 ${String(row.p1_count ?? 0)}`)
				.join("\n"),
		};
	}

	if (command === "close") {
		const [target, snapshotFile] = positional;
		if (!target || !snapshotFile) return { text: "usage: critique-storage close <target> <snapshot-file>", failed: true };

		const closed = closeSnapshotForTarget(target, snapshotFile, { cwd });
		// A null means the file is not a snapshot for this slug: the store will not delete something it
		// did not write, so the refusal names both halves.
		if (!closed) return { text: `${snapshotFile} is not a snapshot for ${target}`, failed: true };
		return { text: `closed ${closed}` };
	}

	if (command === "slug") {
		const target = positional[0];
		if (!target) return { text: "usage: critique-storage slug <target>", failed: true };
		const slug = slugFromTarget(target, { cwd });
		return slug ? { text: slug } : { text: `cannot derive a slug from ${target}`, failed: true };
	}

	return { text: `usage: critique-storage <${STORE_COMMANDS.join("|")}> ...`, failed: true };
}

export { runCritiqueStore, STORE_COMMANDS };
export type { StoreResult };
