/**
 * Parity check: prompt embedding against the reference.
 *
 * The risk here is a writer and reader that disagree: a chunk inserted with the wrong CRC, an
 * idempotent rewrite that leaves two prompts behind, or a sidecar fallback the reader never checks.
 * The comparisons embed with both implementations and read the bytes back, then re-embed over an
 * existing prompt to prove the second write replaces rather than appends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/embed-prompt.ts");
const raster = await import("../extensions/designer/engine/lib/raster.ts");
const png = await import("../extensions/designer/engine/lib/png.ts");

const referenceScript = path.resolve("reference/impeccable-js/scripts/embed-prompt.mjs");

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

/** Run the reference as a CLI, since it is a script rather than a module. */
function runRef(args) {
	try {
		return { code: 0, out: execFileSync("node", [referenceScript, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (error) {
		return { code: error.status ?? 1, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-embed-"));
const writePng = (name, width = 8, height = 6) => {
	const file = path.join(dir, name);
	fs.writeFileSync(file, png.encodePng(raster.createImage(width, height, [200, 100, 50, 255])));
	return file;
};

try {
	// ─── format detection ───────────────────────────────────────────────
	const pngBytes = fs.readFileSync(writePng("detect.png"));
	check("imageType(png)", port.imageType(pngBytes), "png");
	check("imageType(jpeg)", port.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "jpeg");
	check("imageType(webp)", port.imageType(Buffer.from("RIFFxxxxWEBPVP8 ")), null);
	check("imageType(short)", port.imageType(Buffer.from([0xff])), null);

	// ─── embedding into a PNG ───────────────────────────────────────────
	const portFile = writePng("port.png");
	const refFile = writePng("ref.png");
	check("embedPrompt(png)", port.embedPrompt(portFile, "a photographed carburetor on paper").kind, "png");

	const refWrite = runRef([refFile, "--prompt", "a photographed carburetor on paper"]);
	check("reference embedded", refWrite.code, 0);

	// Both files carry the same prompt, and the bytes are identical because the chunk is built the
	// same way.
	check("readPrompt(png, port)", port.readPrompt(portFile), "a photographed carburetor on paper");
	check("readPrompt(png, ref)", port.readPrompt(refFile), "a photographed carburetor on paper");
	check("embedded PNG bytes are identical", fs.readFileSync(portFile).equals(fs.readFileSync(refFile)), true);

	// Embedding again replaces rather than appends, and is idempotent.
	const before = fs.readFileSync(portFile);
	port.embedPrompt(portFile, "a photographed carburetor on paper");
	check("re-embedding is idempotent", fs.readFileSync(portFile).equals(before), true);
	port.embedPrompt(portFile, "a different prompt entirely");
	check("re-embedding replaces", port.readPrompt(portFile), "a different prompt entirely");
	check("a replaced PNG still decodes", png.decodePng(fs.readFileSync(portFile)).width, 8);

	runRef([refFile, "--prompt", "a different prompt entirely"]);
	check("reference replaces too", port.readPrompt(refFile), "a different prompt entirely");

	// The chunk is where a reader expects it: immediately before IEND.
	const chunks = port.parsePng(fs.readFileSync(portFile)).chunks.map((c) => c.type);
	check("prompt chunk sits before IEND", chunks.slice(-2), ["tEXt", "IEND"]);
	check("chunk count is stable across re-embedding", port.parsePng(fs.readFileSync(refFile)).chunks.length, chunks.length);

	// ─── the sidecar fallback ───────────────────────────────────────────
	const webpFile = path.join(dir, "comp.webp");
	fs.writeFileSync(webpFile, Buffer.from("RIFFxxxxWEBPVP8 pretend"));
	const embedded = port.embedPrompt(webpFile, "a texture of coarse paper");
	check("embedPrompt(webp) writes a sidecar", embedded.kind, "sidecar");
	check("sidecar path", embedded.path, `${webpFile}.json`);
	check("readPrompt(webp sidecar)", port.readPrompt(webpFile), "a texture of coarse paper");
	fs.writeFileSync(path.join(dir, "other.webp"), Buffer.from("RIFFxxxxWEBPVP8 nothing here"));
	check("readPrompt(sidecar missing prompt)", port.readPrompt(path.join(dir, "other.webp")), null);

	// A PNG whose metadata was stripped still reads back from its sidecar.
	const strippedFile = writePng("stripped.png");
	fs.writeFileSync(`${strippedFile}.json`, JSON.stringify({ prompt: "recovered from the sidecar" }));
	check("readPrompt(png+sidecar)", port.readPrompt(strippedFile), "recovered from the sidecar");

	// ─── scanning ───────────────────────────────────────────────────────
	const scanDir = path.join(dir, "mocks");
	fs.mkdirSync(path.join(scanDir, "node_modules"), { recursive: true });
	fs.mkdirSync(path.join(scanDir, ".hidden"), { recursive: true });
	writePng("mocks/with-prompt.png");
	port.embedPrompt(path.join(scanDir, "with-prompt.png"), "named");
	writePng("mocks/without-prompt.png");
	writePng("mocks/node_modules/ignored.png");
	writePng("mocks/.hidden/ignored.png");

	const scanned = port.scanForMissingPrompts([scanDir]);
	check("scan finds only the rasters the walk reaches", scanned.rasters.map((f) => path.basename(f)).sort(), ["with-prompt.png", "without-prompt.png"]);
	check("scan reports the missing one", scanned.missing.map((f) => path.basename(f)), ["without-prompt.png"]);

	// The reference agrees on the same directory.
	const refScan = runRef(["--scan", scanDir]);
	check("reference scan exit code", refScan.code, 3);
	check("reference scan names the same file", refScan.out.includes("MISSING:") && refScan.out.includes("without-prompt.png"), true);
	check("reference scan does not name the embedded one", refScan.out.includes("MISSING:") && !refScan.out.match(/MISSING:.*with-prompt/), true);

	// A hidden directory passed explicitly is walked.
	const explicit = port.scanForMissingPrompts([path.join(scanDir, ".hidden")]);
	check("explicit hidden dir is walked", explicit.rasters.length, 1);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} embed-prompt comparisons failed`);
	process.exit(1);
}
console.log(`embed-prompt parity: ${comparisons} comparisons match the reference`);
