/**
 * Parity check: the build phase machine against the reference.
 *
 * Two things here can go wrong without anyone noticing: a gate that stops refusing, and a
 * `--force` that starts accepting reasons. The first lets a wrong page through; the second puts the
 * model's own justification where the user's words belong. Both are compared directly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/build-phase.ts");
const ref = await import("../reference/impeccable-js/scripts/build-phase.mjs");

let failures = 0;
let comparisons = 0;

// Upstream names its scripts by absolute path and extension in gate messages (`node <abs>/comp-spec.mjs`);
// the port names the command (`comp-spec`), which is how pi invokes it. That difference is deliberate,
// so it is normalized on both sides before comparing and everything else is compared exactly.
const normalize = (value) =>
	JSON.parse(JSON.stringify(value), (key, v) =>
		typeof v === "string" ? v.replace(/\bnode\s+\S*?([a-z-]+)\.mjs\b/g, "$1").replace(/\b(build-phase|comp-spec|comp-diff|font-match|generate-image|concept-seed|serve-question|embed-prompt)\.mjs\b/g, "$1") : v,
	);

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(normalize(actual));
	const e = JSON.stringify(normalize(expected));
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const attempt = (fn) => {
	try {
		return fn();
	} catch (error) {
		return { error: String(error.message) };
	}
};
// Upstream names its scripts by absolute path in gate messages (`node <abs>/font-match.mjs`); the
// port names the command (`font-match`), which is how pi invokes it. Normalized before comparing.
const normalizePaths = (value) => JSON.parse(JSON.stringify(value), (key, v) => (typeof v === "string" ? v.replace(/node \S*\/(font-match|comp-spec|comp-diff|generate-image)\.mjs/g, "$1").replace(/(build-phase|comp-spec|comp-diff|font-match|generate-image)\.mjs/g, "$1") : v));
const withoutTime = (state) => JSON.parse(JSON.stringify(state), (key, value) => (key === "at" || key === "startedAt" || key === "openedAt" || key === "closedAt" || key === "createdAt" ? "pinned" : value));

// ─── constants and the phase list ──────────────────────────────────
check("PHASES", port.PHASES, ref.PHASES);
check("STATE_PATH", port.STATE_PATH, ref.STATE_PATH);
check("MOCKS_DIR", port.MOCKS_DIR, ref.MOCKS_DIR);
check("HERO_MIN", port.HERO_MIN, ref.HERO_MIN);
check("RESPONSIVE_MIN", port.RESPONSIVE_MIN, ref.RESPONSIVE_MIN);
check("PLATE_MIN", port.PLATE_MIN, ref.PLATE_MIN);
check("PLATE_STRUCTURE_MIN", port.PLATE_STRUCTURE_MIN, ref.PLATE_STRUCTURE_MIN);
check("HERO_REPRO", port.HERO_REPRO, ref.HERO_REPRO);
check("INVENTED_MIN", port.INVENTED_MIN, ref.INVENTED_MIN);

// ─── state construction ────────────────────────────────────────────
check("newState(empty)", withoutTime(port.newState()), withoutTime(ref.newState({})));
check("newState(with comp)", withoutTime(port.newState({ comp: "comp.png", breakpoint: "1536x1024", direction: "seed-1" })), withoutTime(ref.newState({ comp: "comp.png", breakpoint: "1536x1024", direction: "seed-1" })));
check("renderStatus(fresh)", port.renderStatus(port.newState({ comp: "comp.png", breakpoint: "1536x1024" })), ref.renderStatus(ref.newState({ comp: "comp.png", breakpoint: "1536x1024" })));
check("renderStatus(no comp)", port.renderStatus(port.newState()), ref.renderStatus(ref.newState({})));

for (const phase of port.PHASES) {
	const state = port.newState({ comp: "c.png" });
	state.phase = phase;
	check(`nextInstruction(${phase})`, port.nextInstruction(state), ref.nextInstruction({ ...state }));
}
check("nextInstruction(unknown)", port.nextInstruction({ ...port.newState(), phase: "nope" }), ref.nextInstruction({ ...ref.newState({}), phase: "nope" }));

// ─── force gating ──────────────────────────────────────────────────
const forceCases = [
	null,
	undefined,
	"",
	"too short",
	"the user said \"drop the comp, this is fine\" and moved on",
	'user: "the comp does not matter, skip it"',
	"the user approved the semantic translation, the comp is not needed",
	'the user said "should feel like an extension of her artwork"',
	"gate spec errored (boom), proceeding",
	"Paul said \"we don't need to match the comp, ship it\"",
	'they said "drop the plate"',
	'user said, "the mock is approved, ship it"',
	"the user wants the region ignored, quoted: \"drop the region\"",
];
for (const reason of forceCases) {
	check(`forceAllowed(${JSON.stringify(reason)})`, port.forceAllowed(reason), ref.forceAllowed(reason));
}

// ─── the comps gate ────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-buildphase-"));
const mocks = path.join(dir, "mocks");
const write = (rel, content = "x") => {
	const filePath = path.join(dir, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	check("gateComps(empty)", port.gateComps(port.newState(), { mocksDir: mocks }), ref.gateComps(ref.newState({}), { mocksDir: mocks }));

	write("mocks/a.png", "png");
	write("mocks/b.png", "png");
	check("gateComps(two, no sidecars)", port.gateComps(port.newState(), { mocksDir: mocks }), ref.gateComps(ref.newState({}), { mocksDir: mocks }));

	write("mocks/a.png.json", JSON.stringify({ prompt: "a" }));
	write("mocks/b.png.json", JSON.stringify({ prompt: "b" }));
	write("mocks/c.png", "png");
	write("mocks/c.png.json", JSON.stringify({ prompt: "c", approved: true }));
	check("gateComps(three, one approved)", port.gateComps(port.newState(), { mocksDir: mocks }), ref.gateComps(ref.newState({}), { mocksDir: mocks }));

	write("mocks/b.png.json", JSON.stringify({ prompt: "b", approved: true }));
	check("gateComps(two approved)", port.gateComps(port.newState(), { mocksDir: mocks }), ref.gateComps(ref.newState({}), { mocksDir: mocks }));

	// listComps reports what the gate reads.
	check("listComps", port.listComps(mocks), ref.listComps(mocks));

	// ─── the spec gate ─────────────────────────────────────────────────
	check("gateSpec(missing)", attempt(() => port.gateSpec(port.newState({ comp: "c.png" }), { specPath: path.join(dir, "nope.json") })), attempt(() => ref.gateSpec(ref.newState({ comp: "c.png" }), { specPath: path.join(dir, "nope.json") })));

	const specPath = path.join(dir, "spec.json");
	const baseSpec = {
		tool: "comp-spec",
		version: 1,
		createdAt: "pinned",
		comp: path.join(dir, "mocks/c.png"),
		warnings: [],
		uncoveredInkCells: [],
		compSize: { width: 300, height: 200 },
		aspect: 1.5,
		orientation: "landscape",
		palette: [{ hex: "#f6f2ea", coverage: 0.7 }],
		bands: [],
		regions: [
			{ id: "hero", kind: "plate", note: "the plate", box: { x: 0, y: 0, w: 0.5, h: 0.5 }, px: { x: 0, y: 0, w: 150, h: 100 }, aspect: 1.5, palette: [], detail: { energy: 5 }, medium: "raster", plate: "assets/plates/hero.png", text: null },
			{ id: "headline", kind: "text", note: "the headline", box: { x: 0.5, y: 0, w: 0.5, h: 0.3 }, px: { x: 150, y: 0, w: 150, h: 60 }, aspect: 2.5, palette: [], detail: { energy: 9 }, medium: "semantic", plate: null, text: "HEADLINE" },
		],
	};

	const specCases = {
		noRegions: { ...baseSpec, regions: [] },
		otherComp: { ...baseSpec, comp: path.join(dir, "other.png") },
		clipped: { ...baseSpec, regions: [{ ...baseSpec.regions[0], clipped: ["left", "bottom"] }, baseSpec.regions[1]] },
		unmeasured: baseSpec,
		measuredNoChoice: { ...baseSpec, regions: [{ ...baseSpec.regions[0] }, { ...baseSpec.regions[1], type: { comp: { capHeightPx: 40 }, widthClass: "normal", weightClass: "bold" } }] },
		handTypedChoice: { ...baseSpec, regions: [{ ...baseSpec.regions[0] }, { ...baseSpec.regions[1], type: { comp: { capHeightPx: 40 }, widthClass: "normal", weightClass: "bold", chosen: { family: "Arial Narrow", weight: 400, fontSizePx: 30, source: "system-fallback" } } }] },
	};

	for (const [name, spec] of Object.entries(specCases)) {
		fs.writeFileSync(specPath, JSON.stringify(spec));
		check(`gateSpec(${name})`, normalizePaths(attempt(() => port.gateSpec(port.newState({ comp: path.join(dir, "mocks/c.png") }), { specPath }))), normalizePaths(attempt(() => ref.gateSpec(ref.newState({ comp: path.join(dir, "mocks/c.png") }), { specPath }))));
	}

	// A stamped choice is what the gate accepts.
	const { stampChoice } = await import("../extensions/designer/engine/lib/font-match.ts");
	const stamped = stampChoice("headline", { family: "Inter", weight: 700, fontSizePx: 56, source: "index" });
	fs.writeFileSync(specPath, JSON.stringify({ ...baseSpec, regions: [{ ...baseSpec.regions[0] }, { ...baseSpec.regions[1], type: { comp: { capHeightPx: 40 }, widthClass: "normal", weightClass: "bold", chosen: stamped } }] }));
	check("gateSpec(stamped choice)", attempt(() => port.gateSpec(port.newState({ comp: path.join(dir, "mocks/c.png") }), { specPath })), attempt(() => ref.gateSpec(ref.newState({ comp: path.join(dir, "mocks/c.png") }), { specPath })));

	// ─── the plates gate ───────────────────────────────────────────────
	check("gatePlates(no spec)", port.gatePlates(port.newState()), ref.gatePlates(ref.newState({})));
	fs.writeFileSync(specPath, JSON.stringify(baseSpec));
	check("gatePlates(missing plate)", port.gatePlates(port.newState(), { specPath }), ref.gatePlates(ref.newState({}), { specPath }));
	fs.writeFileSync(specPath, JSON.stringify({ ...baseSpec, regions: [{ ...baseSpec.regions[0], medium: "semantic", plate: null }, baseSpec.regions[1]] }));
	check("gatePlates(no raster)", port.gatePlates(port.newState(), { specPath }), ref.gatePlates(ref.newState({}), { specPath }));

	// ─── the plate verdict ─────────────────────────────────────────────
	const plateScore = (overrides) => ({ overall: 0.8, structure: 0.8, color: 0.8, colorIntersection: 0.8, paletteMatch: 0.8, detail: 0.8, detailRaw: 0.8, detailAdded: 0, bands: 0.8, ...overrides });
	const plateRegions = [
		{ ...baseSpec.regions[0] },
		{ ...baseSpec.regions[0], kind: "texture" },
		{ ...baseSpec.regions[0], detail: { energy: 40 } },
	];
	for (const [i, region] of plateRegions.entries()) {
		for (const [j, score] of [plateScore({}), plateScore({ overall: 0.2 }), plateScore({ structure: 0.2 }), plateScore({ detailAdded: 0.6 }), plateScore({ color: 0.2, detail: 0.2 })].entries()) {
			check(`plateVerdict(#${i}, score ${j})`, port.plateVerdict(region, score), ref.plateVerdict(region, score));
		}
	}

	// ─── the hero loop ─────────────────────────────────────────────────
	const historyState = (worst, scores) => {
		const state = port.newState({ comp: "c.png" });
		state.phase = "hero";
		state.phases.hero.history = scores.map((score, i) => ({ at: "pinned", score, worstIds: [worst], regionVerdicts: {}, artifactHash: String(i) }));
		return state;
	};
	for (const [worst, scores] of [["hero", [0.6, 0.61, 0.605]], ["hero", [0.6, 0.7, 0.8]], ["hero", [0.5, 0.5]]]) {
		const gate = { ok: false, reasons: [], score: scores[scores.length - 1], worstIds: [worst] };
		check(`heroLoopVerdict(${worst}, ${JSON.stringify(scores)})`, port.heroLoopVerdict(historyState(worst, scores), gate, path.join(dir, "artifact.html")), ref.heroLoopVerdict(historyState(worst, scores), gate, path.join(dir, "artifact.html")));
	}

	// ─── runGate surfaces a throwing gate as a refusal ─────────────────
	check("runGate(unknown phase)", port.runGate(port.newState(), "sections"), ref.runGate(ref.newState({}), "sections"));
	check("runGate(comps, empty)", port.runGate(port.newState(), "comps", { mocksDir: mocks }), ref.runGate(ref.newState({}), "comps", { mocksDir: mocks }));

	// ─── advancing, refusing, forcing ──────────────────────────────────
	const advanceSetup = (phase) => {
		const state = port.newState({ comp: path.join(dir, "mocks/c.png") });
		state.phase = phase;
		state.phases[phase].status = "open";
		return state;
	};

	// `spec` cannot advance with an unmeasured spec, and the refusal is the same.
	fs.writeFileSync(specPath, JSON.stringify(baseSpec));
	const portRefusal = port.advance(advanceSetup("spec"), { gateOpts: { specPath } });
	const refRefusal = ref.advance(advanceSetup("spec"), { gateOpts: { specPath } });
	check("advance(spec, refused)", normalizePaths({ ok: portRefusal.ok, phase: portRefusal.phase, reasons: portRefusal.reasons }), normalizePaths({ ok: refRefusal.ok, phase: refRefusal.phase, reasons: refRefusal.reasons }));

	// A force with a reason that does not quote the user is refused too, and says so.
	const portForced = port.advance(advanceSetup("spec"), { force: true, reason: "the comp is hard to match", gateOpts: { specPath } });
	const refForced = ref.advance(advanceSetup("spec"), { force: true, reason: "the comp is hard to match", gateOpts: { specPath } });
	check("advance(spec, force refused)", normalizePaths({ ok: portForced.ok, reasons: portForced.reasons }), normalizePaths({ ok: refForced.ok, reasons: refForced.reasons }));

	// A force that quotes the user closes the phase and records it.
	const goodReason = 'Paul said "we don\'t need to match the comp here, ship it"';
	const portGood = port.advance(advanceSetup("spec"), { force: true, reason: goodReason, gateOpts: { specPath } });
	const refGood = ref.advance(advanceSetup("spec"), { force: true, reason: goodReason, gateOpts: { specPath } });
	check("advance(spec, force allowed)", { ok: portGood.ok, next: portGood.next, forced: portGood.forced }, { ok: refGood.ok, next: refGood.next, forced: refGood.forced });

	// The comps gate advances by naming the approved comp.
	const compsState = port.newState();
	const portComps = port.advance(compsState, { gateOpts: { mocksDir: mocks } });
	const refCompsState = ref.newState({});
	const refComps = ref.advance(refCompsState, { gateOpts: { mocksDir: mocks } });
	check("advance(comps)", { ok: portComps.ok, next: portComps.next, comp: compsState.comp, phase: compsState.phase }, { ok: refComps.ok, next: refComps.next, comp: refCompsState.comp, phase: refCompsState.phase });

	// `review` cannot advance.
	check("advance(review)", port.advance(advanceSetup("review")), ref.advance(advanceSetup("review")));

	// ─── finishing ─────────────────────────────────────────────────────
	// The reference keeps `finish` in its CLI rather than its exports, so the rule is asserted
	// directly: a ship is refused while any phase but review is open, and any other disposition is
	// accepted and recorded.
	for (const disposition of ["fix", "rebuild", "recapture"]) {
		const state = advanceSetup("hero");
		check(`finish(${disposition}) with an open hero`, port.finish(state, disposition).ok, true);
		check(`finish(${disposition}) records it`, state.finish.disposition, disposition);
	}
	check("finish(ship) refused over an open hero", port.finish(advanceSetup("hero"), "ship").ok, false);
	check("finish(ship) refusal names the open phase", port.finish(advanceSetup("hero"), "ship").error.includes("not closed"), true);
	check("finish(nonsense) refused", port.finish(advanceSetup("hero"), "nonsense").ok, false);

	// A ship over closed phases is allowed, and closes review behind it.
	const closedState = port.newState({ comp: "c.png" });
	for (const p of port.PHASES) closedState.phases[p].status = p === "review" ? "open" : "closed";
	closedState.phase = "review";
	check("finish(ship) closed", port.finish(closedState, "ship").ok, true);
	check("finish(ship) closes review", closedState.phases.review.status, "closed");
	check("shipAllowed(open hero)", port.shipAllowed(advanceSetup("hero")).ok, false);

	// ─── saving and loading ────────────────────────────────────────────
	const statePath = path.join(dir, "state.json");
	check("loadState(missing)", port.loadState(statePath), ref.loadState(statePath));
	port.saveState(port.newState({ comp: "c.png" }), statePath);
	check("loadState(present)", withoutTime(port.loadState(statePath)), withoutTime(ref.loadState(statePath)));

	// ─── plate references and the source walk ──────────────────────────
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(path.join(projectDir, "assets", "plates"), { recursive: true });
	fs.writeFileSync(path.join(projectDir, "index.html"), '<html><body><img src="assets/plates/hero.png"></body></html>');
	fs.writeFileSync(path.join(projectDir, "assets", "plates", "hero.png"), "png");
	const specForRefs = { ...baseSpec, regions: [{ ...baseSpec.regions[0], plate: "assets/plates/hero.png" }] };
	check("unreferencedPlates(referenced)", attempt(() => port.unreferencedPlates(specForRefs, path.join(projectDir, "index.html"), { cwd: projectDir, root: projectDir })), []);

	fs.writeFileSync(path.join(projectDir, "index.html"), "<html><body>nothing</body></html>");
	fs.rmSync(path.join(projectDir, "assets"), { recursive: true, force: true });
	check("unreferencedPlates(unreferenced)", attempt(() => port.unreferencedPlates(specForRefs, null, { cwd: projectDir, root: projectDir })).map((r) => r.id), ["hero"]);
	check("unreferencedPlates(no plates)", port.unreferencedPlates({ ...baseSpec, regions: [baseSpec.regions[1]] }), ref.unreferencedPlates({ ...baseSpec, regions: [baseSpec.regions[1]] }));

	// SVG and clip-path scans read the artifact.
	fs.writeFileSync(path.join(projectDir, "page.html"), '<div class="hero"></div><style>.hero { clip-path: polygon(0% 10%, 40% 4%, 80% 20%, 100% 60%, 70% 95%, 20% 88%); }</style>');
	check("organicClipRegions", attempt(() => port.organicClipRegions(path.join(projectDir, "page.html"), specForRefs)), attempt(() => ref.organicClipRegions(path.join(projectDir, "page.html"), specForRefs)));

	// ─── compRoundOpen ─────────────────────────────────────────────────
	const roundDir = path.join(dir, "round");
	fs.mkdirSync(roundDir, { recursive: true });
	check("compRoundOpen(nothing)", port.compRoundOpen(roundDir), ref.compRoundOpen(roundDir));
	fs.mkdirSync(path.join(roundDir, ".impeccable", "build"), { recursive: true });
	fs.writeFileSync(path.join(roundDir, ".impeccable", "build", "pending.json"), "{}");
	check("compRoundOpen(pending)", port.compRoundOpen(roundDir), ref.compRoundOpen(roundDir));
	fs.writeFileSync(path.join(roundDir, ".impeccable", "build", "state.json"), JSON.stringify({ ...port.newState(), phase: "hero", phases: { ...port.newState().phases, hero: { ...port.newState().phases.hero, status: "open" } } }));
	check("compRoundOpen(hero open)", port.compRoundOpen(roundDir)?.reason, ref.compRoundOpen(roundDir)?.reason);
	fs.mkdirSync(path.join(roundDir, ".impeccable"), { recursive: true });
	fs.writeFileSync(path.join(roundDir, ".impeccable", "config.json"), JSON.stringify({ buildPath: "code" }));
	check("compRoundOpen(code-led)", port.compRoundOpen(roundDir), ref.compRoundOpen(roundDir));
	check("readBuildPath(code)", port.readBuildPath(roundDir), ref.readBuildPath(roundDir));
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} build-phase comparisons failed`);
	process.exit(1);
}
console.log(`build-phase parity: ${comparisons} comparisons match the reference`);
