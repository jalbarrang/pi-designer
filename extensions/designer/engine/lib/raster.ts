/**
 * The small RGBA raster toolkit the fidelity scripts share: crop, resize (area-averaged down,
 * bilinear up), composite, fills, rectangles, and a bitmap-font label so composites can be
 * captioned without a font stack. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * An image is `{ width, height, data }` with RGBA8 data.
 */

/** An RGBA8 image. */
export interface Image {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

/** A colour as four 0–255 channels. */
type Rgba = readonly [number, number, number, number] | readonly number[];

function createImage(width: number, height: number, fill: Rgba = [0, 0, 0, 0]): Image {
	const data = new Uint8Array(width * height * 4);
	if (fill[0] || fill[1] || fill[2] || fill[3]) {
		for (let i = 0; i < data.length; i += 4) {
			data[i] = fill[0];
			data[i + 1] = fill[1];
			data[i + 2] = fill[2];
			data[i + 3] = fill[3];
		}
	}
	return { width, height, data };
}

/** A rectangle clipped to the image bounds. */
interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

function clampRect(img: Image, x: number, y: number, w: number, h: number): Rect {
	const x0 = Math.max(0, Math.min(img.width, Math.round(x)));
	const y0 = Math.max(0, Math.min(img.height, Math.round(y)));
	const x1 = Math.max(x0, Math.min(img.width, Math.round(x + w)));
	const y1 = Math.max(y0, Math.min(img.height, Math.round(y + h)));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function crop(img: Image, x: number, y: number, w: number, h: number): Image {
	const r = clampRect(img, x, y, w, h);
	const out = createImage(Math.max(1, r.w), Math.max(1, r.h));
	for (let yy = 0; yy < r.h; yy++) {
		const src = ((r.y + yy) * img.width + r.x) * 4;
		out.data.set(img.data.subarray(src, src + r.w * 4), yy * out.width * 4);
	}
	return out;
}

/** Resize with area averaging when shrinking and bilinear when growing. */
function resize(img: Image, width: number, height: number): Image {
	const targetWidth = Math.max(1, Math.round(width));
	const targetHeight = Math.max(1, Math.round(height));
	if (targetWidth === img.width && targetHeight === img.height) {
		return { width: targetWidth, height: targetHeight, data: new Uint8Array(img.data) };
	}

	const out = createImage(targetWidth, targetHeight);
	const sx = img.width / targetWidth;
	const sy = img.height / targetHeight;

	if (sx >= 1 && sy >= 1) {
		for (let y = 0; y < targetHeight; y++) {
			const y0 = Math.floor(y * sy);
			const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
			for (let x = 0; x < targetWidth; x++) {
				const x0 = Math.floor(x * sx);
				const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));

				let r = 0;
				let g = 0;
				let b = 0;
				let a = 0;
				let n = 0;
				for (let yy = y0; yy < y1; yy++) {
					let p = (yy * img.width + x0) * 4;
					for (let xx = x0; xx < x1; xx++, p += 4) {
						r += img.data[p];
						g += img.data[p + 1];
						b += img.data[p + 2];
						a += img.data[p + 3];
						n++;
					}
				}

				const o = (y * targetWidth + x) * 4;
				out.data[o] = r / n;
				out.data[o + 1] = g / n;
				out.data[o + 2] = b / n;
				out.data[o + 3] = a / n;
			}
		}
		return out;
	}

	for (let y = 0; y < targetHeight; y++) {
		const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
		const y0 = Math.max(0, Math.floor(fy));
		const y1 = Math.min(img.height - 1, y0 + 1);
		const wy = fy - y0;

		for (let x = 0; x < targetWidth; x++) {
			const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
			const x0 = Math.max(0, Math.floor(fx));
			const x1 = Math.min(img.width - 1, x0 + 1);
			const wx = fx - x0;
			const o = (y * targetWidth + x) * 4;

			for (let c = 0; c < 4; c++) {
				const p00 = img.data[(y0 * img.width + x0) * 4 + c];
				const p10 = img.data[(y0 * img.width + x1) * 4 + c];
				const p01 = img.data[(y1 * img.width + x0) * 4 + c];
				const p11 = img.data[(y1 * img.width + x1) * 4 + c];
				out.data[o + c] = (p00 * (1 - wx) + p10 * wx) * (1 - wy) + (p01 * (1 - wx) + p11 * wx) * wy;
			}
		}
	}
	return out;
}

/** Scale to fit inside (maxW × maxH) preserving aspect; never upscales unless asked. */
function fit(img: Image, maxW: number, maxH: number, allowUpscale = false): Image {
	const s = Math.min(maxW / img.width, maxH / img.height);
	if (s >= 1 && !allowUpscale) return img;
	return resize(img, img.width * s, img.height * s);
}

/** Alpha-composite `src` onto `dst` at (x, y). */
function blit(dst: Image, src: Image, x: number, y: number): void {
	const originX = Math.round(x);
	const originY = Math.round(y);

	for (let yy = 0; yy < src.height; yy++) {
		const dy = originY + yy;
		if (dy < 0 || dy >= dst.height) continue;
		for (let xx = 0; xx < src.width; xx++) {
			const dx = originX + xx;
			if (dx < 0 || dx >= dst.width) continue;

			const s = (yy * src.width + xx) * 4;
			const d = (dy * dst.width + dx) * 4;
			const a = src.data[s + 3] / 255;

			if (a >= 1) {
				dst.data[d] = src.data[s];
				dst.data[d + 1] = src.data[s + 1];
				dst.data[d + 2] = src.data[s + 2];
				dst.data[d + 3] = 255;
				continue;
			}
			if (a <= 0) continue;

			const da = dst.data[d + 3] / 255;
			const oa = a + da * (1 - a);
			for (let c = 0; c < 3; c++) dst.data[d + c] = (src.data[s + c] * a + dst.data[d + c] * da * (1 - a)) / (oa || 1);
			dst.data[d + 3] = oa * 255;
		}
	}
}

function fillRect(img: Image, x: number, y: number, w: number, h: number, rgba: Rgba): void {
	const r = clampRect(img, x, y, w, h);
	const a = (rgba[3] ?? 255) / 255;

	for (let yy = r.y; yy < r.y + r.h; yy++) {
		for (let xx = r.x; xx < r.x + r.w; xx++) {
			const o = (yy * img.width + xx) * 4;
			if (a >= 1) {
				img.data[o] = rgba[0];
				img.data[o + 1] = rgba[1];
				img.data[o + 2] = rgba[2];
				img.data[o + 3] = 255;
			} else {
				for (let c = 0; c < 3; c++) img.data[o + c] = rgba[c] * a + img.data[o + c] * (1 - a);
				img.data[o + 3] = Math.max(img.data[o + 3], a * 255);
			}
		}
	}
}

function strokeRect(img: Image, x: number, y: number, w: number, h: number, rgba: Rgba, thickness = 2): void {
	fillRect(img, x, y, w, thickness, rgba);
	fillRect(img, x, y + h - thickness, w, thickness, rgba);
	fillRect(img, x, y, thickness, h, rgba);
	fillRect(img, x + w - thickness, y, thickness, h, rgba);
}

/** A 5×7 bitmap font: uppercase, digits, and a little punctuation. Enough for labels. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
	C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
	G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
	K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
	N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
	W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
	X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
	Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
	Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
	"0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
	"1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
	"2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
	"3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
	"4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
	"5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
	"6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
	"7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	"8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
	"9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
	" ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
	".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
	":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	"/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
	"%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
	"(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
	")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
	"#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
	_: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
	"?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
	"=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
	"+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
	",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
};

function textWidth(text: string, scale = 2): number {
	return text.length * 6 * scale;
}

/** Draw uppercase bitmap text. Returns the width drawn. */
function drawText(img: Image, text: string, x: number, y: number, rgba: Rgba, scale = 2): number {
	let cx = Math.round(x);
	for (const ch of String(text).toUpperCase()) {
		const glyph = GLYPHS[ch] ?? GLYPHS["?"];
		for (let r = 0; r < 7; r++) {
			for (let c = 0; c < 5; c++) {
				if (glyph[r][c] === "1") fillRect(img, cx + c * scale, y + r * scale, scale, scale, rgba);
			}
		}
		cx += 6 * scale;
	}
	return cx - x;
}

/** Draw a label on a background pill. */
function drawLabel(
	img: Image,
	text: string,
	x: number,
	y: number,
	{ fg = [255, 255, 255, 255], bg = [0, 0, 0, 220], scale = 2, pad = 4 }: { fg?: Rgba; bg?: Rgba; scale?: number; pad?: number } = {},
): { w: number; h: number } {
	const w = textWidth(text, scale) + pad * 2;
	const h = 7 * scale + pad * 2;
	fillRect(img, x, y, w, h, bg);
	drawText(img, text, x + pad, y + pad, fg, scale);
	return { w, h };
}

export { blit, clampRect, createImage, crop, drawLabel, drawText, fillRect, fit, GLYPHS, resize, strokeRect, textWidth };
export type { Rect, Rgba };
