/**
 * Embed a generation prompt into an image, so the intent travels with the file across harnesses and
 * machines, and read it back. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Formats: PNG (a `tEXt` chunk keyed `impeccable:prompt`) and JPEG (a `COM` segment). WebP and
 * anything else fall back to a `<image>.json` sidecar, which the reader checks for every format so
 * the fallback stays recoverable.
 *
 * Worth knowing: image optimizers in a build pipeline often strip metadata from their output files.
 * The intent lives on the source asset, which is the one a builder reads.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const KEYWORD = "impeccable:prompt";

type ImageType = "png" | "jpeg" | null;

/** What a buffer starts as, or null for a format this module does not embed into. */
function imageType(buffer: Buffer): ImageType {
	if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
	if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
	return null;
}

const crcTable = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data: Buffer): number {
	let c = 0xffffffff;
	for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk with its length and CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
	return out;
}

interface PngChunkInfo {
	readonly offset: number;
	readonly type: string;
	readonly promptChunk: boolean;
	readonly bytes: Buffer;
}

/** Every chunk, with the ones carrying our keyword flagged, plus whatever prompt they hold. */
function parsePng(buffer: Buffer): { chunks: PngChunkInfo[]; prompt: string | null } {
	const chunks: PngChunkInfo[] = [];
	let prompt: string | null = null;
	let offset = 8;

	while (offset + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		const nul = data.indexOf(0);
		const promptChunk = (type === "tEXt" || type === "zTXt") && nul !== -1 && data.toString("latin1", 0, nul) === KEYWORD;

		if (prompt == null && promptChunk) {
			prompt = type === "tEXt" ? data.toString("utf8", nul + 1) : zlib.inflateSync(data.subarray(nul + 2)).toString("utf8");
		}

		chunks.push({ offset, type, promptChunk, bytes: buffer.subarray(offset, offset + 12 + length) });
		offset += 12 + length;
	}

	return { chunks, prompt };
}

/** The prompt from a JPEG's `COM` segment, if it is ours. */
function readJpegCom(buffer: Buffer): string | null {
	let offset = 2;
	while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
		const marker = buffer[offset + 1];
		if (marker === 0xda) break; // start of scan: no more segments
		const length = buffer.readUInt16BE(offset + 2);
		if (marker === 0xfe) {
			const text = buffer.toString("utf8", offset + 4, offset + 2 + length);
			if (text.startsWith(`${KEYWORD}\0`)) return text.slice(KEYWORD.length + 1);
		}
		offset += 2 + length;
	}
	return null;
}

/**
 * The prompt on an image: embedded when the format carries it, else the sidecar.
 *
 * The sidecar is checked for every format, not only the ones that cannot embed, so a file whose
 * metadata a pipeline stripped still reads back.
 */
function readPrompt(imagePath: string, buffer: Buffer = fs.readFileSync(imagePath)): string | null {
	const type = imageType(buffer);
	let prompt = type === "png" ? parsePng(buffer).prompt : type === "jpeg" ? readJpegCom(buffer) : null;
	if (prompt == null && fs.existsSync(`${imagePath}.json`)) {
		try {
			prompt = (JSON.parse(fs.readFileSync(`${imagePath}.json`, "utf8")) as { prompt?: string | null }).prompt ?? null;
		} catch {
			// Stays null.
		}
	}
	return prompt;
}

/**
 * Embed a prompt into an image, returning a sentence describing what was written.
 *
 * Embedding into a PNG or JPEG rewrites the file in place; anything else gets a sidecar, because
 * guessing a private metadata format for an arbitrary container is how a reader stops agreeing with
 * a writer.
 */
function embedPrompt(imagePath: string, prompt: string): { path: string; kind: "png" | "jpeg" | "sidecar"; note: string } {
	const buffer = fs.readFileSync(imagePath);
	const type = imageType(buffer);

	if (type === "png") {
		// Insert or replace our chunk immediately before IEND, dropping any earlier one so embedding
		// is idempotent.
		const { chunks, prompt: existing } = parsePng(buffer);
		const iend = chunks.find((chunk) => chunk.type === "IEND")?.offset ?? -1;
		if (iend < 8) throw new Error("embed-prompt: malformed PNG");

		const replacing = existing != null;
		const body = replacing
			? Buffer.concat(chunks.filter((chunk) => chunk.offset < iend && !chunk.promptChunk).map((chunk) => chunk.bytes))
			: buffer.subarray(8, iend);
		const promptChunk = pngChunk("tEXt", Buffer.concat([Buffer.from(KEYWORD, "latin1"), Buffer.from([0]), Buffer.from(prompt, "utf8")]));
		const end = replacing ? pngChunk("IEND", Buffer.alloc(0)) : buffer.subarray(iend);

		fs.writeFileSync(imagePath, Buffer.concat([buffer.subarray(0, 8), body, promptChunk, end]));
		return { path: imagePath, kind: "png", note: `EMBEDDED: ${imagePath} (png tEXt, ${prompt.length} chars)` };
	}

	if (type === "jpeg") {
		const seg = Buffer.from(`${KEYWORD}\0${prompt}`, "utf8");
		if (seg.length + 2 > 0xffff) throw new Error("embed-prompt: prompt too long for a JPEG segment");
		const com = Buffer.alloc(4 + seg.length);
		com[0] = 0xff;
		com[1] = 0xfe;
		com.writeUInt16BE(seg.length + 2, 2);
		seg.copy(com, 4);

		fs.writeFileSync(imagePath, Buffer.concat([buffer.subarray(0, 2), com, buffer.subarray(2)]));
		return { path: imagePath, kind: "jpeg", note: `EMBEDDED: ${imagePath} (jpeg COM, ${prompt.length} chars)` };
	}

	const sidecar = `${imagePath}.json`;
	fs.writeFileSync(sidecar, JSON.stringify({ prompt, createdAt: new Date().toISOString() }, null, 2));
	return { path: sidecar, kind: "sidecar", note: `EMBEDDED: ${sidecar} (sidecar fallback for this format)` };
}

/** Rasters under the given paths that carry no prompt. */
function scanForMissingPrompts(targets: readonly string[]): { rasters: string[]; missing: string[] } {
	const RASTER = /\.(png|jpe?g|webp)$/i;
	const rasters: string[] = [];

	const walk = (p: string, isRoot: boolean) => {
		const stat = fs.statSync(p);
		if (stat.isDirectory()) {
			const base = p.replace(/\/+$/, "").split("/").pop() ?? "";
			// Skip installed deps and hidden dirs found during the walk, but honor a hidden dir the
			// caller passed explicitly.
			if (!isRoot && (base === "node_modules" || base.startsWith("."))) return;
			for (const entry of fs.readdirSync(p)) walk(`${p.replace(/\/+$/, "")}/${entry}`, false);
		} else if (RASTER.test(p)) {
			rasters.push(p);
		}
	};

	for (const target of targets) walk(target, true);
	const missing = rasters.filter((raster) => readPrompt(raster) == null);
	return { rasters, missing };
}

export { embedPrompt, imageType, KEYWORD, parsePng, pngChunk, readJpegCom, readPrompt, scanForMissingPrompts };
