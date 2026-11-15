/**
 * The build status projection: one reading of `.impeccable/build`, shared by the detector, the image
 * generator's mock guard, and `build-phase start`.
 *
 * The states are the machine's opening moves, and the callers must not disagree about which one they
 * are in, so each file combination is checked against the answer it produces.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check } from "../helpers/check.ts";

const { compRoundOpen, newState, readBuildStatus } = await import("../../extensions/designer/engine/lib/build-phase.ts");
const { mockOutputAllowed } = await import("../../extensions/designer/engine/lib/generate-image.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-build-status-"));
const at = (rel: string) => path.join(dir, rel);
const write = (rel: string, content: string) => {
	fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
	fs.writeFileSync(at(rel), content);
};
const statePath = ".impeccable/build/state.json";
const pendingPath = ".impeccable/build/pending.json";
const mockOut = (name: string) => path.join(dir, ".impeccable", "mocks", name);

try {
	// ─── nothing on disk ───────────────────────────────────────────────
	check("nothing on disk is unstarted", readBuildStatus(dir).kind, "unstarted");
	check("nothing on disk opens no comp round", compRoundOpen(dir), null);

	// ─── a direction dealt, never started ──────────────────────────────
	write(pendingPath, JSON.stringify({ direction: "seed-1" }));
	check("a pending marker and no state is dealt", readBuildStatus(dir).kind, "dealt");
	check(
		"a dealt direction opens the comp round",
		compRoundOpen(dir)?.reason,
		"a direction was chosen (concept-seed rolled) but build-phase start never ran",
	);
	check("a comp into the mocks dir is refused", mockOutputAllowed({ out: mockOut("a.png"), cwd: dir }).ok, false);
	check("a comp elsewhere is allowed", mockOutputAllowed({ out: path.join(dir, "out", "a.png"), cwd: dir }).ok, true);
	check("--force-mock overrides the guard", mockOutputAllowed({ out: mockOut("a.png"), cwd: dir, force: true }).ok, true);

	// ─── started ───────────────────────────────────────────────────────
	write(statePath, JSON.stringify({ ...newState({ direction: "seed-1" }), phase: "hero" }));
	check("a state file is started", readBuildStatus(dir).kind, "started");
	check(
		"a pending marker left behind does not reopen the round",
		compRoundOpen(dir)?.reason,
		"build-phase is at hero; the comps phase never closed",
	);
	check("a comp is allowed once the build started", mockOutputAllowed({ out: mockOut("a.png"), cwd: dir }).ok, true);

	// ─── past the comps gate, before the hero ──────────────────────────
	const compsClosed = { ...newState({ direction: "seed-1" }), phase: "hero" };
	compsClosed.phases.comps.status = "closed";
	write(statePath, JSON.stringify(compsClosed));
	check("a closed comps phase narrows the reason to the hero", compRoundOpen(dir)?.reason, "build-phase is at hero; the hero gate has not passed");

	// ─── a build started with a comp in hand ───────────────────────────
	write(statePath, JSON.stringify({ ...newState({ comp: "/tmp/approved-comp.png" }), phase: "hero" }));
	check("a comp in hand skips the comp round", compRoundOpen(dir)?.reason, "build-phase is at hero; the hero gate has not passed");

	// ─── past the hero: no comp round to be open ───────────────────────
	write(statePath, JSON.stringify({ ...newState(), phase: "responsive" }));
	check("a build past the hero opens no comp round", compRoundOpen(dir), null);

	// ─── code-first: the comp round does not apply ─────────────────────
	write(".impeccable/config.json", JSON.stringify({ buildPath: "code" }));
	check("a code-first project opens no comp round", compRoundOpen(dir), null);
	fs.rmSync(at(".impeccable/config.json"));

	// ─── a state file nobody can parse ─────────────────────────────────
	write(statePath, "{ not json");
	check("an unreadable state file is unstarted", readBuildStatus(dir).kind, "unstarted");
	check("an unreadable state file opens no comp round", compRoundOpen(dir), null);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
