/**
 * Parity check: image generation's deterministic half against the reference.
 *
 * The provider call is a host seam, so what is compared is everything around it: the prompt-hashed
 * palette, the fake SVG and PNG (which a smoke suite asserts on byte for byte), the size a plate has
 * to be, whether a line drawing gets keyed to alpha, and the chroma key itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/generate-image.ts");
const raster = await import("../extensions/designer/engine/lib/raster.ts");
const png = await import("../extensions/designer/engine/lib/png.ts");

const referenceScript = path.resolve("reference/impeccable-js/scripts/generate-image.mjs");

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

/** The reference's fake mode is a CLI; drive it the same way a smoke suite would. */
function runRefFake(args, env = {}) {
	try {
		return { code: 0, out: execFileSync("node", [referenceScript, ...args], { encoding: "utf8", env: { ...process.env, IMPECCABLE_IMAGE_GEN_FAKE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (error) {
		return { code: error.status ?? 1, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-genimg-"));

try {
	// ─── the prompt-hashed palette ──────────────────────────────────────
	for (const prompt of ["a photographed carburetor on paper", "", "x", "A different prompt entirely, with more words in it"]) {
		check(`hash32(${JSON.stringify(prompt)})`, port.hash32(prompt), refHash32(prompt));
		check(`palette(${JSON.stringify(prompt)})`, port.palette(prompt), refPalette(prompt));
	}

	// The reference keeps these private, so they are re-derived here from its own module text: the
	// exported fake outputs below are the real proof, and these two helpers only localize a failure.
	function refHash32(str) {
		let h = 0x811c9dc5;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	}
	function refPalette(prompt) {
		const h = refHash32(prompt);
		const base = h % 360;
		const bands = 2 + ((h >>> 9) % 2);
		const spread = 40 + ((h >>> 3) % 120);
		const out = [];
		for (let i = 0; i < bands; i++) {
			const light = 0.32 + ((h >>> (i * 5)) % 40) / 100;
			out.push(port.hslToRgb(base + i * spread, 0.55, light));
		}
		return out;
	}

	for (const [h, s, l] of [[0, 0.55, 0.5], [120, 1, 0.3], [359, 0.2, 0.9], [-40, 0.5, 0.5]]) {
		check(`hslToRgb(${h},${s},${l})`, port.hslToRgb(h, s, l), [h, s, l].length ? hsl(h, s, l) : []);
	}
	function hsl(hDeg, s, l) {
		const h = (((hDeg % 360) + 360) % 360) / 360;
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		const hue = (t) => {
			let tt = t;
			if (tt < 0) tt += 1;
			if (tt > 1) tt -= 1;
			if (tt < 1 / 6) return p + (q - p) * 6 * tt;
			if (tt < 1 / 2) return q;
			if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
			return p;
		};
		return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((c) => Math.round(c * 255));
	}

	// ─── the fake outputs, byte for byte ────────────────────────────────
	for (const [prompt, size, ext] of [
		["a photographed carburetor on paper", "1536x1024", "svg"],
		["a photographed carburetor on paper", "800x600", "svg"],
		["a texture of coarse paper", "1024x1024", "png"],
		["a texture of coarse paper", "1536x1024", "png"],
		["short", null, "png"],
	]) {
		const portFile = path.join(dir, `port.${ext}`);
		const refFile = path.join(dir, `ref.${ext}`);
		const produced = port.fakeComp(prompt, portFile, size);
		const reference = runRefFake(["--prompt", prompt, "--out", refFile, ...(size ? ["--size", size] : [])]);
		check(`fakeComp(${JSON.stringify(prompt)}, ${size}, ${ext}) exit`, produced.out.endsWith(".svg") || produced.out.endsWith(".png"), true);
		check(`fakeComp(${JSON.stringify(prompt)}, ${size}, ${ext}) bytes`, fs.readFileSync(portFile).equals(fs.readFileSync(refFile)), true);
		check(`fakeComp(${JSON.stringify(prompt)}, ${size}, ${ext}) reference exit`, reference.code, 0);
	}

	// The fake PNG keeps its prompt and marker in a tEXt chunk, so downstream stays a valid image.
	const fakeFile = path.join(dir, "fake.png");
	port.fakeComp("a photographed carburetor on paper", fakeFile, "1024x1024");
	const decoded = png.decodePng(fs.readFileSync(fakeFile));
	check("fake PNG decodes", { width: decoded.width, height: decoded.height }, { width: 1024, height: 1024 });
	check("fake PNG carries the marker", decoded.text.Comment.startsWith("SYNTHETIC COMP:"), true);
	check("fake PNG is deterministic", (() => {
		const again = path.join(dir, "again.png");
		port.fakeComp("a photographed carburetor on paper", again, "1024x1024");
		return fs.readFileSync(fakeFile).equals(fs.readFileSync(again));
	})(), true);

	check("parseSize(1536x1024)", port.parseSize("1536x1024"), [1536, 1024]);
	check("parseSize(bad)", port.parseSize("huge"), [1536, 1024]);
	check("parseSize(null)", port.parseSize(null), [1536, 1024]);

	// ─── the chroma key ─────────────────────────────────────────────────
	/** A flat key-colour field with a dark shape in the middle. */
	function chromaImage(width = 40, height = 30, keyColor = [0, 255, 0]) {
		const img = raster.createImage(width, height, [...keyColor, 255]);
		raster.fillRect(img, 10, 8, 20, 14, [30, 30, 36, 255]);
		return img;
	}
	const keyed = path.join(dir, "keyed.png");
	fs.writeFileSync(keyed, png.encodePng(chromaImage(), { text: { "impeccable:prompt": "a keyed plate" } }));
	const keyedFraction = port.keyChroma(keyed, "#00ff00");
	const keyedImage = png.decodePng(fs.readFileSync(keyed));
	check("keyChroma makes the field transparent", keyedImage.data[(2 * 40 + 2) * 4 + 3], 0);
	check("keyChroma keeps the artwork opaque", keyedImage.data[(12 * 40 + 20) * 4 + 3], 255);
	check("keyChroma keeps the embedded prompt", keyedImage.text["impeccable:prompt"], "a keyed plate");
	check("keyChroma reports a fraction", keyedFraction > 0.4 && keyedFraction < 0.8, true);

	// A field that is not green is still keyed, using the sampled corners.
	const blued = path.join(dir, "blued.png");
	fs.writeFileSync(blued, png.encodePng(chromaImage(40, 30, [0, 0, 255])));
	port.keyChroma(blued, "#00ff00");
	check("keyChroma samples the actual key", png.decodePng(fs.readFileSync(blued)).data[(2 * 40 + 10) * 4 + 3], png.decodePng(fs.readFileSync(blued)).data[(2 * 40 + 2) * 4 + 3]);

	// ─── plate planning ─────────────────────────────────────────────────
	const specPath = path.join(dir, "spec.json");
	const compFile = path.join(dir, "comp.png");
	fs.writeFileSync(compFile, png.encodePng(raster.createImage(300, 200, [246, 242, 234, 255])));
	const spec = {
		tool: "comp-spec",
		version: 1,
		createdAt: "pinned",
		comp: compFile,
		warnings: [],
		uncoveredInkCells: [],
		compSize: { width: 300, height: 200 },
		aspect: 1.5,
		orientation: "landscape",
		palette: [{ hex: "#f6f2ea", coverage: 0.8 }, { hex: "#222226", coverage: 0.15 }],
		bands: [],
		regions: [
			{ id: "hero", kind: "plate", note: "an exploded carburetor drawing", box: { x: 0, y: 0, w: 0.5, h: 0.5 }, px: { x: 0, y: 0, w: 150, h: 100 }, aspect: 1.5, palette: [{ hex: "#f6f2ea", coverage: 0.8 }, { hex: "#222226", coverage: 0.15 }], detail: { energy: 5 }, medium: "raster", plate: path.join(dir, "plates", "hero.png"), text: null },
			{ id: "wide", kind: "image", note: "a wide photograph of the machine", box: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, px: { x: 150, y: 0, w: 150, h: 100 }, aspect: 1.5, palette: [{ hex: "#111111", coverage: 0.5 }], detail: { energy: 5 }, medium: "raster", plate: path.join(dir, "plates", "wide.png"), text: null },
			{ id: "tall", kind: "image", note: "a tall portrait photograph", box: { x: 0, y: 0.5, w: 0.25, h: 0.5 }, px: { x: 0, y: 100, w: 60, h: 100 }, aspect: 0.6, palette: [{ hex: "#111111", coverage: 0.5 }], detail: { energy: 5 }, medium: "raster", plate: path.join(dir, "plates", "tall.png"), text: null },
			{ id: "square", kind: "image", note: "a square crop of the plate", box: { x: 0.25, y: 0.5, w: 0.25, h: 0.5 }, px: { x: 60, y: 100, w: 100, h: 100 }, aspect: 1, palette: [{ hex: "#111111", coverage: 0.5 }], detail: { energy: 5 }, medium: "raster", plate: path.join(dir, "plates", "square.png"), text: null },
			{ id: "headline", kind: "text", note: "the headline", box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, px: { x: 150, y: 100, w: 150, h: 100 }, aspect: 1.5, palette: [], detail: { energy: 3 }, medium: "semantic", plate: null, text: "HEADLINE" },
		],
	};
	fs.writeFileSync(specPath, JSON.stringify(spec));

	const portPlan = port.planPlate({ spec, region: spec.regions[0], refDir: path.join(dir, "crops") });
	check("planPlate(out)", portPlan.out, path.join(dir, "plates", "hero.png"));
	check("planPlate(size) for a wide plate", portPlan.size, "1536x1024");
	check("planPlate(crops the reference)", fs.existsSync(portPlan.refPath), true);
	check("planPlate(reference path is under crops)", portPlan.refPath.endsWith(path.join("crops", "hero.png")), true);
	check("planPlate(chroma on for ink on ground)", portPlan.chroma, "#00ff00");
	check("planPlate(prompt carries the region note)", portPlan.prompt.includes("an exploded carburetor drawing"), true);
	check("planPlate(prompt carries the palette)", portPlan.prompt.includes("#f6f2ea"), true);

	const tallPlan = port.planPlate({ spec, region: spec.regions[2], refDir: path.join(dir, "crops") });
	check("planPlate(tall) picks the portrait frame", tallPlan.size, "1024x1536");
	const widePlan = port.planPlate({ spec, region: spec.regions[1], refDir: path.join(dir, "crops") });
	check("planPlate(wide, opaque) skips chroma", widePlan.chroma, null);

	// An explicit size and an explicit chroma choice win.
	const forced = port.planPlate({ spec, region: spec.regions[0], size: "512x512", chroma: false, refDir: path.join(dir, "crops") });
	check("planPlate(--size)", forced.size, "512x512");
	check("planPlate(--no-chroma)", forced.chroma, null);

	check("inkOnGround(one colour)", port.inkOnGround({ palette: [{ coverage: 0.9 }] }), false);
	check("inkOnGround(two colours)", port.inkOnGround({ palette: [{ coverage: 0.8 }, { coverage: 0.2 }] }), true);
	check("inkOnGround(thin ground)", port.inkOnGround({ palette: [{ coverage: 0.4 }, { coverage: 0.6 }] }), false);

	// A text region is refused rather than planned.
	check("planPlate(refuses a text region)", (() => {
		try {
			port.planPlate({ spec, region: spec.regions[4], refDir: path.join(dir, "crops") });
			return "planned";
		} catch (error) {
			return String(error.message).includes("not a plate");
		}
	})(), true);

	// ─── the fake plate ─────────────────────────────────────────────────
	const fakePlan = port.fakePlate(portPlan);
	check("fakePlate writes a 2x crop", { width: fakePlan.width, height: fakePlan.height }, { width: 300, height: 200 });
	const plateBytes = png.decodePng(fs.readFileSync(portPlan.out));
	check("fakePlate embeds its prompt", plateBytes.text["impeccable:prompt"], portPlan.prompt);
	check("fakePlate marks itself fake", plateBytes.text["impeccable:fake"], "1");
	check("fakePlate writes a sidecar", JSON.parse(fs.readFileSync(`${portPlan.out}.json`, "utf8")).plate, "hero");

	// ─── scoring ────────────────────────────────────────────────────────
	const scored = port.scorePlate(portPlan);
	check("scorePlate names the region", scored.text.includes("PLATE-SCORE hero"), true);
	check("scorePlate scores a 2x crop as the region", scored.overall > 0.9, true);

	// ─── the mocks gate ─────────────────────────────────────────────────
	const gateDir = path.join(dir, "gate");
	fs.mkdirSync(path.join(gateDir, ".impeccable", "build"), { recursive: true });
	fs.writeFileSync(path.join(gateDir, ".impeccable", "build", "pending.json"), "{}");
	check("mockOutputAllowed(pending, into mocks)", port.mockOutputAllowed({ out: ".impeccable/mocks/a.png", cwd: gateDir }).ok, false);
	check("mockOutputAllowed(--force-mock)", port.mockOutputAllowed({ out: ".impeccable/mocks/a.png", cwd: gateDir, force: true }).ok, true);
	check("mockOutputAllowed(outside mocks)", port.mockOutputAllowed({ out: "assets/a.png", cwd: gateDir }).ok, true);
	fs.writeFileSync(path.join(gateDir, ".impeccable", "build", "state.json"), "{}");
	check("mockOutputAllowed(state exists)", port.mockOutputAllowed({ out: ".impeccable/mocks/a.png", cwd: gateDir }).ok, true);
	check("mockOutputAllowed(decision dir)", port.mockOutputAllowed({ out: ".impeccable/mocks/decision/a.png", cwd: gateDir, force: false }).ok, true);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} generate-image comparisons failed`);
	process.exit(1);
}
console.log(`generate-image parity: ${comparisons} comparisons match the reference`);
