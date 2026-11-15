/**
 * Parity check: critique persistence against the reference.
 *
 * A stored critique is the only thing polish inherits as a fix backlog, so a difference in
 * when a snapshot is considered live, closed, or stale silently loses work. These comparisons
 * build real snapshot directories and compare the module-level functions and the `latest`
 * decision.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, checkOk } from "../helpers/check.ts";

const port = await import("../../extensions/designer/engine/critique-storage.ts");

// ─── Pure helpers ──────────────────────────────────────────────────────────

for (const date of [new Date("2026-05-12T18:30:00.123Z"), new Date("2026-01-01T00:00:00.000Z")]) {
	check(`nowFilenameStamp(${date.toISOString()})`, port.nowFilenameStamp(date), date.toISOString().replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z"));
}

for (const slug of ["src-app-page", "a", "UPPER", "with/slash", ""]) {
	check(`isReadySlug(${JSON.stringify(slug)})`, port.isReadySlug(slug), /^[a-z0-9-]+$/.test(slug) && !slug.includes("/"));
}

// ─── Snapshot lifecycle over a real tree ───────────────────────────────────

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-critique-"));
fs.mkdirSync(path.join(cwd, ".impeccable"), { recursive: true });
fs.writeFileSync(path.join(cwd, "page.tsx"), "export const A = () => null;\n");

try {
	const now = new Date("2026-05-12T18:30:00.000Z");
	const portWritten = port.writeSnapshot({
		slug: "page",
		meta: { score: 7, p0: 1, timestamp: "clobbered", slug: "clobbered" },
		body: "# Critique\n\nBody text.\n",
		cwd,
		now,
	});
	check("writeSnapshot filename", path.basename(portWritten), `${port.nowFilenameStamp(now)}__page.md`);
	const written = fs.readFileSync(portWritten, "utf-8");
	checkOk("writeSnapshot writes numeric and slug keys", written.includes("score: 7") && written.includes("slug: page"), written.split("\n").slice(0, 6).join("|"));
	checkOk("writeSnapshot keeps computed keys", written.includes(`timestamp: ${port.nowFilenameStamp(now)}`) && !written.includes("clobbered"), written.split("\n").slice(0, 6).join("|"));

	// Two critiques in the same second must not overwrite each other.
	const second = port.writeSnapshot({ slug: "page", meta: { score: 8 }, body: "# Second\n", cwd, now });
	checkOk("same-second collision gets a suffix", /~\d{4}__page\.md$/.test(path.basename(second)), path.basename(second));
	check("both snapshots exist", fs.readdirSync(path.join(cwd, ".impeccable", "critique")).filter((n) => n.endsWith("__page.md")).length, 2);

	const latest = port.readLatestSnapshot("page", { cwd });
	check("readLatestSnapshot returns the newest", latest?.meta.score, 8);
	check("readTrend is oldest to newest", port.readTrend("page", { cwd }).map((row) => row.score), [7, 8]);

	// Fingerprints and identity keep two targets that share a slug apart.
	const identity = port.resolveTargetIdentity("page.tsx", { cwd });
	check("resolveTargetIdentity(file)", identity, `file:${path.join(cwd, "page.tsx")}`);
	check("resolveTargetIdentity(url)", port.resolveTargetIdentity("https://example.com/a/", { cwd }), "url:https://example.com/a");
	checkOk("fingerprintTarget(file)", port.fingerprintTarget("page.tsx", { cwd })?.startsWith("sha256:") === true);
	check("fingerprintTarget(missing)", port.fingerprintTarget("nope.tsx", { cwd }), null);

	// "page.tsx" slugs to page-tsx, which is the key a concrete target resolves to.
	const withIdentity = port.writeSnapshotForTarget({ target: "page.tsx", meta: { score: 9 }, body: "# Third\n", cwd, now: new Date("2026-05-12T18:31:00.000Z") });
	checkOk("identity snapshot written", fs.existsSync(withIdentity));

	const resolved = port.resolveLatestSnapshot("page.tsx", { cwd });
	check("resolveLatestSnapshot(file) status", resolved.status, "ok");
	check("resolveLatestSnapshot(file) picks the identity match", resolved.snapshot?.meta.score, 9);

	// The slug a target resolves to is what the snapshot is keyed by.
	check("coerceSlug(page.tsx)", port.coerceSlug("page.tsx"), "page-tsx");

	// A changed file invalidates its own backlog, and closing is idempotent.
	fs.writeFileSync(path.join(cwd, "page.tsx"), "export const A = () => 'changed';\n");
	check("resolveLatestSnapshot(changed file) is none", port.resolveLatestSnapshot("page.tsx", { cwd }).status, "none");
	// The changed-file lookup above closed this snapshot, so closing it again is a no-op.
	checkOk("closeSnapshot(already closed by the fingerprint check)", port.closeSnapshot(path.basename(withIdentity), { cwd }) === null);
	const fresh = port.writeSnapshotForTarget({ target: "page.tsx", meta: { score: 10 }, body: "# Fourth\n", cwd, now: new Date("2026-05-12T18:32:00.000Z") });
	checkOk("closeSnapshot(basename)", port.closeSnapshot(path.basename(fresh), { cwd }) !== null);
	check("closeSnapshot(already closed)", port.closeSnapshot(path.basename(withIdentity), { cwd }), null);
	check("closeSnapshot(outside the critique dir)", port.closeSnapshot(path.join(cwd, "page.tsx"), { cwd }), null);

	const across = port.readLatestSnapshotAcrossTargets({ cwd });
	checkOk("readLatestSnapshotAcrossTargets skips closed", across?.meta.closed !== true);

	// The parsed frontmatter round-trips.
	const parsed = JSON.parse(JSON.stringify(port.readLatestSnapshot("page", { cwd })?.meta ?? {}));
	checkOk("frontmatter has the computed keys", Boolean(parsed.timestamp && parsed.slug), JSON.stringify(parsed));
} finally {
	fs.rmSync(cwd, { recursive: true, force: true });
}
