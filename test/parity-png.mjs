/**
 * Parity check: PNG decoding and encoding against the reference.
 *
 * A comp pipeline reads whatever a designer exported, so the decoder's colour types, bit depths and
 * interlacing are the risk: a wrong sample reader shifts every pixel and every downstream metric.
 * These comparisons build the same rasters through both encoders and decode both, then re-encode
 * and decode again so the round trip is compared, not just the first read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const port = await import("../extensions/designer/engine/lib/png.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/png.mjs");
const raster = await import("../extensions/designer/engine/lib/raster.ts");

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

const digest = (image) => ({ width: image.width, height: image.height, sha: createHash("sha256").update(Buffer.from(image.data)).digest("hex").slice(0, 16) });

/** A deterministic RGBA image with a transparent corner and a gradient. */
function sample(width, height) {
	const img = raster.createImage(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			img.data[o] = (x * 255) / Math.max(1, width - 1);
			img.data[o + 1] = (y * 255) / Math.max(1, height - 1);
			img.data[o + 2] = (x * y) % 256;
			img.data[o + 3] = x < width / 3 ? 255 : 200;
		}
	}
	return img;
}

check("SIGNATURE recognition", port.isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), ref.isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])));
check("isPng(non-png)", port.isPng(Buffer.from("not a png at all")), ref.isPng(Buffer.from("not a png at all")));
check("isPng(short)", port.isPng(Buffer.from([0x89, 0x50])), ref.isPng(Buffer.from([0x89, 0x50])));
check("isPng(null)", port.isPng(null), ref.isPng(null));

// ─── encode then decode, both directions ────────────────────────────
for (const [w, h] of [[1, 1], [7, 5], [64, 48], [256, 3]]) {
	const img = sample(w, h);
	const portPng = port.encodePng(img);
	const refPng = ref.encodePng(img);
	check(`encodePng(${w}×${h}) is byte-identical`, portPng.equals(refPng), true);
	check(`decodePng(port, ${w}×${h})`, digest(port.decodePng(portPng)), digest(ref.decodePng(refPng)));
	check(`decodePng(cross-decoded, ${w}×${h})`, digest(port.decodePng(refPng)), digest(ref.decodePng(portPng)));
}

// Metadata survives a round trip.
check(
	"encodePng(tEXt) decodes its text",
	port.decodePng(port.encodePng(sample(4, 4), { text: { Source: "comp.webp", Region: "hero" } })).text,
	ref.decodePng(ref.encodePng(sample(4, 4), { text: { Source: "comp.webp", Region: "hero" } })).text,
);
check(
	"encodePng(compression level)",
	port.encodePng(sample(32, 32), { level: 0 }).length,
	ref.encodePng(sample(32, 32), { level: 0 }).length,
);
check(
	"encodePng(wrong data length throws)",
	(() => {
		try {
			return port.encodePng({ width: 4, height: 4, data: new Uint8Array(4) });
		} catch (error) {
			return String(error.message);
		}
	})(),
	(() => {
		try {
			return ref.encodePng({ width: 4, height: 4, data: new Uint8Array(4) });
		} catch (error) {
			return String(error.message);
		}
	})(),
);

// ─── the awkward parts of the format ────────────────────────────────
/**
 * A hand-built PNG, so colour types, bit depths and interlacing the encoder never produces are
 * still exercised. Lifted to the same shape the reference expects.
 */
function buildPng({ width, height, bitDepth, colorType, interlace = 0, palette = null, trns = null, passes }) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, "latin1");
		const crc = Buffer.alloc(4);
		// The reference's crc32 is private, so the table is rebuilt here from the spec polynomial.
		crc.writeUInt32BE(crc32Of(Buffer.concat([typeBuf, data])), 0);
		return Buffer.concat([len, typeBuf, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = interlace;
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
	if (palette) parts.push(chunk("PLTE", palette));
	if (trns) parts.push(chunk("tRNS", trns));
	parts.push(chunk("IDAT", zlib.deflateSync(passes)));
	parts.push(chunk("IEND", Buffer.alloc(0)));
	return Buffer.concat(parts);
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
function crc32Of(data) {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Unfiltered scanlines: filter byte 0 then the row bytes. */
const rows = (height, rowBytes) => {
	const parts = [];
	for (let y = 0; y < height; y++) parts.push(Buffer.from([0]), Buffer.from(rowBytes(y)));
	return Buffer.concat(parts);
};

const formatCases = {
	grayscale8: buildPng({ width: 4, height: 3, bitDepth: 8, colorType: 0, passes: rows(3, () => [0, 85, 170, 255]) }),
	grayscale1: buildPng({ width: 8, height: 2, bitDepth: 1, colorType: 0, passes: rows(2, () => [0b10101010]) }),
	grayscale4: buildPng({ width: 4, height: 2, bitDepth: 4, colorType: 0, passes: rows(2, () => [0x1f, 0x8c]) }),
	grayscale16: buildPng({ width: 2, height: 2, bitDepth: 16, colorType: 0, passes: rows(2, () => [0x12, 0x34, 0xab, 0xcd]) }),
	rgb8: buildPng({ width: 2, height: 2, bitDepth: 8, colorType: 2, passes: rows(2, () => [255, 0, 0, 0, 255, 0]) }),
	rgba8: buildPng({ width: 2, height: 2, bitDepth: 8, colorType: 6, passes: rows(2, () => [255, 0, 0, 255, 0, 0, 255, 128]) }),
	rgba16: buildPng({ width: 1, height: 2, bitDepth: 16, colorType: 6, passes: rows(2, () => [0xff, 0xff, 0x00, 0x00, 0x12, 0x34, 0xff, 0xff]) }),
	grayscaleAlpha: buildPng({ width: 2, height: 2, bitDepth: 8, colorType: 4, passes: rows(2, () => [90, 255, 180, 128]) }),
	paletted: buildPng({
		width: 3,
		height: 2,
		bitDepth: 8,
		colorType: 3,
		palette: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
		passes: rows(2, () => [0, 1, 2]),
	}),
	palettedWithAlpha: buildPng({
		width: 3,
		height: 1,
		bitDepth: 8,
		colorType: 3,
		palette: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
		trns: Buffer.from([255, 128, 0]),
		passes: rows(1, () => [0, 1, 2]),
	}),
	grayscaleTransparent: buildPng({ width: 2, height: 1, bitDepth: 8, colorType: 0, trns: Buffer.from([0, 85]), passes: rows(1, () => [85, 200]) }),
	// Adam7 needs every pass present, so the interlaced fixture is a full 8×8 grid.
	interlaced: (() => {
		const width = 8;
		const height = 8;
		const passes = [
			[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
		];
		const parts = [];
		for (const [sx, sy, dx, dy] of passes) {
			const pw = Math.ceil((width - sx) / dx);
			const ph = Math.ceil((height - sy) / dy);
			if (pw <= 0 || ph <= 0) continue;
			for (let y = 0; y < ph; y++) {
				parts.push(Buffer.from([0]));
				const row = Buffer.alloc(pw * 4);
				for (let x = 0; x < pw; x++) {
					row[x * 4] = (sx + x * dx) * 30;
					row[x * 4 + 1] = (sy + y * dy) * 30;
					row[x * 4 + 2] = 128;
					row[x * 4 + 3] = 255;
				}
				parts.push(row);
			}
		}
		return buildPng({ width, height, bitDepth: 8, colorType: 6, interlace: 1, passes: Buffer.concat(parts) });
	})(),
};

for (const [name, buf] of Object.entries(formatCases)) {
	let portResult;
	let refResult;
	try {
		portResult = digest(port.decodePng(buf));
	} catch (error) {
		portResult = String(error.message);
	}
	try {
		refResult = digest(ref.decodePng(buf));
	} catch (error) {
		refResult = String(error.message);
	}
	check(`decodePng(${name})`, portResult, refResult);
}

// Every filter type, since the encoder only ever writes 0.
for (const filter of [0, 1, 2, 3, 4]) {
	const width = 6;
	const height = 4;
	const stride = width * 4;
	const parts = [];
	for (let y = 0; y < height; y++) {
		parts.push(Buffer.from([filter]));
		parts.push(Buffer.from(Array.from({ length: stride }, (_, i) => (i * 7 + y * 11) % 256)));
	}
	const buf = buildPng({ width, height, bitDepth: 8, colorType: 6, passes: Buffer.concat(parts) });
	let portResult;
	let refResult;
	try {
		portResult = digest(port.decodePng(buf));
	} catch (error) {
		portResult = String(error.message);
	}
	try {
		refResult = digest(ref.decodePng(buf));
	} catch (error) {
		refResult = String(error.message);
	}
	check(`decodePng(filter ${filter})`, portResult, refResult);
}

// Malformed input reports the same way.
check(
	"decodePng(not a png) throws",
	(() => {
		try {
			return port.decodePng(Buffer.from("nope"));
		} catch (error) {
			return String(error.message);
		}
	})(),
	(() => {
		try {
			return ref.decodePng(Buffer.from("nope"));
		} catch (error) {
			return String(error.message);
		}
	})(),
);

// ─── loading from disk ──────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-png-"));
try {
	const pngPath = path.join(dir, "comp.png");
	fs.writeFileSync(pngPath, port.encodePng(sample(9, 7), { text: { Source: "test" } }));
	check("loadRaster(png)", { ...digest(port.loadRaster(pngPath).image), path: port.loadRaster(pngPath).path }, { ...digest(ref.loadRaster(pngPath).image), path: ref.loadRaster(pngPath).path });

	// A non-PNG with a converter the caller supplies: the pipeline never rewrites the source.
	const notPng = path.join(dir, "comp.webp");
	fs.writeFileSync(notPng, Buffer.from("pretend webp bytes"));
	const converter = ["node", ["-e", `require('node:fs').writeFileSync(${JSON.stringify(`${notPng}.png`)}, require('node:fs').readFileSync(${JSON.stringify(pngPath)}))`]];
	const loaded = port.loadRaster(notPng, { converters: [converter] });
	check("loadRaster(converted) decodes", digest(loaded.image), digest(port.loadRaster(pngPath).image));
	check("loadRaster(converted) reads the cache", loaded.path, `${notPng}.png`);
	check("loadRaster(converted) leaves the source alone", fs.readFileSync(notPng, "utf8"), "pretend webp bytes");
	check(
		"loadRaster(no converter) throws",
		(() => {
			try {
				fs.writeFileSync(path.join(dir, "other.webp"), Buffer.from("also not a png"));
				return port.loadRaster(path.join(dir, "other.webp"), { converters: [["definitely-not-a-command", ["{src}", "{dst}"]]] });
			} catch (error) {
				return String(error.message).startsWith("png:");
			}
		})(),
		true,
	);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} PNG comparisons failed`);
	process.exit(1);
}
console.log(`png parity: ${comparisons} comparisons match the reference`);
