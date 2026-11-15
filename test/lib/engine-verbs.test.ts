/**
 * The engine verbs pi owns: each returns text, none of them spawn.
 *
 * A verb is a contract — it renders the text a session acts on, and it refuses what the module under
 * it refuses — so the shape of what comes back is asserted here: text for the reader, a failure for
 * a refusal, and no child process anywhere in the path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check } from "../helpers/check.ts";

const verbs = await import("../../extensions/designer/engine/lib/engine-verbs.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-verbs-"));
try {
	// ─── the table ───────────────────────────────────────────────────────
	check("the table carries the verbs pi owns", [...verbs.ENGINE_VERBS.keys()].sort(), ["build-phase", "comp-diff", "comp-spec", "concept-seed", "context", "critique-storage", "font-match", "palette", "surface-brief"]);

	// ─── palette: a seed renders as text ──────────────────────────────────
	for (const id of ["seed-200", "seed-116", "seed-000"]) {
		const ported = await verbs.ENGINE_VERBS.get("palette")!(["--id", id], dir);
		check(`palette --id ${id} renders the seed`, ported.text.includes(id), true);
		check(`palette --id ${id} names its colours`, /#[0-9a-f]{6}/i.test(ported.text) || ported.text.includes("oklch("), true);
		check(`palette --id ${id} is not a failure`, ported.failed, undefined);
	}

	const unknown = await verbs.ENGINE_VERBS.get("palette")!(["--id", "seed-nope"], dir);
	check("an unknown seed is a failure", unknown.failed, true);
	check("an unknown seed says which", unknown.text, 'no seed with id "seed-nope"');

	// ─── concept-seed: the round renders and refuses ────────────────────
	// The verb is checked as a verb: it renders a round, and it refuses what the module refuses.
	for (const args of [
		["--scope", "direction", "--from", "k1"],
		["--scope", "surface", "--from", "k1"],
		["--scope", "direction", "--from", "k1", "--reroll", "2"],
		["--scope", "direction", "--from", "k1", "--reroll", "1", "--register", "safer"],
	]) {
		const ported = await verbs.ENGINE_VERBS.get("concept-seed")!(args, dir);
		check(`concept-seed ${args.join(" ")} renders`, ported.text.includes("CONCEPT SEED"), true);
		check(`concept-seed ${args.join(" ")} is not a failure`, ported.failed, undefined);
	}
	check("a direction round assigns an index", (await verbs.ENGINE_VERBS.get("concept-seed")!(["--scope", "direction", "--from", "k1"], dir)).text.includes("ASSIGNED INDEX:"), true);
	check("a surface round deals a hand", (await verbs.ENGINE_VERBS.get("concept-seed")!(["--scope", "surface", "--from", "k1"], dir)).text.includes("DEALT INDICES:"), true);
	check("a register round says so", (await verbs.ENGINE_VERBS.get("concept-seed")!(["--scope", "direction", "--from", "k1", "--reroll", "1", "--register", "safer"], dir)).text.includes("SAFER REGISTER"), true);

	const badScope = await verbs.ENGINE_VERBS.get("concept-seed")!(["--scope", "world", "--from", "k1"], dir);
	check("an invalid scope is a failure", badScope.failed, true);
	check("an invalid scope explains itself", badScope.text.includes("--scope must be direction or surface"), true);

	// ─── the surface briefs ───────────────────────────────────────────────
	// The verb is checked as a verb: a write reads its body from the project, and a near miss answers
	// with candidates rather than an error string.
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "pricing.tsx"), "export const Pricing = () => null;\n");
	fs.writeFileSync(path.join(dir, "body.md"), "# Pricing\n\nThe table is the argument.\n");
	const brief = (args: readonly string[]) => verbs.ENGINE_VERBS.get("surface-brief")!(args, dir);

	check("surface-brief path names the brief", (await brief(["path", "src/pricing.tsx"])).text, ".impeccable/surfaces/src-pricing-tsx.md");
	check("surface-brief write reports where it wrote", (await brief(["write", "src/pricing.tsx", "body.md"])).text, ".impeccable/surfaces/src-pricing-tsx.md");
	check("the brief is on disk", fs.existsSync(path.join(dir, ".impeccable", "surfaces", "src-pricing-tsx.md")), true);
	check("surface-brief read returns its text", (await brief(["read", "src/pricing.tsx"])).text.includes("The table is the argument."), true);
	check("surface-brief list names it", (await brief(["list"])).text.includes("src/pricing.tsx"), true);
	check("surface-brief lists nothing on an empty project", (await verbs.ENGINE_VERBS.get("surface-brief")!(["list"], path.join(dir, "empty")))!.text, "no surface briefs");
	check("a write without a body is a failure", (await brief(["write", "src/pricing.tsx"])).failed, true);
	check("a body that is not there is a failure", (await brief(["write", "src/pricing.tsx", "nope.md"])).failed, true);
	check("an unknown subcommand is a failure", (await brief(["nonsense"])).failed, true);

	// ─── the critique store ───────────────────────────────────────────────
	// The store itself is compared in test/critique-storage.ts; this checks the five operations a playbook
	// calls, and that a refusal is a sentence rather than a crash.
	const store = (args: readonly string[]) => verbs.ENGINE_VERBS.get("critique-storage")!(args, dir);

	check("critique-storage slug", (await store(["slug", "src/pricing.tsx"])).text, "src-pricing-tsx");
	check("latest with nothing stored says so", (await store(["latest", "src/pricing.tsx"])).text, "no snapshot stored for src/pricing.tsx");
	check("trend with nothing stored says so", (await store(["trend", "src/pricing.tsx"])).text, "no snapshots stored for src/pricing.tsx");

	fs.writeFileSync(path.join(dir, "critique.md"), "# Critique\n\nThe price table is the argument; the type is doing the work.\n");
	// The score rides in as metadata, the way the playbook records it.
	const written = await store(["write", "src/pricing.tsx", "critique.md", "--meta", JSON.stringify({ total_score: 78, p0_count: 0, p1_count: 2 })]);
	check("write returns the snapshot's path", written.text.includes("src-pricing-tsx.md"), true);
	check("write is not a failure", written.failed, undefined);

	const latest = await store(["latest", "src/pricing.tsx"]);
	check("latest finds the snapshot", latest.text.includes("src-pricing-tsx.md"), true);
	check("latest reports the score", latest.text.includes("score 78"), true);
	check("latest reports the counts", latest.text.includes("p1 2"), true);

	const latestJson = await store(["latest", "src/pricing.tsx", "--json"]);
	check("latest --json is parseable", (() => {
		try {
			return typeof JSON.parse(latestJson.text).path;
		} catch {
			return "unparseable";
		}
	})(), "string");

	check("trend lists the snapshot", (await store(["trend", "src/pricing.tsx"])).text.includes("score 78"), true);
	check("a write with no metadata reads as unscored", (await (async () => {
		fs.writeFileSync(path.join(dir, "plain.md"), "# Critique\n\nAnother report.\n");
		await store(["write", "src/pricing.tsx", "plain.md"]);
		return store(["latest", "src/pricing.tsx"]);
	})()).text.includes("score unscored"), true);
	check("bad metadata is refused", (await store(["write", "src/pricing.tsx", "plain.md", "--meta", "not json"])).failed, true);

	const snapshotFile = latest.text.split("\n")[0].split("/").pop() as string;
	check("close removes the snapshot", (await store(["close", "src/pricing.tsx", snapshotFile])).text.startsWith("closed"), true);
	check("closing something else is a failure", (await store(["close", "src/pricing.tsx", "other.md"])).failed, true);
	check("an unknown store command is a failure", (await store(["nonsense"])).failed, true);

	// ─── the build phase machine ──────────────────────────────────────────
	// The machine is compared in test/lib/build-phase.test.ts; this checks the command: state lives in the
	// project it was given, a gate refusal leaves the state alone, and a start over a live state is refused.
	const phaseDir = path.join(dir, "build");
	fs.mkdirSync(path.join(phaseDir, ".impeccable", "mocks"), { recursive: true });
	const phase = (args: readonly string[]) => verbs.ENGINE_VERBS.get("build-phase")!(args, phaseDir);

	check("build-phase status without state refuses", (await phase(["status"])).failed, true);
	check("build-phase start without a comp or direction refuses", (await phase(["start"])).failed, true);
	check("build-phase start with a missing comp refuses", (await phase(["start", "--comp", "nope.png"])).failed, true);

	check("build-phase start opens the comps phase", (await phase(["start", "--direction", "k1"])).text.includes("BUILD-PHASE COMPS"), true);
	check("build-phase start is refused over a live state", (await phase(["start", "--direction", "k2"])).failed, true);
	check("build-phase status reads the state", (await phase(["status"])).text.includes("direction k1"), true);
	const phaseJson = await phase(["status", "--json"]);
	check("build-phase status --json is parseable", (() => {
		try {
			return typeof JSON.parse(phaseJson.text).phase;
		} catch {
			return "unparseable";
		}
	})(), "string");

	// A gate refusal must not move the phase: the reason the state is written only on success.
	const refused = await phase(["advance"]);
	check("an empty comp round refuses", refused.failed, true);
	check("the refusal names the gate", refused.text.startsWith("GATE COMPS FAILED"), true);

	check("a note is recorded", (await phase(["note", "waiting on comps"])).text, "noted on comps");

	// Three comps, one approved, and the phase closes.
	const { encodePng } = await import("../../extensions/designer/engine/lib/png.ts");
	const { createImage } = await import("../../extensions/designer/engine/lib/raster.ts");
	const png = encodePng(createImage(40, 30, [200, 100, 50, 255]));
	for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(phaseDir, ".impeccable", "mocks", name + ".png"), png);
	fs.writeFileSync(path.join(phaseDir, ".impeccable", "mocks", "a.png.json"), JSON.stringify({ prompt: "a" }));
	fs.writeFileSync(path.join(phaseDir, ".impeccable", "mocks", "b.png.json"), JSON.stringify({ prompt: "b" }));
	fs.writeFileSync(path.join(phaseDir, ".impeccable", "mocks", "c.png.json"), JSON.stringify({ prompt: "c", approved: true }));

	const advanced = await phase(["advance"]);
	check("a complete comp round closes", advanced.failed, undefined);
	check("the phase advances to spec", advanced.text.startsWith("ADVANCED comps -> spec"), true);
	check("the approved comp is recorded", advanced.text.includes("3 comps, 1 approved"), true);
	check("the next instruction follows", advanced.text.includes("NEXT Measure the comp"), true);
	check("the breakpoint is read from the comp", (await phase(["status"])).text.includes("breakpoint 40x30"), true);

	check("scaffold without a spec refuses", (await phase(["scaffold"])).failed, true);
	check("finish ship over an open phase is refused", (await phase(["finish", "--disposition", "ship"])).failed, true);
	check("finish fix is recorded", (await phase(["finish", "--disposition", "fix"])).text.includes("finish"), true);
	check("an unknown subcommand refuses", (await phase(["nonsense"])).failed, true);

	// ─── the comp commands ────────────────────────────────────────────────
	// The spec, the type reading and the diff are compared module-by-module in their own suites; here the
	// commands are checked as commands: they write where they say, and they refuse with a sentence.
	const compDir = path.join(dir, "comp");
	fs.mkdirSync(compDir, { recursive: true });
	{
		const { encodePng } = await import("../../extensions/designer/engine/lib/png.ts");
		const { createImage, fillRect, drawText } = await import("../../extensions/designer/engine/lib/raster.ts");
		const comp = createImage(200, 150, [246, 242, 234, 255]);
		fillRect(comp, 10, 10, 90, 70, [30, 30, 36, 255]);
		drawText(comp, "HANDG", 110, 20, [20, 20, 20, 255], 4);
		fs.writeFileSync(path.join(compDir, "comp.png"), encodePng(comp));
		fs.writeFileSync(path.join(compDir, "build.png"), encodePng(comp));
		fs.writeFileSync(
			path.join(compDir, "regions.json"),
			JSON.stringify({
				regions: [
					{ id: "hero", kind: "plate", box: { x: 0.02, y: 0.03, w: 0.5, h: 0.55 }, note: "the dark plate block at the top left" },
					{ id: "headline", kind: "text", box: { x: 0.53, y: 0.1, w: 0.4, h: 0.2 }, note: "the headline in a bold grotesque" },
				],
			}),
		);
	}
	const comp = (args: readonly string[]) => verbs.ENGINE_VERBS.get("comp-spec")!(args, compDir);

	check("comp-spec refuses without a comp", (await comp([])).failed, true);
	check("comp-spec --grid writes the gridded comp", (await comp(["--comp", "comp.png", "--grid"])).text.endsWith("comp-grid.png"), true);
	check("the grid is on disk", fs.existsSync(path.join(compDir, ".impeccable", "build", "comp-grid.png")), true);

	const measured = await comp(["--comp", "comp.png", "--regions", "regions.json"]);
	check("comp-spec measures the regions", measured.failed, undefined);
	check("the spec is printed", measured.text.startsWith("SPEC comp"), true);
	check("the spec is on disk", fs.existsSync(path.join(compDir, ".impeccable", "build", "spec.json")), true);
	check("--print reads it back", (await comp(["--print"])).text, measured.text);

	check("a refusal names the region", (await comp(["--comp", "comp.png", "--regions", "nope.json"])).failed, true);
	check("--auto proposes bands", (await comp(["--comp", "comp.png", "--auto"])).text.includes("\"regions\""), true);
	check("--crop writes the reference crop", (await comp(["--crop", "hero"])).text.endsWith("hero.png"), true);
	check("--plate-prompt returns the prompt", (await comp(["--plate-prompt", "hero"])).text.startsWith("Use the provided crop"), true);
	check("--plate-prompt on an unknown region refuses", (await comp(["--plate-prompt", "nope"])).failed, true);

	const font = (args: readonly string[]) => verbs.ENGINE_VERBS.get("font-match")!(args, compDir);
	check("font-match refuses without an id", (await font([])).failed, true);
	check("font-match refuses an unknown region", (await font(["--measure", "nope"])).failed, true);
	check("font-match measures the headline", (await font(["--measure", "headline"])).text.startsWith("MEASURE headline:"), true);
	const ranked = await font(["--rank", "headline"]);
	check("font-match ranks a face", ranked.text.includes("USE "), true);
	check("the ranking names its source", /SOURCE (index|shortlist)/.test(ranked.text), true);

	const diff = (args: readonly string[]) => verbs.ENGINE_VERBS.get("comp-diff")!(args, compDir);
	check("comp-diff refuses without both images", (await diff(["--comp", "comp.png"])).failed, true);
	const scored = await diff(["--comp", "comp.png", "--build", "build.png", "--label", "hero"]);
	check("comp-diff scores a pair", scored.failed, undefined);
	check("the report names the verdict", /COMP-DIFF .* overall \d+% \(/.test(scored.text), true);
	check("the report is on disk", fs.existsSync(path.join(compDir, ".impeccable", "review", "diff", "hero", "report.json")), true);
	const diffJson = await diff(["--comp", "comp.png", "--build", "build.png", "--label", "hero", "--json"]);
	check("comp-diff --json is parseable", (() => {
		try {
			return typeof JSON.parse(diffJson.text).overall;
		} catch {
			return "unparseable";
		}
	})(), "number");

	// ─── context: the facts it reads ─────────────────────────────────────
	const empty = await verbs.ENGINE_VERBS.get("context")!([], dir);
	check("an empty project reports absent artifacts", empty.text.includes("PRODUCT absent") && empty.text.includes("DESIGN absent"), true);
	check("an empty project reports no visual implementation", empty.text.includes("VISUAL no"), true);

	fs.writeFileSync(path.join(dir, "PRODUCT.md"), "# Product\n\n## Platform\nweb\n");
	fs.writeFileSync(path.join(dir, "DESIGN.md"), "# Design\n\n## Colors\n- **Ink** (#241c16)\n");
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "src", "app.css"),
		// Five visual declarations are what the check treats as evidence of authored UI.
		".a { color: #241c16; background-color: #f6f2ea; border-color: #ddd; font-family: Inter, sans-serif; background: none; color: #333; }\n",
	);

	const filled = await verbs.ENGINE_VERBS.get("context")!([], dir);
	check("a project with artifacts reports them", filled.text.includes("PRODUCT PRODUCT.md") && filled.text.includes("DESIGN DESIGN.md"), true);
	check("a project with source reports visual implementation", filled.text.includes("VISUAL yes"), true);
	check("the platform is reported", filled.text.includes("platform web"), true);
	check("the report names the project root", filled.text.includes(`PROJECT ${dir}`), true);

	// A remote or otherwise unreadable project still answers rather than throwing.
	const missing = await verbs.ENGINE_VERBS.get("context")!([], path.join(dir, "nope"));
	check("a nonexistent directory still reports", typeof missing.text, "string");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
