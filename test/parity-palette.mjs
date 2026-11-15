/**
 * Parity check: the brand seed against the reference.
 *
 * The seed decides the whole palette a build starts from, and two things make it trustworthy: the
 * draw has to be reproducible from a key, and the handover text has to be the reference's own. Both
 * are compared against the reference CLI, so the text is compared whole rather than sampled.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/palette.ts");
const seeds = await import("../extensions/designer/engine/lib/palette-seeds.ts");
const portSeeds = await import("../extensions/designer/engine/lib/palette-seeds.ts");
const referenceFile = path.resolve("reference/impeccable-js/scripts/palette.mjs");

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

/** Run the reference as a CLI with a fixed key, so the draw is reproducible. */
function runRef(args, key = null) {
	try {
		const out = execFileSync("node", [referenceFile, ...args], { encoding: "utf8", env: { ...process.env, ...(key ? { IMPECCABLE_PALETTE_SEED: key } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, out };
	} catch (error) {
		return { code: error.status ?? 1, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
	}
}

/** Pull the seed's id and colour out of a response. */
function parseResponse(text) {
	const id = /BRAND SEED · (\S+)/.exec(text)?.[1] ?? null;
	const color = /oklch\([^)]+\)/.exec(text)?.[0] ?? null;
	return { id, color };
}

// ─── the library ────────────────────────────────────────────────────
// Extracted mechanically from the reference module, so the count and the shape are the check.
const referenceSource = fs.readFileSync(referenceFile, "utf8");
const referenceIds = [...referenceSource.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
check("seed ids match the reference", portSeeds.SEEDS.map((s) => s.id), referenceIds);
check("seed count", portSeeds.SEEDS.length, referenceIds.length);
check(
	"seed colours match the reference",
	portSeeds.SEEDS.map((s) => s.oklch),
	[...referenceSource.matchAll(/oklch: \[([^\]]+)\]/g)].map((m) => m[1].split(",").map((v) => Number(v.trim()))),
);
check("every seed has an id, a colour, a mood and a strategy", portSeeds.SEEDS.every((s) => s.id && s.oklch?.length === 3 && s.mood && s.strategy), true);

// ─── the pure helpers ───────────────────────────────────────────────
for (const key of ["alpha", "seed-key-1", "", "a much longer build key with spaces in it"]) {
	check(`hashUnit(${JSON.stringify(key)})`, port.hashUnit(key), hashUnitRef(key));
}
function hashUnitRef(key) {
	const { createHash } = require("node:crypto");
	return createHash("sha256").update(key).digest().readUInt32BE(0) / 0x100000000;
}

for (const [L, C, H] of [[0.4, 0.13, 0], [1, 0, 0], [0.734, 0.183, 356.8]]) {
	check(`fmtOklch(${L},${C},${H})`, port.fmtOklch([L, C, H]), `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`);
}

for (const H of [0, 14, 15, 34, 35, 54, 55, 79, 80, 104, 105, 134, 135, 169, 170, 199, 200, 229, 230, 264, 265, 294, 295, 329, 330, 344, 345, 359, 360]) {
	check(`hueWord(${H}) vs its own boundaries`, typeof port.hueWord(H), "string");
}
check("hueWord(0)", port.hueWord(0), "pure red");
check("hueWord(20)", port.hueWord(20), "warm red / crimson");
check("hueWord(180)", port.hueWord(180), "teal");
check("hueWord(350)", port.hueWord(350), "pure red"); // the first branch catches H >= 345
check("hueWord(340)", port.hueWord(340), "deep pink / rose");

// ─── the draw is reproducible, and matches the reference for the same key ──
for (const key of ["build-1", "build-2", "a different key entire", "seed:critique:abc"]) {
	const portPick = port.pickSeed(portSeeds.SEEDS, { from: key });
	const reference = runRef([], key);
	const parsed = parseResponse(reference.out);
	check(`pickSeed(from: ${key})`, portPick.id, parsed.id);
	check(`pickSeed(from: ${key}) colour`, port.fmtOklch(portPick.oklch), parsed.color);
	check(`pickSeed(from: ${key}) is reproducible`, port.pickSeed(portSeeds.SEEDS, { from: key }).id, portPick.id);
}

// The environment key is a fallback for a caller that passes nothing.
check("pickSeed(env)", port.pickSeed(portSeeds.SEEDS, {}, { IMPECCABLE_PALETTE_SEED: "build-1" }).id, port.pickSeed(portSeeds.SEEDS, { from: "build-1" }).id);
check("pickSeed(explicit from wins)", port.pickSeed(portSeeds.SEEDS, { from: "build-2" }, { IMPECCABLE_PALETTE_SEED: "build-1" }).id, port.pickSeed(portSeeds.SEEDS, { from: "build-2" }).id);

// An id is honoured exactly, and an unknown one is an error rather than a fallback.
for (const id of ["seed-200", "seed-116", "seed-000"]) {
	const portPick = port.pickSeed(portSeeds.SEEDS, { id });
	const reference = runRef(["--id", id]);
	check(`pickSeed(--id ${id})`, portPick.id, parseResponse(reference.out).id);
	check(`pickSeed(--id ${id}) colour`, port.fmtOklch(portPick.oklch), parseResponse(reference.out).color);
}
check("pickSeed(unknown id) throws", (() => {
	try {
		port.pickSeed(portSeeds.SEEDS, { id: "seed-nope" });
		return "picked";
	} catch (error) {
		return String(error.message);
	}
})(), 'no seed with id "seed-nope"');
check("reference rejects an unknown id", runRef(["--id", "seed-nope"]).code, 2);

// ─── the handover text ──────────────────────────────────────────────
for (const id of ["seed-200", "seed-116", "seed-000"]) {
	const portText = port.renderSeed(port.pickSeed(portSeeds.SEEDS, { id }));
	const reference = runRef(["--id", id]);
	check(`renderSeed(${id}) is the reference's own text`, portText, reference.out);
}

// A seed with neither a mood nor a strategy still reads cleanly.
const bare = { id: "seed-bare", oklch: [0.5, 0.1, 120] };
const bareText = port.renderSeed(bare);
check("renderSeed(bare) has no mood hint", bareText.includes("one read:"), false);
check("renderSeed(bare) has no strategy hint", bareText.includes("one example strategy:"), false);
check("renderSeed(bare) still names its colour", bareText.includes("oklch(0.500 0.100 120.0)"), true);

// ─── the hue weighting ──────────────────────────────────────────────
const { weights, total } = port.buildWeights(portSeeds.SEEDS);
check("weights sum to the total", Math.abs(weights.reduce((a, b) => a + b, 0) - total) < 1e-9, true);
check("every weight is positive", weights.every((w) => w > 0), true);

// Each hue zone is roughly equally likely: over many keys, no bucket is wildly over-drawn.
const bucketCounts = {};
for (let i = 0; i < 400; i++) {
	const pick = port.pickSeed(portSeeds.SEEDS, { from: `draw-${i}` });
	const bucket = Math.floor((((pick.oklch[2] % 360) + 360) % 360) / 30);
	bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
}
const counts = Object.values(bucketCounts);
const spread = Math.max(...counts) / Math.max(1, Math.min(...counts));
check("the draw is spread across hue zones", spread < 6, true);

// ─── the argument parser ────────────────────────────────────────────
check("parsePaletteArgs(--id x)", port.parsePaletteArgs(["--id", "seed-200"]), { id: "seed-200", from: null });
check("parsePaletteArgs(--from x)", port.parsePaletteArgs(["--from", "key"]), { id: null, from: "key" });
check("parsePaletteArgs(both)", port.parsePaletteArgs(["--id", "a", "--from", "b"]), { id: "a", from: "b" });
check("parsePaletteArgs(nothing)", port.parsePaletteArgs([]), { id: null, from: null });
check("parsePaletteArgs(dangling flag)", port.parsePaletteArgs(["--id"]), { id: null, from: null });

check("SEEDS is re-exported", seeds.SEEDS.length, port.SEEDS.length);

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} palette comparisons failed`);
	process.exit(1);
}
console.log(`palette parity: ${comparisons} comparisons match the reference`);
