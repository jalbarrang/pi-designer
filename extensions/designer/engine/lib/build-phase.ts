/**
 * The build phase machine: eight gates between an approved direction and a finished page. Ported
 * from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The point of the gates is that a build cannot talk itself past one. Each returns reasons as
 * sentences a session can act on, and the only way past a refusal is a reason that quotes the user
 * downgrading the comp's authority — a missing tool, a single-file deliverable, or difficulty is
 * not one.
 *
 * Two seams keep this testable and host-free: the comp comparison is passed in (`diff`) instead of
 * spawning a script, and the pages, captures and spec are read from a `cwd`.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { encodePng, loadRaster } from "./png.ts";
import { blit, createImage, crop, resize } from "./raster.ts";
import { structureScore } from "./image-metrics.ts";
import { alignBuild, bestShift, compare, verdictFor, type CompareResult, type PairScore } from "./comp-diff.ts";
import { chromeStripCheck, inventedInk, plateClipCheck, svgIllustrations, textRegionCheck } from "./hero-checks.ts";
import { BUILD_DIR, loadSpec, plateReference, SPEC_PATH, type CompSpec, type SpecRegion } from "./comp-spec.ts";
import { choiceStamped } from "./font-match.ts";
import { scanCssTextForOrganicClipPath } from "../core/checks/html-patterns.ts";

const STATE_PATH = path.join(BUILD_DIR, "state.json");

/** The phases, in order. `sections` and `motion` have no mechanical gate. */
const PHASES = ["comps", "spec", "plates", "hero", "sections", "motion", "responsive", "review"] as const;

/** A phase's name. Derived from the order above, so the two cannot disagree. */
type Phase = (typeof PHASES)[number];

/**
 * A phase's status. These four are the whole machine: as a bare `string`, a status the gates never
 * write was free to appear, and every reader had to guess what it meant.
 */
type PhaseStatus = "pending" | "open" | "closed" | "skipped";

/** How a build ends, when it does. */
const DISPOSITIONS = ["ship", "fix", "rebuild", "recapture"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

/** A plate's verdict from the plates gate, carried on the state so the hero can tell placed from missing. */
type PlateStatus = "ok" | "missing" | "unreadable";

/** The recorded end of a build: which disposition, when, and where the machine stood. */
interface FinishRecord {
	disposition: Disposition;
	at: string;
	phaseAtFinish?: Phase;
}

/** Whether a value is a disposition this machine knows. */
function isDisposition(value: string | null | undefined): value is Disposition {
	return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

const MOCKS_DIR = path.join(".impeccable", "mocks");
const HERO_MIN = 0.72;
const RESPONSIVE_MIN = 0.65;
const PLATE_MIN = 0.4;
const PLATE_STRUCTURE_MIN = 0.4;
const HERO_REPRO = path.join(".impeccable", "review", "hero-repro.png");

/** Fraction of grid cells with invented ink that fails the hero. */
const INVENTED_MIN = 0.04;

const now = () => new Date().toISOString();
const here = () => path.join("extensions", "designer", "engine");

/** A gate's answer: never an exception, always reasons. */
interface GateResult {
	ok: boolean;
	reasons: string[];
	summary?: string;
	advisories?: string[];
	approved?: string | null;
	plates?: Array<{ id: string; file?: string | null; status: PlateStatus; size?: string; score?: number | null }>;
	score?: number;
	verdict?: string;
	worst?: string[];
	worstIds?: string[];
	worstCrops?: Array<{ id: string; verdict: string; score: PairScore; file: string }>;
	regionVerdicts?: Record<string, string>;
	report?: string;
	sideBySide?: string | null;
	error?: string;
}

/** One phase's record. */
interface PhaseState {
	status: PhaseStatus;
	openedAt: string | null;
	closedAt: string | null;
	attempts: number;
	notes: Array<{ at: string; text: string }>;
	gate: (Record<string, unknown> & { at?: string }) | null;
	forced: { at: string; reason: string; reasons: string[] } | null;
	history?: Array<{ at: string; score: number | null; worstIds: string[]; regionVerdicts: Record<string, string>; artifactHash: string | null }>;
	readingsSeen?: Record<string, number>;
	records?: number;
}

/** The whole state document. */
interface BuildState {
	tool: string;
	version: number;
	startedAt: string;
	comp: string | null;
	direction: string | null;
	breakpoint: string | null;
	artifact: string | null;
	phase: Phase;
	phases: Record<Phase, PhaseState>;
	plates?: Record<string, { status: PlateStatus; score?: number | null; size?: string }>;
	finish: FinishRecord | null;
}

/** The recorded build path, or null. */
function readBuildPath(cwd: string = process.cwd()): string | null {
	let value: string | null = null;
	for (const name of ["config.json", "config.local.json"]) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(cwd, ".impeccable", name), "utf8")) as { buildPath?: string };
			if (raw?.buildPath === "comp" || raw?.buildPath === "code") value = raw.buildPath;
		} catch {
			// Absent.
		}
	}
	return value;
}

/**
 * What the build files say, read once.
 *
 * The lifecycle is three files' worth of existence checks: no direction dealt, a direction dealt that
 * never started, or a build with a state file. Three callers used to re-derive it independently
 * (`compRoundOpen`, the image generator's mock guard, and `build-phase start`), which is three places
 * to get the same answer differently. This is the one reading.
 */
type BuildStatus =
	| { readonly kind: "unstarted" }
	| { readonly kind: "dealt"; readonly statePath: string; readonly pendingPath: string }
	| { readonly kind: "started"; readonly statePath: string; readonly state: BuildState };

/**
 * Read the build's status from disk.
 *
 * The `as BuildState` is the trust boundary: a state file this process did not write is assumed to
 * have the shape it wrote. An unreadable one reads as unstarted, because guessing a phase from a
 * half-written file is worse than saying nothing.
 */
function readBuildStatus(cwd: string = process.cwd()): BuildStatus {
	const statePath = path.join(cwd, STATE_PATH);
	if (fs.existsSync(statePath)) {
		try {
			return { kind: "started", statePath, state: JSON.parse(fs.readFileSync(statePath, "utf8")) as BuildState };
		} catch {
			return { kind: "unstarted" };
		}
	}

	const pendingPath = path.join(cwd, BUILD_DIR, "pending.json");
	if (fs.existsSync(pendingPath)) return { kind: "dealt", statePath, pendingPath };
	return { kind: "unstarted" };
}

/**
 * Whether a direction was dealt and the build never started, or started and stopped before the hero
 * gate: the condition a boot report and the detector call `COMP_ROUND_OPEN` when page code exists.
 */
function compRoundOpen(cwd: string = process.cwd()): { reason: string; pending?: string; state?: string } | null {
	// A code-first project has no comp round to be open.
	if (readBuildPath(cwd) === "code") return null;

	const status = readBuildStatus(cwd);
	if (status.kind === "dealt") {
		return { reason: "a direction was chosen (concept-seed rolled) but build-phase start never ran", pending: status.pendingPath };
	}
	if (status.kind !== "started") return null;

	const { state } = status;
	const idx = PHASES.indexOf(state.phase);
	if (idx === -1 || idx > PHASES.indexOf("hero")) return null;

	if (state.phases?.comps?.status !== "skipped" && state.phases?.comps?.status !== "closed") {
		return { reason: `build-phase is at ${state.phase}; the comps phase never closed`, state: status.statePath };
	}
	return { reason: `build-phase is at ${state.phase}; the hero gate has not passed`, state: status.statePath };
}

function loadState(statePath: string = STATE_PATH): BuildState | null {
	if (!fs.existsSync(statePath)) return null;
	return JSON.parse(fs.readFileSync(statePath, "utf8")) as BuildState;
}

function saveState(state: BuildState, statePath: string = STATE_PATH): void {
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** A fresh state: a comp already in hand skips the comp round. */
function newState({ comp = null, breakpoint = null, artifact = null, direction = null }: { readonly comp?: string | null; readonly breakpoint?: string | null; readonly artifact?: string | null; readonly direction?: string | null } = {}): BuildState {
	const first: Phase = comp ? "spec" : "comps";
	const phases = Object.fromEntries(
		PHASES.map((p): [Phase, PhaseState] => [
			p,
			{
				status: p === first ? "open" : "pending",
				openedAt: p === first ? now() : null,
				closedAt: null,
				attempts: 0,
				notes: [],
				gate: null,
				forced: null,
			},
		]),
	) as Record<Phase, PhaseState>;
	if (comp) {
		phases.comps.status = "skipped";
		phases.comps.notes.push({ at: now(), text: "started with an approved comp; the comp round happened before this state (surface round or manual)" });
	}

	return { tool: "build-phase", version: 2, startedAt: now(), comp, direction, breakpoint, artifact, phase: first, phases, finish: null };
}

/** Comp rasters directly under the mocks dir, with their sidecars. */
function listComps(mocksDir: string = MOCKS_DIR): Array<{ file: string; sidecarPath: string; sidecar: Record<string, unknown> | null; approved: boolean }> {
	if (!fs.existsSync(mocksDir)) return [];

	const out: Array<{ file: string; sidecarPath: string; sidecar: Record<string, unknown> | null; approved: boolean }> = [];
	for (const name of fs.readdirSync(mocksDir)) {
		if (!/\.(png|webp|jpe?g)$/i.test(name)) continue;
		const file = path.join(mocksDir, name);
		if (!fs.statSync(file).isFile()) continue;

		const sidecarPath = `${file}.json`;
		let sidecar: Record<string, unknown> | null = null;
		if (fs.existsSync(sidecarPath)) {
			try {
				sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
			} catch {
				sidecar = null;
			}
		}
		out.push({ file, sidecarPath, sidecar, approved: !!(sidecar && sidecar.approved === true) });
	}
	return out;
}

/** Three comps, each with a prompt sidecar, exactly one approved. */
function gateComps(state: BuildState, { mocksDir = MOCKS_DIR }: { readonly mocksDir?: string } = {}): GateResult {
	const comps = listComps(mocksDir);
	const reasons: string[] = [];

	if (comps.length < 3) {
		reasons.push(
			`${comps.length} comp${comps.length === 1 ? "" : "s"} under ${mocksDir}; the comp round puts three compositional options of the chosen direction in front of the user (reference/visualize.md). Generate the missing ones (harness image tool or generate-image.mjs), each with a .json sidecar holding its prompt.`,
		);
	}

	const noSidecar = comps.filter((c) => !c.sidecar);
	if (noSidecar.length > 0) reasons.push(`no prompt sidecar for: ${noSidecar.map((c) => path.basename(c.file)).join(", ")} (write <file>.json with { "prompt": "..." }; generate-image.mjs does this itself)`);

	const approved = comps.filter((c) => c.approved);
	if (approved.length === 0) {
		reasons.push(
			'no comp is approved: put the three comps in front of the user (decision page via serve-question.mjs, or the structured question tool), then set "approved": true in the chosen comp\'s sidecar. A delegated pick is recorded the same way and disclosed.',
		);
	}
	if (approved.length > 1) {
		reasons.push(`${approved.length} comps carry "approved": true; exactly one is the approved comp: ${approved.map((c) => path.basename(c.file)).join(", ")}`);
	}

	return { ok: reasons.length === 0, reasons, summary: `${comps.length} comps, ${approved.length} approved`, approved: approved.length === 1 ? approved[0].file : null };
}

/** The spec exists, matches the comp, is not clipping artwork, and its type is measured and ranked. */
function gateSpec(state: BuildState, { specPath = SPEC_PATH }: { readonly specPath?: string } = {}): GateResult {
	const spec = loadSpec(specPath);
	if (!spec) return { ok: false, reasons: [`no spec at ${specPath}: run comp-spec --comp ${state.comp} --grid, name the regions, then --regions regions.json`] };
	if (!spec.regions || spec.regions.length < 1) return { ok: false, reasons: ["spec has no regions"] };
	if (spec.comp && state.comp && path.resolve(spec.comp) !== path.resolve(state.comp)) {
		return { ok: false, reasons: [`spec measures ${spec.comp}, but this build started on ${state.comp}; re-run comp-spec on the approved comp`] };
	}

	const plates = spec.regions.filter((r) => r.medium === "raster").length;
	const cut = spec.regions.filter((r) => r.medium === "raster" && r.clipped && r.clipped.length > 0);
	if (cut.length > 0) {
		return { ok: false, reasons: cut.map((r) => `region ${r.id}: the comp's artwork runs off its box on the ${(r.clipped as string[]).join(" and ")}; widen the region's span so the box holds the whole shape with a margin (or set "bleed": true if the page really crops it there), then re-run comp-spec --regions`) };
	}

	// Type is measured, not guessed: the largest text region must carry a font-match measurement and a
	// ranked choice before page code exists. The lead region is the display type — the largest measured
	// cap height — not the biggest box, which is a table of rows.
	const textRegions = spec.regions
		.filter((r) => r.kind === "text")
		.sort((a, b) => {
			const ca = typedRegion(a).type?.comp?.capHeightPx ?? a.px.h * 0.4;
			const cb = typedRegion(b).type?.comp?.capHeightPx ?? b.px.h * 0.4;
			return cb - ca;
		});

	const reasons: string[] = [];
	if (textRegions.length > 0) {
		// When nothing is measured yet, ask for the measurements first: the lead is only knowable once
		// cap heights exist.
		const anyMeasured = textRegions.some((r) => typedRegion(r).type);
		if (!anyMeasured) {
			reasons.push(`measure the type before closing the spec: font-match --measure <id> for each text region (${textRegions.map((r) => r.id).join(", ")}); the region with the largest cap height is the lead and gets --rank.`);
			return { ok: false, reasons };
		}

		const measurable = textRegions.filter((r) => typedRegion(r).type?.comp);
		const lead = measurable[0] ?? textRegions[0];
		const leadType = typedRegion(lead).type;
		if (!leadType) {
			reasons.push(`the lead text region ${lead.id} has no type measurement: run font-match --measure ${lead.id} (and --rank ${lead.id} --text "<its first words>" to choose the face by metrics). Set font-size from the printed cap height; do not pick a face by name.`);
		} else if (leadType.comp && !leadType.chosen) {
			reasons.push(`the lead text region ${lead.id} is measured (${leadType.widthClass} ${leadType.weightClass}, cap ${leadType.comp.capHeightPx}px) but no face is ranked: run font-match --rank ${lead.id} --text "<its first words>" [--candidates "Family:weight,..."] and use the USE line.`);
		} else if (leadType.comp && leadType.chosen && !choiceStamped(lead.id, leadType.chosen)) {
			reasons.push(`the lead text region ${lead.id} carries a "chosen" face that font-match did not write (${leadType.chosen.family ?? "?"}). A face typed into spec.json is the guess this gate exists to refuse; run font-match --rank ${lead.id} --text "<its first words>" and let it record the choice (with no browser it records the catalog's nearest face).`);
		}

		const unmeasured = textRegions.slice(1).filter((r) => !typedRegion(r).type).map((r) => r.id);
		if (unmeasured.length > 0 && reasons.length === 0) {
			reasons.push(`measure the other text regions too, each sets its own font-size and weight class: font-match --measure <id> for ${unmeasured.join(", ")}`);
		}
	}

	if (reasons.length > 0) return { ok: false, reasons };
	return { ok: true, reasons: [], summary: `${spec.regions.length} regions, ${plates} plates, ${textRegions.length} text regions measured` };
}

/** A spec region with the type block font-match writes onto it. */
type TypedRegion = SpecRegion & {
	readonly type?: {
		readonly comp?: { readonly capHeightPx: number };
		readonly widthClass?: string;
		readonly weightClass?: string;
		readonly chosen?: { readonly family: string; readonly weight: number | string; readonly fontSizePx: number | string; readonly source: string };
	};
};

function typedRegion(region: SpecRegion): TypedRegion {
	return region as TypedRegion;
}

/**
 * The one plate rule, shared by the plates gate and the image generator so they never disagree.
 *
 * `score` is a whole-image comparison against the masked comp crop under cover alignment.
 */
function plateVerdict(region: SpecRegion, score: PairScore): { ok: boolean; reasons: string[]; effective: number } {
	const isTexture = region.kind === "texture";
	const reasons: string[] = [];

	if (isTexture) {
		const effective = 0.5 * score.color + 0.5 * Math.min(1, score.detail / 0.6);
		if (effective < PLATE_MIN) {
			reasons.push(
				`scores ${(effective * 100).toFixed(0)}% as the material of region ${region.id} (color ${(score.color * 100).toFixed(0)}%, detail ${(score.detail * 100).toFixed(0)}%); crop a clean patch of the comp region (comp-spec --crop ${region.id} --raw) and mirror-tile it, generate only when no clean patch exists`,
			);
		}
		return { ok: reasons.length === 0, reasons, effective };
	}

	// Added detail is invented material only when the comp region is calm; a paper sleeve is grainy in
	// the comp too, and its plate is allowed the same grain. The comp's energy travels on the region.
	const compCalm = !region.detail || region.detail.energy < 12;
	if (compCalm && score.detailAdded > 0.45) {
		reasons.push(`carries detail the comp region ${region.id} does not have (added-detail ${(score.detailAdded * 100).toFixed(0)}% of cells): noise, grain, or a busier subject where the comp is calm; regenerate from the crop reference without adding texture`);
	}
	if (score.structure < PLATE_STRUCTURE_MIN) {
		reasons.push(`structure ${(score.structure * 100).toFixed(0)}% against the comp region ${region.id}: the composition of the plate is not the region's (different subject, orientation, or crop); regenerate with comp-spec --crop ${region.id} as the reference image`);
	}
	if (score.overall < PLATE_MIN) {
		reasons.push(
			`scores ${(score.overall * 100).toFixed(0)}% against the comp region ${region.id} (structure ${(score.structure * 100).toFixed(0)}%, color ${(score.color * 100).toFixed(0)}%, detail ${(score.detail * 100).toFixed(0)}%); regenerate with the crop as --ref and the comp-spec plate prompt`,
		);
	}
	return { ok: reasons.length === 0, reasons, effective: score.overall };
}

/** Every plate exists, decodes, is big enough, and reads as its region. */
function gatePlates(state: BuildState, { specPath = SPEC_PATH }: { readonly specPath?: string } = {}): GateResult {
	const spec = loadSpec(specPath);
	if (!spec) return { ok: false, reasons: ["no spec"] };

	const rasterRegions = spec.regions.filter((r) => r.medium === "raster");
	if (rasterRegions.length === 0) return { ok: true, reasons: [], summary: "no plates owed", plates: [] };

	let comp: ReturnType<typeof loadRaster>["image"] | null = null;
	try {
		comp = loadRaster(spec.comp).image;
	} catch {
		// Scored without the comp crop below.
	}

	const reasons: string[] = [];
	const plates: NonNullable<GateResult["plates"]> = [];

	for (const r of rasterRegions) {
		const file = r.plate;
		if (!file || !fs.existsSync(file)) {
			reasons.push(`plate missing for ${r.id}: expected ${file || "(no path)"}; produce it from comp-spec --crop ${r.id} with generate-image --plate`);
			plates.push({ id: r.id, file, status: "missing" });
			continue;
		}

		let img: ReturnType<typeof loadRaster>["image"] & { text?: Record<string, string> };
		try {
			img = loadRaster(file).image as ReturnType<typeof loadRaster>["image"] & { text?: Record<string, string> };
		} catch (error) {
			reasons.push(`plate ${file} is not a decodable PNG: ${(error as Error).message}`);
			plates.push({ id: r.id, file, status: "unreadable" });
			continue;
		}

		// A texture tiles, so it owes no size floor and no structural match: it is judged on palette and
		// grain only. Every other plate must be at least 1.5× the region, capped at 1536px, the largest
		// size the generators emit.
		const isTexture = r.kind === "texture";
		const minW = Math.min(1536, r.px.w * 1.5);
		if (!isTexture && img.width < minW) reasons.push(`plate ${file} is ${img.width}px wide; the comp region is ${r.px.w}px and a shipping plate needs at least ${Math.round(minW)}px. Regenerate at asset size, do not crop the comp.`);

		let score: PairScore | null = null;
		if (comp) {
			const ref = plateReference(comp, spec, r);

			// A keyed plate ships over the page ground, so it is scored composited over the region's
			// sampled ground, the way it will show.
			// A keyed plate ships over the page ground, so it is scored composited over the region's sampled
			// ground, the way it will show.
			let build: ReturnType<typeof loadRaster>["image"] = img;
			let transparent = 0;
			for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 128) transparent++;
			if (transparent > (img.data.length / 4) * 0.05) {
				const g = r.palette?.[0]?.hex || "#ffffff";
				const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(g);
				const ground: [number, number, number, number] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255] : [255, 255, 255, 255];
				const over = createImage(img.width, img.height, ground);
				blit(over, img, 0, 0);
				build = over as ReturnType<typeof loadRaster>["image"];
			}

			const res = compare({ comp: ref, build, align: "cover", spec: null, kind: r.kind });
			score = res.whole;
			for (const reason of plateVerdict(r, score).reasons) reasons.push(`plate ${file}: ${reason}`);

			// A plate that matches the comp crop almost exactly is the comp crop, upscaled past the size
			// floor: the comp's grain, its neighbours' edges and its resolution ship as the artwork. Crops
			// are never plates. A fake-mode plate is the crop by design and says so in its tEXt.
			const isFake = (img as unknown as { text?: Record<string, string> }).text?.["impeccable:fake"] === "1";
			if (!isTexture && !isFake) {
				const raw = crop(comp, r.px.x, r.px.y, r.px.w, r.px.h);
				const same = structureScore(raw, resize(img, raw.width, raw.height));
				if (same >= 0.95) {
					reasons.push(`plate ${file} is the comp crop of region ${r.id} (structure ${(same * 100).toFixed(0)}% against the raw region, a resample of the same pixels): a crop of the comp is never a plate; generate the plate from the crop as reference (generate-image --plate ${r.id})`);
				}
			}
		}

		plates.push({ id: r.id, file, status: "ok", size: `${img.width}x${img.height}`, score: score ? score.overall : null });
	}

	return { ok: reasons.length === 0, reasons, summary: `${plates.filter((p) => p.status === "ok").length}/${rasterRegions.length} plates`, plates };
}

/** Source files that could reference a plate: a bounded walk, skipping deps and build output. */
function sourceFiles(root = ".", limit = 400): string[] {
	const out: string[] = [];
	// `assets` is walked: the extension filter keeps binaries out, and a stylesheet there may be the one
	// file that references a plate.
	const skip = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".svelte-kit", ".impeccable", "coverage"]);
	const exts = /\.(html?|css|scss|jsx?|tsx?|svelte|vue|astro|mdx?|php|erb|hbs)$/i;

	const walk = (dir: string, depth: number) => {
		if (out.length >= limit || depth > 6) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= limit) return;
			if (e.isDirectory()) {
				if (!skip.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
			} else if (exts.test(e.name)) {
				out.push(path.join(dir, e.name));
			}
		}
	};

	walk(root, 0);
	return out;
}

/**
 * Plates the artifact never references.
 *
 * The artifact narrows nothing: a plate may be referenced only from a stylesheet the artifact links,
 * so the source walk runs either way and the linked stylesheets are added by name.
 */
function unreferencedPlates(spec: CompSpec | null, artifact: string | null = null, { cwd = process.cwd(), root = ".", limit = 400 }: { readonly cwd?: string; readonly root?: string; readonly limit?: number } = {}): SpecRegion[] {
	const plates = (spec?.regions ?? []).filter((r) => r.medium === "raster" && r.plate);
	if (plates.length === 0) return [];

	const linked: string[] = [];
	if (artifact && fs.existsSync(artifact)) {
		linked.push(artifact);
		try {
			const html = fs.readFileSync(artifact, "utf8");
			for (const m of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
				const href = m[1];
				if (/^(https?:|data:|\/\/)/i.test(href)) continue;
				if (!/rel=["']?stylesheet/i.test(m[0]) && !/\.css(\?|$)/i.test(href)) continue;
				const clean = href.split("?")[0];
				// A root-relative href serves from the project root, not the drive root.
				if (clean.startsWith("/")) linked.push(path.join(cwd, clean), path.join(path.dirname(artifact), clean));
				else linked.push(path.resolve(path.dirname(artifact), clean));
			}
		} catch {
			// The artifact still counts.
		}
	}

	const files = [...new Set([...linked, ...sourceFiles(root, limit)])];
	let corpus = "";
	for (const f of files) {
		try {
			corpus += `${fs.readFileSync(f, "utf8")}\n`;
		} catch {
			// Skip unreadable candidates.
		}
	}

	const missing: SpecRegion[] = [];
	for (const r of plates) {
		const base = path.basename(r.plate as string);
		const stem = base.replace(/\.[a-z0-9]+$/i, "");
		// An inline data URI counts when the region id or file stem is named beside it.
		if (corpus.includes(base) || (corpus.includes("data:image/") && (corpus.includes(stem) || corpus.includes(r.id)))) continue;
		missing.push(r);
	}
	return missing;
}

/**
 * Organic clip-path findings whose selector's element the artifact places on a raster region.
 *
 * A cheap heuristic: the finding's selector mentions the region id or its plate stem, or there is
 * only one raster region to blame.
 */
function organicClipRegions(artifactFile: string, spec: CompSpec): Array<{ id: string; snippet: string }> {
	let html = "";
	try {
		html = fs.readFileSync(artifactFile, "utf8");
	} catch {
		return [];
	}

	const findings = scanCssTextForOrganicClipPath(html) as Array<{ selector?: string; snippet?: string }>;
	if (findings.length === 0) return [];

	const rasterRegions = spec.regions.filter((r) => r.medium === "raster");
	const out: Array<{ id: string; snippet: string }> = [];
	for (const f of findings) {
		const selector = String(f.selector || "").toLowerCase();
		for (const r of rasterRegions) {
			const stem = path.basename(r.plate || "", path.extname(r.plate || "")).toLowerCase();
			if ((selector && (selector.includes(r.id.toLowerCase()) || (stem && selector.includes(stem)))) || rasterRegions.length === 1) {
				out.push({ id: r.id, snippet: f.snippet ?? "" });
				break;
			}
		}
	}
	return out;
}

/**
 * The scaffold: the measured layout as CSS custom properties and one reference page.
 *
 * Positions are percentages of the comp so the frame scales. Plates go at their boxes with
 * `object-fit: contain` — never cover, which is how an arch lost its left side — and text slots are
 * sized from the measured cap height in the ranked face.
 */
function writeScaffold(spec: CompSpec, state: BuildState, { dir = path.join(BUILD_DIR, "scaffold") }: { readonly dir?: string } = {}): { dir: string; css: string; html: string } {
	fs.mkdirSync(dir, { recursive: true });
	const W = spec.compSize.width;
	const H = spec.compSize.height;
	const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

	const vars: string[] = [":root {"];
	const rules: string[] = [];
	const bodyParts: string[] = [];
	const fontLinks = new Set<string>();

	for (const region of spec.regions) {
		if (region.kind === "band") continue;
		const r = typedRegion(region);
		const b = r.box;
		const id = r.id;
		vars.push(`  --r-${id}-x: ${pct(b.x)}; --r-${id}-y: ${pct(b.y)}; --r-${id}-w: ${pct(b.w)}; --r-${id}-h: ${pct(b.h)};`);

		const type = r.type ?? {};
		const cap = type.comp?.capHeightPx;
		const chosen = type.chosen ?? null;
		const fontPx = chosen?.fontSizePx ? chosen.fontSizePx : cap ? Math.round(cap / 0.7) : null;
		if (cap) vars.push(`  --r-${id}-cap: ${cap}px;${fontPx ? ` --r-${id}-font: ${fontPx}px;` : ""}${chosen ? ` --r-${id}-family: '${chosen.family}'; --r-${id}-weight: ${chosen.weight};` : ""}`);
		if (chosen?.family) fontLinks.add(`${chosen.family}:${chosen.weight}`);

		rules.push(`.r-${id} { position: absolute; left: var(--r-${id}-x); top: var(--r-${id}-y); width: var(--r-${id}-w); height: var(--r-${id}-h); }`);
		const label = (r.note || id).replace(/</g, "&lt;");

		if (r.medium === "raster" && r.kind !== "texture") {
			const src = r.plate ? path.relative(dir, r.plate) : "";
			bodyParts.push(`  <figure class="r-${id} region plate" data-region="${id}"><img src="${src}" alt="" style="width:100%;height:100%;object-fit:contain;object-position:${r.kind === "image" ? "center" : "top left"}"></figure>`);
		} else if (r.kind === "texture") {
			const src = r.plate ? path.relative(dir, r.plate) : "";
			bodyParts.push(`  <div class="r-${id} region texture" data-region="${id}" style="background-image:url('${src}');background-repeat:repeat"></div>`);
		} else if (r.kind === "text") {
			const style = [fontPx ? `font-size:var(--r-${id}-font)` : "", chosen ? `font-family:var(--r-${id}-family),sans-serif;font-weight:var(--r-${id}-weight)` : "", "line-height:1.05", "margin:0"].filter(Boolean).join(";");
			// The slot shows the region's own words when the spec has them, else its id, at the measured
			// size. The note goes in a comment: it is a slot, not a caption.
			bodyParts.push(`  <div class="r-${id} region text" data-region="${id}"><!-- ${label} --><p style="${style}">${(r.text || "").replace(/</g, "&lt;") || id}</p></div>`);
		} else if (r.kind === "control") {
			bodyParts.push(`  <div class="r-${id} region control" data-region="${id}"><!-- ${label}: rebuild the control's chrome from the crop (comp-spec --crop ${id}); its ink box, border, fill, radius, and label size are the comp's --></div>`);
		} else {
			bodyParts.push(`  <div class="r-${id} region chrome" data-region="${id}"><!-- ${label} --></div>`);
		}
	}
	vars.push("}");

	const css = [
		"/* Impeccable scaffold: the measured layout of the approved comp as custom properties. Generated by build-phase scaffold; regenerate after comp-spec --regions changes. Bind these to your own markup; positions are % of the comp frame so they scale with it. */",
		...vars,
		"",
		`.comp-frame { position: relative; width: 100%; aspect-ratio: ${W} / ${H}; overflow: hidden; }`,
		...rules,
		"",
	].join("\n");

	const cssPath = path.join(dir, "layout.css");
	fs.writeFileSync(cssPath, css);

	const link = fontLinks.size
		? `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${[...fontLinks]
				.map((f) => {
					const [family, weight] = f.split(":");
					return `family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}`;
				})
				.join("&")}&display=swap">\n`
		: "";

	const html = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Scaffold reference: ${path.basename(spec.comp)}</title>\n${link}  <link rel="stylesheet" href="layout.css">\n  <style>html,body{margin:0}body{background:${spec.palette?.[0]?.hex || "#fff"}}.region{box-sizing:border-box}.region.text p{white-space:pre-wrap}</style>\n</head>\n<body>\n<!-- Reference only. Every region sits at its measured box inside a comp-aspect frame. Take the boxes (layout.css), keep your own semantic structure. -->\n<main class="comp-frame" style="max-width:${W}px">\n${bodyParts.join("\n")}\n</main>\n</body>\n</html>\n`;

	const htmlPath = path.join(dir, "hero-reference.html");
	fs.writeFileSync(htmlPath, html);
	return { dir, css: cssPath, html: htmlPath };
}

/** Readings for the hero: text, chrome and invented-ink findings. */
function heroReadings(state: BuildState, spec: CompSpec | null, buildPath: string): { text: string[]; chrome: string[]; plates: string[]; invented: ReturnType<typeof inventedInk> } | null {
	if (!spec || !state.comp) return null;

	const comp = loadRaster(state.comp).image;
	const build = loadRaster(buildPath).image;

	let aligned = alignBuild(comp, build, "top");
	const shift = bestShift(comp, aligned);
	if (shift.dx || shift.dy) {
		const shifted = createImage(aligned.width, aligned.height, [255, 255, 255, 255]);
		blit(shifted, aligned, -shift.dx, -shift.dy);
		aligned = shifted;
	}

	const text: string[] = [];
	const chrome: string[] = [];
	const plates: string[] = [];

	for (const region of spec.regions) {
		const r = typedRegion(region);
		if (!r.px) continue;
		const a = crop(comp, r.px.x, r.px.y, r.px.w, r.px.h);
		const b = crop(aligned, r.px.x, r.px.y, r.px.w, r.px.h);

		if (r.kind === "text") {
			text.push(...(textRegionCheck(r, a, b).findings ?? []));
		} else if (r.kind === "chrome" || r.kind === "control") {
			chrome.push(...(chromeStripCheck(r, a, b).findings ?? []));
		} else if (r.kind === "plate" || r.kind === "image") {
			const c = plateClipCheck(r, a, b);
			const sides = c.sides ?? [];
			if (sides.length > 0) {
				const compBox = c.comp as { w: number; h: number; x: number; y: number };
				const buildBox = c.build as { w: number; h: number; x: number; y: number };
				plates.push(
					`plate ${r.id} is clipped at the ${sides.join(" and ")}: the comp's artwork keeps a margin there (ink box ${compBox.w}x${compBox.h} at ${compBox.x},${compBox.y} in the region) and the build's runs to the edge (${buildBox.w}x${buildBox.h} at ${buildBox.x},${buildBox.y}); size the box to the artwork's aspect and use object-fit: contain, or place the <img> at the artwork's own size, never cover on a narrower box`,
				);
			}
		}
	}

	return { text, chrome, plates, invented: inventedInk(comp, aligned) };
}

/** The comp comparison a gate needs, as a value the host provides. */
interface DiffIo {
	/** A whole comparison, as `compare()` returns it. */
	readonly compare: (options: { comp: ReturnType<typeof loadRaster>["image"]; build: ReturnType<typeof loadRaster>["image"]; spec?: unknown; align?: string; label?: string; kind?: string | null }) => CompareResult;
	/** Persist the comparison's artifacts; returns whether the report can be read back. */
	readonly persist?: (result: CompareResult, comp: ReturnType<typeof loadRaster>["image"], outDir: string) => void;
}

const defaultIo: DiffIo = { compare: (options) => compare(options as Parameters<typeof compare>[0]) };

/**
 * The hero gate: the first viewport must be the comp's frame, above the fidelity bar, with no region
 * missing, contradicted, clipped or invented.
 *
 * Above the bar the numeric readings advise instead of block, because builds at 68–73% with colour
 * and spacing nits were passes, while a 90% build sat open behind three ink colours. Hard vetoes stay
 * unconditional: a missing region, a contradicted plate or text block, an SVG illustration, a clipped
 * plate, or invented ink is the wrong page at any score.
 */
function gateHero(
	state: BuildState,
	{
		buildPath = HERO_REPRO,
		specPath = SPEC_PATH,
		min = HERO_MIN,
		outDir = path.join(".impeccable", "review", "diff", "hero"),
		artifact = null,
		io = defaultIo,
		cwd = process.cwd(),
	}: { readonly buildPath?: string; readonly specPath?: string; readonly min?: number; readonly outDir?: string; readonly artifact?: string | null; readonly io?: DiffIo; readonly cwd?: string } = {},
): GateResult {
	if (!fs.existsSync(buildPath)) {
		return { ok: false, reasons: [`no hero capture at ${buildPath}: screenshot the first viewport at the comp's own dimensions (${state.breakpoint || "comp size"}) into that path`] };
	}

	const specForRefs = loadSpec(specPath);

	// Resolve the page first: with an artifact in hand the plate scan follows its linked stylesheets.
	let pageFile = artifact || state.artifact || null;
	if (!pageFile || !fs.existsSync(pageFile)) {
		if (fs.existsSync(path.join(cwd, "index.html"))) pageFile = path.join(cwd, "index.html");
		else {
			try {
				const htmls = fs.readdirSync(cwd).filter((f) => /\.html?$/i.test(f));
				if (htmls.length === 1) pageFile = path.join(cwd, htmls[0]);
			} catch {
				// Fall back to the walk.
			}
		}
	}

	const unreferenced = unreferencedPlates(specForRefs, pageFile && fs.existsSync(pageFile) ? pageFile : null, { cwd });
	if (unreferenced.length > 0) {
		return {
			ok: false,
			reasons: unreferenced.map(
				(r) =>
					`plate ${r.plate} (region ${r.id}) is not referenced by any source file this scan can see: the page draws that region in code while the produced plate sits unused. Place the plate (an <img>, a background-image, or an inlined data URI named for it) and recapture. If the plate IS referenced from a file the scan missed (your page is not index.html, or the reference lives in a stylesheet outside the project walk), re-run with --artifact <your page>: its linked stylesheets are followed exactly.`,
			),
		};
	}

	const comp = loadRaster(state.comp as string).image;
	const build = loadRaster(buildPath).image;
	const spec = specForRefs;
	const report = io.compare({ comp, build, spec, align: "top", label: "hero" }) as CompareResult & {
		compSize?: string;
		buildSize?: string;
		palette?: { comp: Array<{ hex: string }>; build: Array<{ hex: string }> };
	};
	if (io.persist) io.persist(report, comp, outDir);

	const reasons: string[] = [];
	const advisories: string[] = [];

	// The capture must be the comp's own frame: a 1440-wide capture of a 1536×1024 comp is a different
	// composition before anything is compared.
	const [cw, ch] = [comp.width, comp.height];
	const [bw, bh] = [build.width, build.height];
	if (cw && ch && bw && bh) {
		const compAspect = cw / ch;
		const buildAspect = bw / bh;
		if (bw < cw * 0.9 || Math.abs(buildAspect - compAspect) / compAspect > 0.08) {
			reasons.push(`hero capture is ${bw}x${bh}; the comp is ${cw}x${ch}. Capture the first viewport at the comp's own dimensions (viewport ${cw}x${ch}, not full page) into ${buildPath}.`);
		}
	}

	const aboveBar = report.whole.overall >= min;
	if (!aboveBar) {
		reasons.push(`hero overall ${(report.whole.overall * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}% (structure ${(report.whole.structure * 100).toFixed(0)}%, color ${(report.whole.color * 100).toFixed(0)}%, detail ${(report.whole.detail * 100).toFixed(0)}%)`);
	}
	if (report.whole.colorIntersection != null && report.whole.colorIntersection < 0.2) {
		reasons.push(
			`the palette is not the comp's (color intersection ${(report.whole.colorIntersection * 100).toFixed(0)}%): comp ${(report.compPalette || []).slice(0, 3).map((c) => c.hex).join(" ")} vs build ${(report.buildPalette || []).slice(0, 3).map((c) => c.hex).join(" ")}. Use the spec's sampled palette values, not a rendition of them.`,
		);
	}

	// A texture band sharing its box with a text or control region carries that region's ink in the
	// comp crop; when the overlapping ink regions are present, a low detail score on the texture is the
	// ink metric measuring the wrong thing, not missing material.
	const specRegions = spec ? spec.regions : [];
	const overlaps = (a: SpecRegion, b: SpecRegion) => a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w && a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h;
	// The report's regions are mutable here on purpose: the texture-overlap and placed-plate rules
	// reclassify a finding rather than dropping it, so what a session reads matches what was measured.
	type MutableRegion = (typeof report.regions)[number] & { verdict: string };
	const verdictOf: Record<string, string> = Object.fromEntries(report.regions.map((r) => [r.id, r.verdict]));

	const missing = report.regions.filter((region) => {
		const r = region as MutableRegion;
		if (r.verdict !== "missing") return false;
		if (r.kind !== "texture") return true;
		const me = specRegions.find((x) => x.id === r.id);
		if (!me) return true;
		const inkOver = specRegions.filter((x) => x.id !== r.id && (x.kind === "text" || x.kind === "control" || x.kind === "chrome") && overlaps(me, x));
		const inkPresent = inkOver.length > 0 && inkOver.every((x) => verdictOf[x.id] && verdictOf[x.id] !== "missing");
		if (inkPresent) {
			r.verdict = "drift";
			return false;
		}
		return true;
	});

	// A plate that passed the plates gate and is referenced by the page is placed material, not missing
	// material: comparing at the region box re-litigates the plate's content, and no CSS edit can move
	// that score. What the hero owes for a passed plate is its placement.
	const passedPlate = (id: string) => state.plates?.[id]?.status === "ok" && (state.plates[id].score == null || (state.plates[id].score as number) >= PLATE_MIN);
	const placementNotes: string[] = [];

	for (const region of report.regions) {
		const r = region as MutableRegion;
		if (!(r.kind === "plate" || r.kind === "image" || r.kind === "texture") || !passedPlate(r.id)) continue;
		if (r.verdict !== "missing" && r.verdict !== "contradicted") continue;

		// A texture's presence is its ground: palette and structure held means the material is there. A
		// plate or image needs its own energy in the box.
		const present = r.kind === "texture" ? r.score.structure >= 0.85 && r.score.color >= 0.6 : r.score.detailRaw != null ? r.score.detailRaw >= 0.3 : r.score.detail >= 0.3;
		if (!present) continue;

		r.verdict = "drift";
		if (r.inkBox?.comp && r.inkBox.build) {
			const c = r.inkBox.comp;
			const b = r.inkBox.build;
			const off = Math.abs(b.w - c.w) > c.w * 0.2 || Math.abs(b.h - c.h) > c.h * 0.2 || Math.abs(b.x - c.x) > c.w * 0.15 || Math.abs(b.y - c.y) > c.h * 0.15;
			if (off) {
				placementNotes.push(
					`plate ${r.id} is placed but not at the comp's box: its ink spans ${c.w}x${c.h}px at (${c.x},${c.y}) in the comp region and ${b.w}x${b.h}px at (${b.x},${b.y}) in the build; size and position the <img> to the spec box (object-fit: cover), not to the surrounding layout`,
				);
			}
		}
	}

	const missingAfter = missing.filter((r) => r.verdict === "missing");
	for (const r of missingAfter) {
		reasons.push(`region ${r.id} is missing (detail ${(r.score.detail * 100).toFixed(0)}%, structure ${(r.score.structure * 100).toFixed(0)}%): the comp shows material the build does not`);
	}
	for (const n of placementNotes) (aboveBar ? advisories : reasons).push(aboveBar ? `(advisory, above the ${(min * 100).toFixed(0)}% bar) ${n}` : n);

	const contradicted = report.regions.filter((r) => r.verdict === "contradicted");
	// A contradicted plate, image, text or control is the wrong page whatever the mean says; chrome gets
	// the one-third allowance below.
	const directionContradicted = contradicted.filter((r) => r.kind === "plate" || r.kind === "image" || r.kind === "text" || r.kind === "control");
	for (const r of directionContradicted) {
		reasons.push(
			`region ${r.id} (${r.kind}) is contradicted (structure ${(r.score.structure * 100).toFixed(0)}%, detail added ${(r.score.detailAdded * 100).toFixed(0)}%): ${r.kind === "text" ? "the composition of this text region differs from the comp; re-derive it from the spec box" : r.kind === "control" ? "this control does not read as the comp's: rebuild its chrome from the crop (border, fill, radius, chevron or arrow, label size) rather than from a component default" : `the plate here does not read as the comp region; regenerate it with the crop as reference (generate-image --plate ${r.id}) and place it at its box`}`,
		);
	}

	// A control that drifts far is a different control too.
	for (const r of report.regions) {
		if (r.kind !== "control" || r.verdict !== "drift" || r.score.overall >= 0.65) continue;
		reasons.push(`control ${r.id} drifts to ${(r.score.overall * 100).toFixed(0)}% (structure ${(r.score.structure * 100).toFixed(0)}%, color ${(r.score.color * 100).toFixed(0)}%): its chrome differs from the comp's; open ${path.join(outDir, "regions", `${r.id}.png`)} and match the border, fill, radius, chevron or arrow, and label size`);
	}

	// Controls: the ink box in comp vs build, so a button in a 63px row built into a 41px row is named as
	// numbers rather than as a drift score.
	for (const r of report.regions) {
		if (r.kind !== "control") continue;
		if (!(r.inkBox?.comp && r.inkBox.build)) continue;

		// Only when the comp's ink is a discrete element inside its region, not when it fills the region
		// edge to edge: then the box says nothing.
		const rwN = (r as { w?: number }).w ?? 1;
		const rhN = (r as { h?: number }).h ?? 1;
		const rw = rwN * comp.width;
		const rh = rhN * comp.height;
		if (r.inkBox.comp.w >= rw * 0.85 || r.inkBox.comp.h >= rh * 0.85) continue;

		const dh = r.inkBox.build.h - r.inkBox.comp.h;
		const dw = r.inkBox.build.w - r.inkBox.comp.w;
		// The build's box is only comparable when it is discrete too.
		if (r.inkBox.build.w >= rw * 0.98 || r.inkBox.build.h >= rh * 0.98) continue;
		if (Math.abs(dh) > Math.max(6, r.inkBox.comp.h * 0.15) || Math.abs(dw) > Math.max(12, r.inkBox.comp.w * 0.15)) {
			(aboveBar ? advisories : reasons).push(
				`${aboveBar ? `(advisory, above the ${(min * 100).toFixed(0)}% bar) ` : ""}region ${r.id}: its ink sits in a ${r.inkBox.comp.w}x${r.inkBox.comp.h}px box in the comp and ${r.inkBox.build.w}x${r.inkBox.build.h}px in the build (padding, row height, or size); match the box, not only the position`,
			);
		}
	}

	const otherContradicted = contradicted.filter((r) => !directionContradicted.includes(r));
	if (otherContradicted.length > Math.max(1, Math.floor(report.regions.length / 3))) {
		reasons.push(`${otherContradicted.length} of ${report.regions.length} regions contradicted: ${otherContradicted.map((r) => r.id).join(", ")}`);
	}

	// A CSS-drawn organic contour on a raster region's box is the plate replaced by code, whatever the
	// pixels score. Inline SVG past an icon's budget is a drawing in code.
	const artifactFile = pageFile;
	if (artifactFile && fs.existsSync(artifactFile) && spec) {
		for (const r of organicClipRegions(artifactFile, spec)) {
			reasons.push(`artifact draws an organic clip-path (${r.snippet}) inside raster region ${r.id}'s box; that region ships as its plate, never as a polygon`);
		}

		let svgs: ReturnType<typeof svgIllustrations> = [];
		try {
			svgs = svgIllustrations(fs.readFileSync(artifactFile, "utf8"));
		} catch {
			svgs = [];
		}
		for (const v of svgs.slice(0, 6)) {
			reasons.push(`artifact draws an illustration in inline SVG${v.label ? ` (${v.label})` : ""}: ${v.snippet}. Drawings, diagrams, notation, and leader lines are plates or belong to the plate they annotate; only icon-sized SVG (under 64px, a few paths) is code`);
		}
		if (svgs.length > 6) reasons.push(`...and ${svgs.length - 6} more inline SVG illustrations`);
	}

	// The numbers a designer reads off the side-by-side: type at the wrong size, weight, colour or place;
	// a nav bar too tall; ink where the comp has none.
	let readings: ReturnType<typeof heroReadings> = null;
	try {
		readings = heroReadings(state, spec, buildPath);
	} catch (error) {
		reasons.push(`hero readings errored (${(error as Error).message}); the region scores above stand`);
	}

	if (readings) {
		// The numbers are the edit list: worst first — size, then lines, then colour and place — and short
		// enough to act on in one pass.
		const order = (f: string) => (/cap height/.test(f) ? 0 : /lines? in the build/.test(f) ? 1 : /heavier|lighter/.test(f) ? 2 : /ink is/.test(f) ? 3 : 4);

		// Sibling regions with the same kind of finding are one edit: fold them into one line naming them.
		const folded = new Map<string, { first: string; ids: string[] }>();
		for (const f of readings.text) {
			const m = /^text ([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-(?:\d+|[a-z]))?: (cap height|\d+ lines? in the build|the face renders|ink is|its first line|it starts|line pitch)/i.exec(f);
			const key = m ? `${m[1]}|${m[2].replace(/\d+/g, "N")}` : f;
			if (!folded.has(key)) folded.set(key, { first: f, ids: [] });
			const idm = /^text ([^:]+):/.exec(f);
			if (idm) folded.get(key)?.ids.push(idm[1]);
		}
		const text = [...folded.values()].map((v) => (v.ids.length > 1 ? `${v.first} (also ${v.ids.slice(1).join(", ")})` : v.first)).sort((a, b) => order(a) - order(b));

		// A reading unchanged three attempts running is one the session is not acting on, or cannot. It
		// stays in the message as advisory and stops blocking; the fresh readings still do.
		const seen = state.phases.hero.readingsSeen ?? (state.phases.hero.readingsSeen = {});
		const stale = (f: string) => {
			const k = f.replace(/\s+/g, " ").trim();
			seen[k] = (seen[k] ?? 0) + 1;
			return seen[k] > 3;
		};
		const all = [...text, ...readings.chrome];
		const fresh = all.filter((f) => !stale(f));
		const staleOnes = all.filter((f) => !fresh.includes(f));
		const kept = fresh.slice(0, 8);

		if (aboveBar) {
			if (kept.length > 0) advisories.push(`(advisory, above the ${(min * 100).toFixed(0)}% bar; fix in the polish pass before responsive) ${kept.length} reading${kept.length === 1 ? "" : "s"}:`);
			for (const f of kept) advisories.push(`  ${f}`);
		} else {
			if (kept.length > 0) reasons.push(`READINGS, each one CSS edit (${fresh.length > kept.length ? `${kept.length} of ${fresh.length}, the rest after these` : `${kept.length}`}):`);
			for (const f of kept) reasons.push(f);
		}

		if (staleOnes.length > 0) advisories.push(...staleOnes.map((f) => `(advisory, unchanged for 3+ attempts) ${f}`));

		for (const f of readings.plates) reasons.push(f);

		// Invented ink: enough cells, or a couple of strongly inked ones (a legend, a badge, a second
		// control in a calm corner).
		const strongCells = readings.invented.cells.filter((c) => c.build >= 22);
		if (readings.invented.fraction >= INVENTED_MIN || strongCells.length >= 2) {
			const cells = readings.invented.cells.map((c) => c.label);
			reasons.push(
				`the build carries ink in ${cells.length} grid cells where the comp is calm (${cells.slice(0, 12).join(", ")}${cells.length > 12 ? ", ..." : ""}); nothing exists on the page that the comp does not show (a kicker, an extra nav item, a divider, a second row of controls); remove it or name it in a stated decision after the hero passes`,
			);
		}
	}

	const worstRegions = [...report.regions].sort((a, b) => a.score.overall - b.score.overall).slice(0, 3);
	const regionDir = path.join(outDir, "regions");

	return {
		ok: reasons.length === 0,
		reasons,
		summary: `hero ${(report.whole.overall * 100).toFixed(0)}% (${verdictFor(report.whole)})`,
		score: report.whole.overall,
		verdict: verdictFor(report.whole),
		report: path.join(outDir, "report.json"),
		sideBySide: path.join(outDir, "side-by-side.png"),
		worst: worstRegions.map((r) => `${r.id} ${r.verdict} ${(r.score.overall * 100).toFixed(0)}%`),
		worstIds: worstRegions.map((r) => r.id),
		worstCrops: worstRegions.map((r) => ({ id: r.id, verdict: r.verdict, score: r.score, file: path.join(regionDir, `${r.id}.png`) })),
		advisories,
		regionVerdicts: Object.fromEntries(report.regions.map((r) => [r.id, r.verdict])),
	};
}

/**
 * The hero attempt loop: after three attempts where the same region is still the worst and the score
 * moved less than three points, value edits are not reaching it, and the next step is to rebuild it.
 */
function heroLoopVerdict(state: BuildState, gate: GateResult, artifactPath: string): string | null {
	const p = state.phases.hero;
	const history = p.history ?? [];
	history.push({ at: now(), score: gate.score ?? null, worstIds: gate.worstIds ?? [], regionVerdicts: gate.regionVerdicts ?? {}, artifactHash: hashFile(artifactPath) });
	p.history = history.slice(-6);
	if (history.length < 3) return null;

	const last3 = history.slice(-3);
	const stuck = last3[0].worstIds[0] && last3.every((h) => h.worstIds[0] === last3[0].worstIds[0]);
	const scores = last3.map((h) => h.score ?? 0);
	const noProgress = Math.max(...scores) - Math.min(...scores) < 0.03;
	if (!(stuck && noProgress)) return null;

	return `region ${last3[0].worstIds[0]} has been the worst region for three attempts and the score moved less than 3 points: value edits are not reaching it. Open ${path.join(".impeccable", "review", "diff", "hero", "regions", `${last3[0].worstIds[0]}.png`)} and rebuild that region from the comp crop (place its plate, or produce one with generate-image --plate, or re-derive its structure from the spec box), then recapture.`;
}

function hashFile(file: string): string | null {
	try {
		return createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
	} catch {
		return null;
	}
}

/**
 * The responsive gate: the desktop capture, whatever common width the build used, must still read as
 * the comp. A first viewport that only holds at the comp's exact width and collapses to one column
 * 96px narrower passed every earlier gate once.
 */
function gateResponsive(
	state: BuildState,
	{
		specPath = SPEC_PATH,
		min = RESPONSIVE_MIN,
		outDir = path.join(".impeccable", "review", "diff", "desktop"),
		desktopPath = path.join(".impeccable", "review", "desktop.png"),
		mobilePath = path.join(".impeccable", "review", "mobile.png"),
		io = defaultIo,
	}: { readonly specPath?: string; readonly min?: number; readonly outDir?: string; readonly desktopPath?: string; readonly mobilePath?: string; readonly io?: DiffIo } = {},
): GateResult {
	const reasons: string[] = [];
	if (!fs.existsSync(desktopPath)) reasons.push(`no ${desktopPath}: capture the page at a common desktop width (1440 wide, full page) into that path`);
	if (!fs.existsSync(mobilePath)) reasons.push(`no ${mobilePath}: capture the page at 390 wide, full page, into that path`);
	if (reasons.length > 0) return { ok: false, reasons };

	const comp = loadRaster(state.comp as string).image;
	const desktop = loadRaster(desktopPath).image;
	const spec = loadSpec(specPath);
	const report = io.compare({ comp, build: desktop, spec, align: "top", label: "desktop" });
	if (io.persist) io.persist(report, comp, outDir);

	// A texture read at 1440 differs from itself at 1536 by resampling alone, and a plate that passed the
	// plates gate read "missing" on detail at 1440 in a run where the hero had just accepted it. Only a
	// region with no energy in its box is missing here.
	const missing = report.regions.filter((r) => {
		if (r.verdict !== "missing" || r.kind === "texture") return false;
		const passed = state.plates?.[r.id]?.status === "ok";
		if ((r.kind === "plate" || r.kind === "image") && passed) {
			const present = r.score.detailRaw != null ? r.score.detailRaw >= 0.3 : r.score.detail >= 0.3;
			if (present && r.score.structure >= 0.5) return false;
		}
		return true;
	});

	// A plate placed and passed at the hero is not re-litigated at 1440: the rescale alone drops SSIM on
	// a busy region. Text can still contradict, because a wrapped headline is a different composition.
	const contradictedText = report.regions.filter((r) => r.verdict === "contradicted" && r.kind === "text");

	if (report.whole.overall < min) {
		reasons.push(
			`the desktop capture scores ${(report.whole.overall * 100).toFixed(0)}% against the comp, under ${(min * 100).toFixed(0)}%: the first viewport does not survive a common desktop width. The hero passed at ${state.breakpoint || "the comp size"}; the layout must hold from ~1280 up, not only at the comp's exact width (grid columns in fr / minmax, not fixed px that overflow and wrap).`,
		);
	}
	for (const r of missing) reasons.push(`at desktop width, region ${r.id} is missing`);
	for (const r of contradictedText) reasons.push(`at desktop width, region ${r.id} (${r.kind}) is contradicted (structure ${(r.score.structure * 100).toFixed(0)}%)`);

	return { ok: reasons.length === 0, reasons, summary: `desktop ${(report.whole.overall * 100).toFixed(0)}% (${verdictFor(report.whole)})`, score: report.whole.overall, sideBySide: path.join(outDir, "side-by-side.png") };
}

/**
 * The transition table: every phase's gate, or `null` where there is none.
 *
 * Keyed by the phase union, so adding a phase is a compile error here until someone decides whether it
 * gets a gate. `null` says "no mechanical gate" out loud instead of leaving the phase unmentioned.
 */
type Gate = (state: BuildState, opts: Record<string, unknown>) => GateResult;

const GATES: Readonly<Record<Phase, Gate | null>> = {
	comps: (state, opts) => gateComps(state, opts as { mocksDir?: string }),
	spec: (state, opts) => gateSpec(state, opts as { specPath?: string }),
	plates: (state, opts) => gatePlates(state, opts as { specPath?: string }),
	hero: (state, opts) => gateHero(state, opts as Parameters<typeof gateHero>[1]),
	sections: null,
	motion: null,
	responsive: (state, opts) => gateResponsive(state, opts as Parameters<typeof gateResponsive>[1]),
	review: null,
};

/**
 * Per-phase behaviour that is not a gate, in one table instead of `if (phase === ...)` chains.
 *
 * Three points, in the order they run: `onGate` on the gate's answer whether or not it passed,
 * `beforeRefusal` once a forced refusal is not taking the run out, and `onClose` only when the phase
 * actually closes.
 */
interface PhaseHook {
	onGate?: (state: BuildState, gate: GateResult, opts: Record<string, unknown>) => void;
	beforeRefusal?: (state: BuildState, gate: GateResult, opts: Record<string, unknown>) => void;
	onClose?: (state: BuildState, gate: GateResult) => void;
}

const PHASE_HOOKS: Partial<Record<Phase, PhaseHook>> = {
	comps: {
		onClose: (state, gate) => {
			if (!gate.approved) return;
			state.comp = gate.approved;
			if (state.breakpoint) return;
			try {
				const image = loadRaster(gate.approved).image;
				state.breakpoint = `${image.width}x${image.height}`;
			} catch {
				// A non-PNG comp leaves the breakpoint unset.
			}
		},
	},
	plates: {
		onGate: (state, gate) => {
			// The plates gate's per-plate scores are what the hero reads to tell a placed plate from a
			// missing one, so they travel on the state even when the gate refused.
			if (!Array.isArray(gate.plates)) return;
			state.plates = Object.fromEntries(gate.plates.map((pl) => [pl.id, { status: pl.status, score: pl.score, size: pl.size }]));
		},
	},
	hero: {
		beforeRefusal: (state, gate, opts) => {
			if (gate.score == null) return;
			const stuck = heroLoopVerdict(state, gate, (opts.artifact as string) || state.artifact || "index.html");
			if (stuck && !gate.ok) gate.reasons = [stuck, ...(gate.reasons ?? [])];
		},
	},
};

/**
 * Run a phase's gate.
 *
 * A gate that throws is a bug in the gate, never a verdict on the build: it comes back as a refusal
 * that names itself, so a session sees one line and the state stays consistent instead of a stack
 * trace and a half-run.
 */
function runGate(state: BuildState, phase: Phase, opts: Record<string, unknown> = {}): GateResult {
	const gate = GATES[phase];
	if (!gate) return { ok: true, reasons: [], summary: "no mechanical gate" };
	try {
		return gate(state, opts);
	} catch (error) {
		return {
			ok: false,
			reasons: [
				`gate ${phase} errored (${(error as Error).message}); this is a tool bug, not a finding about the page. Re-run with the same inputs; if it repeats, note it and continue with build-phase advance --force --reason "user: gate ${phase} errored, proceeding" so the run is not lost.`,
			],
			error: String((error as Error)?.stack ?? error),
		};
	}
}

/**
 * Whether a reason may force past a gate.
 *
 * The user downgrading the comp's authority in words is the only one, and the reason has to quote
 * them. A reason that does not name the user is a model talking itself past its own gate.
 */
function forceAllowed(reason: unknown): boolean {
	if (typeof reason !== "string" || reason.trim().length < 20) return false;
	if (/gate \w+ errored/i.test(reason)) return true;

	const namesUser = /\buser\b|\bthey (said|asked|told|chose|picked)\b|\bpaul\b/i.test(reason);
	// The user must be downgrading the comp itself, not approving a translation the model proposed. A
	// reason that keeps the comp's topology while dropping "pixel-level" is a translation, and
	// translation is what the gate measures.
	const aboutComp = /\b(comp|mock|mockup|composition|fidelity|plate|region)\b/i.test(reason);
	const isTranslationDodge =
		/truthful|semantic|pixel-level|prioriti[sz]e (facts|semantics|accessibility)/i.test(reason) &&
		!/(drop|skip|remove|without|not needed|don't need|do not need|ignore) (the )?(comp|plate|region|fidelity)/i.test(reason);
	const downgrades =
		/\b(don't|do not|doesn't|does not|no longer|not) (need|have to|want|care|require|match|follow|hold)|\b(drop|skip|remove|ignore|waive|relax|override|approve|approved|accept|accepted|fine|okay|ok|good enough|ship it|move on|proceed|go ahead|instead of|rather than)\b/i.test(
			reason,
		);
	// The user's words are quoted or reported, not paraphrased into a principle.
	const reported = /["'\u201c\u2018].{6,}["'\u201d\u2019]|\b(user|they|paul) (said|says|asked|asks|told|wrote|replied|answered|chose|picked|approved|confirmed)\b/i.test(reason);
	const briefQuoteOnly =
		/\b(should feel|feel like|not a .* page|extension of)\b/i.test(reason) &&
		!/\b(comp|mock|fidelity|gate|plate)\b.*\b(approved|accept|fine|ok|okay|skip|drop|waive|relax|override|move on|proceed)\b/i.test(reason);

	return namesUser && aboutComp && downgrades && reported && !isTranslationDodge && !briefQuoteOnly;
}

/** Close the current phase, or refuse and say why. */
function advance(state: BuildState, { force = false, reason = null, gateOpts = {} }: { readonly force?: boolean; readonly reason?: string | null; readonly gateOpts?: Record<string, unknown> } = {}): { ok: boolean; phase?: Phase; next?: Phase; reasons?: string[]; gate?: GateResult; forced?: boolean } {
	const phase = state.phase;
	const idx = PHASES.indexOf(phase);
	if (idx === -1 || phase === "review") return { ok: false, reasons: [`phase ${phase} cannot advance; use finish`] };

	const hooks = PHASE_HOOKS[phase];
	const p = state.phases[phase];
	p.attempts += 1;
	const gate = runGate(state, phase, gateOpts);

	const { plates: _plates, ...gateRecord } = gate;
	p.gate = { ...gateRecord, at: now() };
	hooks?.onGate?.(state, gate, gateOpts);

	if (!gate.ok && force && !forceAllowed(reason)) {
		p.status = "open";
		return {
			ok: false,
			phase,
			reasons: [
				...(gate.reasons ?? []),
				`--force refused: "${reason || ""}" does not quote the user downgrading the comp. A single-file deliverable, a missing tool, or difficulty is not a reason, and a refused force is not the end of the phase: the readings above are the edits, each one a CSS value; make them, recapture, advance. Ask the user only when a reading contradicts something they said about this comp.`,
			],
			gate,
		};
	}

	hooks?.beforeRefusal?.(state, gate, gateOpts);

	if (!gate.ok && !force) {
		p.status = "open";
		return { ok: false, phase, reasons: gate.reasons, gate };
	}
	if (!gate.ok && force) p.forced = { at: now(), reason: reason as string, reasons: gate.reasons ?? [] };

	p.status = "closed";
	p.closedAt = now();
	hooks?.onClose?.(state, gate);

	const next = PHASES[idx + 1];
	state.phase = next;
	state.phases[next].status = "open";
	state.phases[next].openedAt = now();
	return { ok: true, phase, next, gate, forced: !!p.forced };
}

/**
 * What to do next, in the words a session acts on.
 *
 * A table keyed by the phase union, not a switch: a new phase is a compile error here until it has an
 * instruction, and no phase can hide behind a `default`.
 */
const NEXT_INSTRUCTIONS: Readonly<Record<Phase, (state: BuildState) => string>> = {
	comps: (state) =>
		`Comp round for the chosen direction${state.direction ? ` (seed ${state.direction})` : ""}: read reference/visualize.md, generate three compositional comps of the requested surface at its own viewport into ${MOCKS_DIR}/ (each with a prompt sidecar), put them in front of the user, and set "approved": true in the chosen comp's sidecar. Then build-phase advance. No page code before this closes.`,
	spec: (state) =>
		`Measure the comp: comp-spec --comp ${state.comp} --grid, open ${path.join(BUILD_DIR, "comp-grid.png")}, write regions.json (every illustration, photo, texture as its own plate region; every text block its own text region), run comp-spec --comp ${state.comp} --regions regions.json. Then measure the type: font-match --measure <id> for each text region (cap height, width class, weight class) and font-match --rank <lead text region> --text "<its first words>" to choose the headline face by metrics (the USE line is the CSS; with no browser it records the catalog's nearest face, which is the choice; do not install one, and do not write a chosen face into the spec by hand). Then build-phase advance.`,
	plates: () =>
		"Produce every plate in the spec (comp-spec --print lists them). Illustrations, photos, figures: generate-image --plate <id>, one call per plate. It crops the comp region itself, sends the crop as the edit reference, sizes the plate, keys ink-on-ground to alpha, scores the result against the crop (PLATE-SCORE) and embeds the prompt; nothing else does all of that. Only when it errors (no key, no network) fall back to the harness image tool with comp-spec --crop <id> as its reference image and comp-spec --plate-prompt <id> as its prompt, then embed-prompt; do not post-process a plate with magick or write your own keying. A generation takes 30 to 90 seconds: run it with a long wait (a 90 s yield, or all plates in one command joined with &&) rather than polling an open session turn after turn. A line drawing or figure on flat ground is keyed to alpha automatically (PLATE-CHROMA): place it with a plain <img> over the page's own ground, never on a second paper. An opaque plate whose ground differs from the page goes in with mix-blend-mode: multiply. Textures (paper, cloth, grain): do not generate first; crop a clean patch of the comp region (comp-spec --crop <id> --raw, then cut a patch free of ink), mirror-tile it to the plate size, and save it as the plate; generate only when no clean patch exists. The gate scores a texture against its whole region box, so a texture region should be drawn around clean ground (a sample cell), not around the ink it sits under; the page tiles it wherever the material goes. Then build-phase advance. Write no page code before this passes.",
	hero: (state) =>
		`Run build-phase scaffold first: it writes the measured layout as CSS custom properties (.impeccable/build/scaffold/layout.css, --r-<id>-x/y/w/h in % of the comp, plus cap height, font-size, family, and weight where measured) and a reference page with every region at its box. Bind those numbers to your own markup (an element per region, its box from the properties); the reference is a check, not the page, and overlapping boxes are overlapping boxes. Build only the first viewport at ${state.breakpoint || "the comp size"}. Copy the comp's words verbatim in this phase (headline, labels, table cells, footer): the user approved that comp with those words, and rewriting is a later, stated decision, never a silent one here. Set every text region's font-size from its measured cap height and its face from the ranking. Plates first: place every plate at its spec box (comp-spec --print lists boxes as percentages of the viewport) with object-fit: cover before writing a line of text or a control, capture into ${HERO_REPRO}, and run build-phase record hero (not advance) once so you see the plate regions read as match before text exists; then lay the semantic layer (text, controls, rules) over the plates from the spec's palette and boxes, capture, advance. When it fails, open the region crops it lists first, in order, then fix; do not build past the hero until it passes.`,
	sections: () =>
		"Build the remaining sections inside the spec system (same corner language, rules, and palette; nothing the comp does not show). The hero passed with the comp's words verbatim; from here, content beyond the comp is yours to author at full fidelity, and any change to words the comp showed is a stated decision in your report, never silent. Then build-phase advance.",
	motion: () => "Add the signature interaction, reveals, and motion. Then build-phase advance.",
	responsive: () =>
		"Build the other viewports (mobile first if the surface is mobile). The first viewport must hold at common desktop widths (1280 to 1600), not only at the comp's exact size: fluid columns, no fixed-px grid that wraps 96px narrower. Settle or disable entrance motion before capturing (an element mid-animation reads as missing). Capture desktop.png (1440 wide, full page) and mobile.png (390 wide, full page) into .impeccable/review/; the gate diffs the top of desktop.png (scaled to the comp's width) against the comp. Then build-phase advance.",
	review: () => "Spawn the finish reviewer with the state file, the hero diff report, and the captures; record its disposition with build-phase finish --disposition <word>.",
};

function nextInstruction(state: BuildState): string {
	// A phase the union does not have is a hand-edited state file: the reference gives it no
	// instruction, and neither does this.
	return NEXT_INSTRUCTIONS[state.phase]?.(state) ?? "";
}

/** The status block a session reads. */
function renderStatus(state: BuildState): string {
	const lines = [
		`BUILD-PHASE ${state.phase.toUpperCase()}  comp ${state.comp || "(pending comp round)"}${state.direction ? `  direction ${state.direction}` : ""}${state.breakpoint ? `  breakpoint ${state.breakpoint}` : ""}`,
	];

	for (const p of PHASES) {
		const s = state.phases[p];
		let line = `  ${p.padEnd(11)} ${s.status.padEnd(8)}`;
		if (s.gate && s.gate.summary) line += ` ${String(s.gate.summary)}`;
		if (s.attempts > 1) line += ` (${s.attempts} attempts)`;
		if (s.forced) line += `  FORCED: ${s.forced.reason}`;
		lines.push(line);
	}

	if (state.finish) lines.push(`  finish      ${state.finish.disposition} at ${state.finish.at}`);
	lines.push(`NEXT ${nextInstruction(state)}`);
	return lines.join("\n");
}

/**
 * Whether a "ship" disposition may be recorded: a page shipped over an open phase is a page shipped
 * against its own gate.
 */
function shipAllowed(state: BuildState): { ok: boolean; open: string[] } {
	const open = PHASES.filter((ph) => ph !== "review" && state.phases[ph] && state.phases[ph].status !== "closed" && state.phases[ph].status !== "skipped");
	return { ok: open.length === 0, open };
}

/** Record a finish disposition, refusing a ship over an open phase. */
function finish(state: BuildState, disposition: string): { ok: boolean; error?: string; state: BuildState } {
	if (!isDisposition(disposition)) return { ok: false, error: `build-phase: finish --disposition ${DISPOSITIONS.join("|")}`, state };

	const check = shipAllowed(state);
	if (disposition === "ship" && !check.ok) {
		return {
			ok: false,
			error: `build-phase: finish --disposition ship refused: ${check.open.join(", ")} ${check.open.length === 1 ? "is" : "are"} not closed (phase ${state.phase}). Record fix or rebuild, or close the phases first; a page shipped over an open hero is a page shipped against its own gate.`,
			state,
		};
	}

	state.finish = { disposition, at: now(), phaseAtFinish: state.phase };
	if (state.phase === "review") {
		state.phases.review.status = "closed";
		state.phases.review.closedAt = now();
	}
	return { ok: true, state };
}

export {
	advance,
	compRoundOpen,
	finish,
	forceAllowed,
	gateComps,
	gateHero,
	gatePlates,
	gateResponsive,
	gateSpec,
	HERO_MIN,
	HERO_REPRO,
	heroLoopVerdict,
	heroReadings,
	INVENTED_MIN,
	listComps,
	loadState,
	MOCKS_DIR,
	newState,
	nextInstruction,
	organicClipRegions,
	PHASES,
	plateVerdict,
	PLATE_MIN,
	PLATE_STRUCTURE_MIN,
	readBuildPath,
	readBuildStatus,
	renderStatus,
	RESPONSIVE_MIN,
	runGate,
	saveState,
	shipAllowed,
	sourceFiles,
	STATE_PATH,
	unreferencedPlates,
	writeScaffold,
};
export type { BuildState, BuildStatus, DiffIo, Disposition, FinishRecord, GateResult, Phase, PhaseState, PhaseStatus, PlateStatus, TypedRegion };