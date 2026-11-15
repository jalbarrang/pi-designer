/**
 * PNG decoding and encoding for the comp pipeline, and the loader that reads any raster the
 * pipeline meets. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * The decoder handles every colour type, bit depths 1 to 16, and Adam7 interlacing, because a comp
 * arrives as whatever the designer exported. The encoder writes one filter type on every row and
 * takes an optional tEXt map, since comps and screenshots compress fine either way and a trivial
 * encoder is one that cannot be subtly wrong.
 *
 * Conversion of non-PNG input is a host surface: `loadRaster` takes a converter instead of
 * searching PATH itself, so a caller decides what it is willing to shell out to.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import type { Image } from "./raster.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** True when the buffer starts with the PNG signature. A null buffer returns null, as upstream does. */
function isPng(buf: Buffer | Uint8Array | null | undefined): boolean {
	return (buf && buf.length > 8 && Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE)) as boolean;
}

interface Chunk {
	readonly type: string;
	readonly data: Buffer;
}

function readChunks(buf: Buffer): Chunk[] {
	const chunks: Chunk[] = [];
	let pos = 8;
	while (pos + 8 <= buf.length) {
		const length = buf.readUInt32BE(pos);
		const type = buf.toString("latin1", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + length);
		chunks.push({ type, data });
		pos += 12 + length;
		if (type === "IEND") break;
	}
	return chunks;
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/** Unfilter one pass of scanlines; returns the raw bytes plus how much of the input they used. */
function unfilter(
	raw: Buffer | Uint8Array,
	width: number,
	height: number,
	bpp: number,
	bitDepth: number,
	channels: number,
): { bytes: Uint8Array; stride: number; consumed: number } {
	const stride = Math.ceil((width * channels * bitDepth) / 8);
	const out = new Uint8Array(stride * height);
	let inPos = 0;
	let prev: Uint8Array | null = null;

	for (let y = 0; y < height; y++) {
		const filter = raw[inPos++];
		const line = out.subarray(y * stride, (y + 1) * stride);
		line.set(raw.subarray(inPos, inPos + stride));
		inPos += stride;

		switch (filter) {
			case 0:
				break;
			case 1:
				for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
				break;
			case 2:
				if (prev) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
				break;
			case 3:
				for (let i = 0; i < stride; i++) {
					const left = i >= bpp ? line[i - bpp] : 0;
					const up = prev ? prev[i] : 0;
					line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
				}
				break;
			case 4:
				for (let i = 0; i < stride; i++) {
					const left = i >= bpp ? line[i - bpp] : 0;
					const up = prev ? prev[i] : 0;
					const ul = prev && i >= bpp ? prev[i - bpp] : 0;
					line[i] = (line[i] + paeth(left, up, ul)) & 0xff;
				}
				break;
			default:
				throw new Error(`png: unknown filter ${filter} on row ${y}`);
		}
		prev = line;
	}
	return { bytes: out, stride, consumed: inPos };
}

/** Read sample `index` (0-based across the row) from a packed scanline. */
function sampleReader(bitDepth: number): (line: Uint8Array, i: number) => number {
	if (bitDepth === 8) return (line, i) => line[i];
	if (bitDepth === 16) return (line, i) => line[i * 2]; // high byte
	const perByte = 8 / bitDepth;
	const mask = (1 << bitDepth) - 1;
	const scale = 255 / mask;
	return (line, i) => {
		const byte = line[(i / perByte) | 0];
		const shift = 8 - bitDepth * ((i % perByte) + 1);
		return Math.round(((byte >> shift) & mask) * scale);
	};
}

/** A palette entry filter's transparency, or a single transparent grey level. */
interface Transparency {
	readonly alpha?: Buffer;
	readonly gray?: number;
}

function writePixels(
	dst: Uint8Array,
	dstWidth: number,
	bytes: Uint8Array,
	stride: number,
	passWidth: number,
	passHeight: number,
	colorType: number,
	bitDepth: number,
	palette: Buffer | null,
	trns: Transparency | null,
	mapX: (x: number) => number,
	mapY: (y: number) => number,
): number {
	const channels = CHANNELS[colorType];
	const read = sampleReader(bitDepth);
	const rawIndex =
		bitDepth < 8
			? (line: Uint8Array, i: number) => {
					const perByte = 8 / bitDepth;
					const mask = (1 << bitDepth) - 1;
					const byte = line[(i / perByte) | 0];
					const shift = 8 - bitDepth * ((i % perByte) + 1);
					return (byte >> shift) & mask;
				}
			: read;

	for (let y = 0; y < passHeight; y++) {
		const line = bytes.subarray(y * stride, (y + 1) * stride);
		const dy = mapY(y);
		for (let x = 0; x < passWidth; x++) {
			const dx = mapX(x);
			const o = (dy * dstWidth + dx) * 4;
			let r: number;
			let g: number;
			let b: number;
			let a = 255;

			switch (colorType) {
				case 0: {
					r = g = b = read(line, x);
					if (trns && trns.gray === rawIndex(line, x)) a = 0;
					break;
				}
				case 2: {
					r = read(line, x * 3);
					g = read(line, x * 3 + 1);
					b = read(line, x * 3 + 2);
					break;
				}
				case 3: {
					const idx = rawIndex(line, x);
					const pal = palette as Buffer;
					r = pal[idx * 3];
					g = pal[idx * 3 + 1];
					b = pal[idx * 3 + 2];
					if (trns?.alpha && idx < trns.alpha.length) a = trns.alpha[idx];
					break;
				}
				case 4: {
					r = g = b = read(line, x * 2);
					a = read(line, x * 2 + 1);
					break;
				}
				case 6: {
					r = read(line, x * 4);
					g = read(line, x * 4 + 1);
					b = read(line, x * 4 + 2);
					a = read(line, x * 4 + 3);
					break;
				}
				default:
					throw new Error(`png: unsupported color type ${colorType}`);
			}

			dst[o] = r;
			dst[o + 1] = g;
			dst[o + 2] = b;
			dst[o + 3] = a;
		}
	}
	return channels;
}

/** A decoded raster: RGBA pixels plus any tEXt metadata. */
interface DecodedPng extends Image {
	readonly text: Record<string, string>;
}

/** Decode a PNG of any colour type, bit depth or interlacing into RGBA. */
function decodePng(buf: Buffer): DecodedPng {
	if (!isPng(buf)) throw new Error("png: not a PNG (bad signature)");

	const chunks = readChunks(buf);
	const ihdr = chunks.find((c) => c.type === "IHDR");
	if (!ihdr) throw new Error("png: missing IHDR");

	const width = ihdr.data.readUInt32BE(0);
	const height = ihdr.data.readUInt32BE(4);
	const bitDepth = ihdr.data[8];
	const colorType = ihdr.data[9];
	const interlace = ihdr.data[12];
	const channels = CHANNELS[colorType];
	if (!channels) throw new Error(`png: unsupported color type ${colorType}`);

	const palChunk = chunks.find((c) => c.type === "PLTE");
	const palette = palChunk ? palChunk.data : null;

	const trnsChunk = chunks.find((c) => c.type === "tRNS");
	let trns: Transparency | null = null;
	if (trnsChunk) {
		if (colorType === 3) trns = { alpha: trnsChunk.data };
		else if (colorType === 0) trns = { gray: trnsChunk.data.readUInt16BE(0) >> (bitDepth === 16 ? 8 : 0) };
	}

	const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
	const raw = zlib.inflateSync(idat);
	const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
	const data = new Uint8Array(width * height * 4);

	const text: Record<string, string> = {};
	for (const c of chunks) {
		if (c.type !== "tEXt") continue;
		const z = c.data.indexOf(0);
		if (z > 0) text[c.data.toString("latin1", 0, z)] = c.data.toString("utf8", z + 1);
	}

	if (interlace === 0) {
		const { bytes, stride } = unfilter(raw, width, height, bpp, bitDepth, channels);
		writePixels(data, width, bytes, stride, width, height, colorType, bitDepth, palette, trns, (x) => x, (y) => y);
	} else {
		// Adam7: seven passes, each its own filtered grid.
		const passes: ReadonlyArray<readonly [number, number, number, number]> = [
			[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
		];
		let offset = 0;
		for (const [sx, sy, dx, dy] of passes) {
			const pw = Math.ceil((width - sx) / dx);
			const ph = Math.ceil((height - sy) / dy);
			if (pw <= 0 || ph <= 0) continue;
			const { bytes, stride, consumed } = unfilter(raw.subarray(offset), pw, ph, bpp, bitDepth, channels);
			offset += consumed;
			writePixels(data, width, bytes, stride, pw, ph, colorType, bitDepth, palette, trns, (x) => sx + x * dx, (y) => sy + y * dy);
		}
	}

	return { width, height, data, text };
}

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode RGBA8 to PNG. `text` becomes tEXt keyword/value pairs.
 *
 * Every row uses filter type 0: comps and screenshots compress fine and the encoder stays trivial.
 */
function encodePng({ width, height, data }: Image, { text = null, level = 6 }: { readonly text?: Record<string, string> | null; readonly level?: number } = {}): Buffer {
	if (data.length !== width * height * 4) throw new Error(`png: data length ${data.length} != ${width}x${height}x4`);

	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const parts: Buffer[] = [SIGNATURE, chunk("IHDR", ihdr)];
	if (text) {
		for (const [k, v] of Object.entries(text)) {
			parts.push(chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(String(v), "utf8")])));
		}
	}
	parts.push(chunk("IDAT", zlib.deflateSync(raw, { level })));
	parts.push(chunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
}

/** A converter invocation: a command and its arguments. */
type ConverterArgs = readonly [command: string, args: readonly string[]];

/** The converters tried, in order, when a raster is not already a PNG. */
const CONVERTERS: readonly ConverterArgs[] = [
	["dwebp", ["{src}", "-o", "{dst}"]],
	["sips", ["-s", "format", "png", "{src}", "--out", "{dst}"]],
	["magick", ["{src}", "{dst}"]],
	["convert", ["{src}", "{dst}"]],
];

/**
 * Read any raster the comp pipeline meets as RGBA: PNG natively, anything else through a
 * converter.
 *
 * Non-PNG input is converted to a sibling cache file `<name>.<ext>.png`, never in place: a session
 * that overwrites `comp.webp` with PNG bytes leaves a file the next tool cannot trust and a replay
 * cannot reconstruct.
 */
function loadRaster(file: string, { converters = CONVERTERS }: { readonly converters?: readonly ConverterArgs[] } = {}): { image: DecodedPng; path: string } {
	const buf = fs.readFileSync(file);
	if (isPng(buf)) return { image: decodePng(buf), path: file };

	const cache = `${file}.png`;
	if (fs.existsSync(cache)) {
		try {
			const cached = fs.readFileSync(cache);
			if (isPng(cached)) return { image: decodePng(cached), path: cache };
		} catch {
			// Fall through and reconvert.
		}
	}

	let lastErr: Error | null = null;
	for (const [command, args] of converters) {
		try {
			execFileSync(command, args.map((arg) => arg.replace("{src}", file).replace("{dst}", cache)), { stdio: "ignore" });
			const converted = fs.readFileSync(cache);
			if (isPng(converted)) return { image: decodePng(converted), path: cache };
		} catch (error) {
			lastErr = error as Error;
		}
	}

	throw new Error(`png: ${file} is not a PNG and no converter (${converters.map(([c]) => c).join(", ")}) could produce ${cache}${lastErr ? `: ${lastErr.message}` : ""}`);
}

export { CONVERTERS, crc32, decodePng, encodePng, isPng, loadRaster, readChunks, unfilter };export type { Chunk, DecodedPng, Transparency };
