/**
 * Image generation: the deterministic offline stand-in, the chroma key, the plate plan, and the
 * score a plate is judged on. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The provider call is a host seam here — a caller supplies `generate` — because pi already has an
 * image tool and this module's value is everything around the call: the fake mode that makes the
 * concept and comp chain runnable without spend, the flat-key background a line drawing needs, the
 * size a plate has to be, and the score that decides whether what came back is the region.
 *
 * Fake mode is deterministic on purpose: the same prompt produces identical bytes, so a fixture can
 * assert on them. The SVG carries the readable text; a raster fallback carries palette stripes and
 * stows the prompt plus a `SYNTHETIC` marker in a tEXt chunk, so downstream still sees a valid image.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createImage, blit, resize, type Image } from "./raster.ts";
import { decodePng, encodePng, loadRaster } from "./png.ts";
import { compare } from "./comp-diff.ts";
import { plateReference, type CompSpec, type SpecRegion } from "./comp-spec.ts";
import { plateVerdict, readBuildStatus } from "./build-phase.ts";

/** FNV-1a 32-bit: tiny, dependency-free, and stable across runs and platforms. */
function hash32(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
	const h = (((hDeg % 360) + 360) % 360) / 360;
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;

	const hue = (t: number) => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};

	return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((c) => Math.round(c * 255)) as [number, number, number];
}

const toHex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/**
 * Two or three deterministic swatches derived from the prompt hash.
 *
 * The band count itself is prompt-derived, so different prompts differ in palette as well as in hue.
 */
function palette(prompt: string): Array<[number, number, number]> {
	const h = hash32(prompt);
	const base = h % 360;
	const bands = 2 + ((h >>> 9) % 2); // 2 or 3
	const spread = 40 + ((h >>> 3) % 120);

	const out: Array<[number, number, number]> = [];
	for (let i = 0; i < bands; i++) {
		const hue = base + i * spread;
		const light = 0.32 + ((h >>> (i * 5)) % 40) / 100; // 0.32 to 0.71
		out.push(hslToRgb(hue, 0.55, light));
	}
	return out;
}

/** The fake SVG: the prompt over the palette gradient, captioned as synthetic. */
function svgFake(prompt: string, [w, h]: readonly [number, number]): string {
	const colors = palette(prompt).map(toHex);
	const stops = colors.map((c, i) => `<stop offset="${Math.round((i / (colors.length - 1)) * 100)}%" stop-color="${c}"/>`).join("");

	// Greedy word wrap tuned to the canvas width, so the prompt stays legible.
	const perLine = Math.max(12, Math.floor(w / 26));
	const words = String(prompt).replace(/\s+/g, " ").trim().split(" ");
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		if (`${cur} ${word}`.trim().length > perLine) {
			if (cur) lines.push(cur);
			cur = word;
		} else {
			cur = `${cur} ${word}`.trim();
		}
		if (lines.length >= 10) break;
	}
	if (cur && lines.length < 11) lines.push(cur);

	const escape = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
	const fontSize = Math.round(w / 24);
	const startY = h / 2 - ((lines.length - 1) * fontSize * 1.3) / 2;
	const text = lines
		.map(
			(line, i) =>
				`<text x="${w / 2}" y="${Math.round(startY + i * fontSize * 1.3)}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escape(line)}</text>`,
		)
		.join("");

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect x="0" y="0" width="${w}" height="${h}" fill="#000000" fill-opacity="0.22"/>
  ${text}
  <rect x="${w - Math.round(w / 4.2)}" y="${h - Math.round(h / 16)}" width="${Math.round(w / 4.2)}" height="${Math.round(h / 16)}" fill="#000000" fill-opacity="0.55"/>
  <text x="${w - Math.round(w / 8.4)}" y="${h - Math.round(h / 32)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w / 60)}" letter-spacing="2" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">SYNTHETIC COMP</text>
</svg>
`;
}

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c ^= buf[i];
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "latin1");
	const body = Buffer.concat([typeBuf, data]);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

/**
 * A minimal valid PNG: palette stripes plus a tEXt chunk carrying the marker and the prompt, so a
 * raster fake stays a decodable image and still contains the `SYNTHETIC` bytes downstream looks for.
 */
function pngFake(prompt: string, [w, h]: readonly [number, number]): Buffer {
	const colors = palette(prompt);
	const bandH = Math.ceil(h / colors.length);

	// Raw image: each scanline prefixed with a zero filter byte, then RGB pixels.
	const stride = w * 3;
	const raw = Buffer.alloc(h * (stride + 1));
	for (let y = 0; y < h; y++) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0;
		const [r, g, b] = colors[Math.min(colors.length - 1, Math.floor(y / bandH))];
		for (let x = 0; x < w; x++) {
			const p = rowStart + 1 + x * 3;
			raw[p] = r;
			raw[p + 1] = g;
			raw[p + 2] = b;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour RGB

	const idat = zlib.deflateSync(raw, { level: 9 });
	const textData = Buffer.concat([
		Buffer.from("Comment", "latin1"),
		Buffer.from([0]),
		Buffer.from(`SYNTHETIC COMP: ${String(prompt).replace(/\s+/g, " ").trim()}`, "latin1"),
	]);

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("tEXt", textData),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** `1536x1024` into a pair, defaulting to the landscape frame. */
function parseSize(sizeStr: string | null | undefined): [number, number] {
	const m = String(sizeStr).match(/^(\d+)x(\d+)$/);
	if (!m) return [1536, 1024];
	return [Number(m[1]), Number(m[2])];
}

/** A region whose crop is dominated by one ground colour: ink on ground. */
function inkOnGround(region: { readonly palette?: readonly { readonly coverage: number }[] }): boolean {
	const pal = region.palette || [];
	if (pal.length < 2) return false;
	return pal[0].coverage >= 0.55;
}

function hexRgb(h: string): [number, number, number] {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
	return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 255, 0];
}

/**
 * Key a flat colour to alpha with a soft edge.
 *
 * Pixels within `hard` of the key go fully transparent, within `soft` fade, and green spill on the
 * edge is pulled toward the ink. The key is sampled from the corners, because generators shift the
 * green; a "greener than both other channels" test catches the gradients they add. The tEXt chunks
 * written before keying are kept, so the embedded prompt survives.
 */
function keyChroma(file: string, keyHex: string): number {
	const img = decodePng(fs.readFileSync(file));
	const [kr, kg, kb] = hexRgb(keyHex);

	const corners: Array<[number, number]> = [
		[2, 2],
		[img.width - 3, 2],
		[2, img.height - 3],
		[img.width - 3, img.height - 3],
	];
	let sr = 0;
	let sg = 0;
	let sb = 0;
	for (const [x, y] of corners) {
		const p = (y * img.width + x) * 4;
		sr += img.data[p];
		sg += img.data[p + 1];
		sb += img.data[p + 2];
	}

	const key: [number, number, number] = [sr / 4, sg / 4, sb / 4];
	const isGreenish = key[1] > 120 && key[1] > key[0] * 1.4 && key[1] > key[2] * 1.4;
	const K = isGreenish ? key : ([kr, kg, kb] as [number, number, number]);
	const hard = 60;
	const soft = 120;
	let keyed = 0;

	for (let i = 0; i < img.data.length; i += 4) {
		const r = img.data[i];
		const g = img.data[i + 1];
		const b = img.data[i + 2];
		const d = Math.sqrt((r - K[0]) ** 2 + (g - K[1]) ** 2 + (b - K[2]) ** 2);

		const greenDom = g > 150 && g - Math.max(r, b) > 60;
		if (d < hard || greenDom) {
			img.data[i + 3] = 0;
			keyed++;
			continue;
		}
		if (d < soft) {
			const a = (d - hard) / (soft - hard);
			img.data[i + 3] = Math.round(img.data[i + 3] * a);
			// Despill: pull green down to the mean of the others on the fringe.
			const m = (r + b) / 2;
			img.data[i + 1] = Math.round(g * a + m * (1 - a));
		}
	}

	fs.writeFileSync(file, encodePng(img, { text: img.text && Object.keys(img.text).length > 0 ? img.text : null }));
	return keyed / (img.data.length / 4);
}

/** The plan for one plate: its prompt, its size, whether it is keyed, and its crop. */
interface PlatePlan {
	readonly region: SpecRegion;
	readonly spec: CompSpec;
	readonly ref: Image;
	readonly refPath: string;
	readonly out: string;
	readonly size: string;
	readonly prompt: string;
	/** The key colour when the plate is generated on a flat background, else null. */
	readonly chroma: string | null;
}

/** The flat-key instruction appended to a plate prompt when the artwork must be keyed to alpha. */
const CHROMA_LINE = (color: string) =>
	` Render the artwork on a perfectly flat, uniform bright green background (${color}) that fills every pixel not covered by the artwork; no paper texture, no vignette, no shadow on the green; the green will be removed and the artwork composited onto the page's own surface.`;

/**
 * Plan a plate: crop the region out of the comp as the reference, choose the closest supported size,
 * and build the prompt.
 *
 * The plates gate demands at least 1.5× the region's width (capped at 1536), so a square region wider
 * than 682px cannot ship from a 1024 frame: the 1536-wide landscape frame is taken instead and cover
 * crops the rest.
 */
function planPlate({
	spec,
	region,
	out = null,
	size = null,
	extra = "",
	chroma = null,
	refDir = null,
}: {
	readonly spec: CompSpec;
	readonly region: SpecRegion;
	readonly out?: string | null;
	readonly size?: string | null;
	readonly extra?: string;
	readonly chroma?: boolean | null;
	readonly refDir?: string | null;
}): PlatePlan {
	if (region.medium !== "raster") throw new Error(`generate-image: region ${region.id} is ${region.medium}, not a plate; set its kind to plate|image|texture in the regions file`);

	const comp = loadRaster(spec.comp).image;
	const ref = plateReference(comp, spec, region);
	const refPath = path.join(refDir ?? path.join(".impeccable", "build"), "crops", `${region.id}.png`);
	fs.mkdirSync(path.dirname(refPath), { recursive: true });
	fs.writeFileSync(refPath, encodePng(ref, { text: { "impeccable:crop-of": `${spec.comp}#${region.id}` } }));

	const chosenOut = out ?? region.plate;
	if (!chosenOut) throw new Error(`generate-image: region ${region.id} has no plate path; pass --out`);
	fs.mkdirSync(path.dirname(chosenOut), { recursive: true });

	// The closest supported size to the region's aspect; the page crops the rest with object-fit.
	const aspect = region.px.w / region.px.h;
	const needW = Math.min(1536, Math.ceil(region.px.w * 1.5));
	let chosenSize = size;
	if (!chosenSize) {
		if (aspect > 1.2) chosenSize = "1536x1024";
		else if (aspect < 0.83) chosenSize = needW > 1024 ? "1536x1024" : "1024x1536";
		else chosenSize = needW > 1024 ? "1536x1024" : "1024x1024";
	}

	// Chroma keys a line drawing or figure on flat ground so the page's own ground shows through
	// instead of a second, mismatched paper. Default on for a plate whose comp crop reads as ink over
	// one flat ground.
	const wantsChroma = chroma ?? (region.kind === "plate" && inkOnGround(region));
	const chromaColor = "#00ff00";
	const prompt = [platePromptFor(spec, region), extra, wantsChroma ? CHROMA_LINE(chromaColor) : ""].filter(Boolean).join(" ");

	return { region, spec, ref, refPath, out: chosenOut, size: chosenSize, prompt, chroma: wantsChroma ? chromaColor : null };
}

/** The plate prompt, imported lazily through the spec module's own export. */
function platePromptFor(spec: CompSpec, region: SpecRegion): string {
	// Kept as a thin indirection so a caller can substitute spec text without touching the plan.
	return buildPlatePrompt(spec, region);
}

/** The regeneration prompt for a raster region. */
function buildPlatePrompt(spec: CompSpec, region: SpecRegion): string {
	const world = spec.palette.slice(0, 3).map((c) => c.hex).join(", ");
	const kindLine =
		region.kind === "texture"
			? "This is a seamless surface texture. Output a tileable texture plate with no objects, no text, no vignette."
			: region.kind === "image"
				? "This is a photographic or illustrated image region. Output the same subject, same framing, same lighting."
				: "This is a designed illustration plate. Output the same drawing, same style, same line weight and shading.";

	return [
		"Use the provided crop as the approved visual reference and recreate it as a clean production asset at the target aspect ratio.",
		kindLine,
		`Preserve silhouette, composition, perspective, palette (${world}), lighting, material, and texture exactly.`,
		"Remove every piece of UI text, label, caption, button, and interface chrome that is not part of the artwork itself.",
		"Remove letterboxing, borders, card corners, drop shadows, and any layout background that the page will draw in code.",
		"Do not add objects. Do not change the concept. Do not restyle. The artwork fills the whole frame edge to edge at the same scale as the reference; no margins, no border, no background band.",
		region.note ? `Region: ${region.note}.` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/** Score a produced plate against its crop, the way it will show under `object-fit: cover`. */
function scorePlate(plan: PlatePlan, outFile: string = plan.out): { text: string; score: ReturnType<typeof plateVerdict>; overall: number } {
	let plate: Image & { text?: Record<string, string> } = decodePng(fs.readFileSync(outFile));

	// A keyed plate ships over the page ground, so it is composited over the region's sampled ground
	// before scoring.
	if (plan.chroma) {
		const g = plan.region.palette?.[0]?.hex || "#ffffff";
		const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(g);
		const ground: [number, number, number, number] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255] : [255, 255, 255, 255];
		const over = createImage(plate.width, plate.height, ground);
		blit(over, plate, 0, 0);
		plate = over as Image & { text?: Record<string, string> };
	}

	const res = compare({ comp: plan.ref, build: plate, align: "cover", kind: plan.region.kind });
	const s = res.whole;
	const line = `PLATE-SCORE ${plan.region.id} ${(s.overall * 100).toFixed(0)}% against the comp region (structure ${(s.structure * 100).toFixed(0)}%, color ${(s.color * 100).toFixed(0)}%, detail ${(s.detail * 100).toFixed(0)}%)`;
	const verdict = plateVerdict(plan.region, s);

	const warn = verdict.ok
		? ""
		: `PLATE-WARN the plate does not read as region ${plan.region.id}: ${verdict.reasons.join("; ")}. Open ${outFile} beside ${plan.refPath} and regenerate before building on it; the plates gate refuses it as it stands.`;

	return { text: [line, warn].filter(Boolean).join("\n"), score: verdict, overall: s.overall };
}

/**
 * Produce a plate with the deterministic stand-in: a 2× crop of the reference, keyed if the plan asks
 * for it, with the prompt embedded.
 *
 * This is what makes the whole concept-to-plate chain runnable with no key and no spend.
 */
function fakePlate(plan: PlatePlan): { out: string; width: number; height: number; text: string } {
	const up = resize(plan.ref, plan.ref.width * 2, plan.ref.height * 2);
	fs.writeFileSync(plan.out, encodePng(up, { text: { "impeccable:prompt": plan.prompt, "impeccable:fake": "1" } }));
	fs.writeFileSync(
		`${plan.out}.json`,
		JSON.stringify({ prompt: plan.prompt, createdAt: new Date().toISOString(), tool: "generate-image", model: "fake", plate: plan.region.id, refs: [plan.refPath] }, null, 2),
	);
	return { out: plan.out, width: up.width, height: up.height, text: `PLATE: ${plan.out} (${up.width}x${up.height}, fake 2x crop of region ${plan.region.id}, $0.00, no API call)` };
}

/** Produce a synthetic comp with the deterministic stand-in. */
function fakeComp(prompt: string, out: string, size: string | null = null): { out: string; width: number; height: number; text: string } {
	const dims = parseSize(size ?? "1536x1024");
	const bytes = out.endsWith(".svg") ? Buffer.from(svgFake(prompt, dims), "utf8") : pngFake(prompt, dims);
	fs.writeFileSync(out, bytes);
	return { out, width: dims[0], height: dims[1], text: `IMAGE: ${out} (${dims[0]}x${dims[1]}, fake synthetic comp, $0.00, no API call)` };
}

/**
 * Whether a comp may be written into the mocks directory right now.
 *
 * A comp written there while a direction is dealt but the build phases never started is a comp round
 * happening outside the state file, and every session cut after it resumes with no state to follow.
 */
function mockOutputAllowed({ out, cwd = process.cwd(), force = false }: { readonly out: string; readonly cwd?: string; readonly force?: boolean }): { ok: boolean; reason?: string } {
	const intoMocks = /(^|[\\/])\.impeccable[\\/]mocks[\\/]/.test(out) && !/[\\/]decision[\\/]/.test(out);
	if (intoMocks && !force && readBuildStatus(cwd).kind === "dealt") {
		return {
			ok: false,
			reason: "a direction was chosen but build-phase start has not run, so this comp would be generated outside the build's state. Run build-phase start --direction <seed key> --kind <assigned|pick|challenger|canon> first (it opens the comps phase), then generate. --force-mock overrides.",
		};
	}
	return { ok: true };
}

export {
	buildPlatePrompt,
	CHROMA_LINE,
	fakeComp,
	fakePlate,
	hash32,
	hexRgb,
	hslToRgb,
	inkOnGround,
	keyChroma,
	mockOutputAllowed,
	palette,
	parseSize,
	planPlate,
	pngFake,
	scorePlate,
	svgFake,
	toHex,
};
export type { PlatePlan };
