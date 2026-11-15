/**
 * Parity check: the raster toolkit against the reference.
 *
 * Every byte matters here: these composites are compared against comps by pixel metrics
 * downstream, so a one-off in area averaging or alpha compositing shifts a fidelity score. The
 * comparisons hash the whole image after each operation.
 */
import { createHash } from "node:crypto";
import * as port from "../extensions/designer/engine/lib/raster.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/raster.mjs";

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

/** A whole image as something comparable. */
const digest = (img) => ({
	width: img.width,
	height: img.height,
	sha: createHash("sha256").update(Buffer.from(img.data)).digest("hex").slice(0, 16),
	sum: Array.from(img.data).reduce((n, v) => (n + v) % 1_000_003, 0),
});

/** A deterministic test image: a gradient with a solid block and a transparent corner. */
function sample(width, height) {
	const img = { width, height, data: new Uint8Array(width * height * 4) };
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			img.data[o] = (x * 255) / Math.max(1, width - 1);
			img.data[o + 1] = (y * 255) / Math.max(1, height - 1);
			img.data[o + 2] = (x + y) % 256;
			img.data[o + 3] = x < width / 2 ? 255 : 128;
		}
	}
	return img;
}

check("createImage(empty)", digest(port.createImage(8, 6)), digest(ref.createImage(8, 6)));
check("createImage(filled)", digest(port.createImage(8, 6, [10, 20, 30, 255])), digest(ref.createImage(8, 6, [10, 20, 30, 255])));

const base = sample(24, 16);
check("clampRect(inside)", port.clampRect(base, 2, 3, 5, 4), ref.clampRect(base, 2, 3, 5, 4));
check("clampRect(overflow)", port.clampRect(base, -5, -5, 100, 100), ref.clampRect(base, -5, -5, 100, 100));
check("clampRect(fractional)", port.clampRect(base, 1.4, 2.6, 3.2, 4.9), ref.clampRect(base, 1.4, 2.6, 3.2, 4.9));
check("clampRect(zero)", port.clampRect(base, 30, 30, 4, 4), ref.clampRect(base, 30, 30, 4, 4));

for (const [x, y, w, h] of [[0, 0, 8, 8], [4, 4, 10, 10], [-2, -2, 5, 5], [20, 12, 20, 20]]) {
	check(`crop(${x},${y},${w},${h})`, digest(port.crop(base, x, y, w, h)), digest(ref.crop(base, x, y, w, h)));
}

// Down (area averaging), up (bilinear), and the identity case.
for (const [w, h] of [[12, 8], [48, 32], [24, 16], [7, 5], [1, 1], [100, 60]]) {
	check(`resize(${w}×${h})`, digest(port.resize(base, w, h)), digest(ref.resize(base, w, h)));
}
check("resize(rounds)", digest(port.resize(base, 12.6, 8.4)), digest(ref.resize(base, 12.6, 8.4)));

for (const [maxW, maxH, upscale] of [[10, 10, false], [100, 100, false], [100, 100, true], [24, 16, false]]) {
	check(`fit(${maxW},${maxH},${upscale})`, digest(port.fit(base, maxW, maxH, upscale)), digest(ref.fit(base, maxW, maxH, upscale)));
}

// Compositing, including the fully opaque and fully transparent paths.
const dstPort = sample(30, 20);
const dstRef = sample(30, 20);
const overlayPort = port.createImage(10, 8, [200, 100, 50, 255]);
const overlayRef = ref.createImage(10, 8, [200, 100, 50, 255]);
port.blit(dstPort, overlayPort, 5, 4);
ref.blit(dstRef, overlayRef, 5, 4);
check("blit(opaque)", digest(dstPort), digest(dstRef));

const halfSrcPort = sample(6, 6);
const halfSrcRef = sample(6, 6);
port.blit(dstPort, halfSrcPort, -3, 15);
ref.blit(dstRef, halfSrcRef, -3, 15);
check("blit(partly outside, translucent)", digest(dstPort), digest(dstRef));

const fillPort = sample(10, 10);
const fillRef = sample(10, 10);
for (const rgba of [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0], [9, 9, 9]]) {
	port.fillRect(fillPort, 2, 2, 5, 5, rgba);
	ref.fillRect(fillRef, 2, 2, 5, 5, rgba);
}
check("fillRect(all alpha paths)", digest(fillPort), digest(fillRef));

const strokePort = port.createImage(20, 20);
const strokeRef = ref.createImage(20, 20);
for (const thickness of [1, 2, 4]) {
	port.strokeRect(strokePort, 3, 3, 14, 14, [255, 255, 255, 255], thickness);
	ref.strokeRect(strokeRef, 3, 3, 14, 14, [255, 255, 255, 255], thickness);
}
check("strokeRect", digest(strokePort), digest(strokeRef));

// Bitmap text, including a character the font does not carry.
check("textWidth", port.textWidth("HELLO 42", 2), ref.textWidth("HELLO 42", 2));
check("textWidth(scale 1)", port.textWidth("A", 1), ref.textWidth("A", 1));

for (const label of ["HELLO 42", "A-B:C/D%", "fallback §"]) {
	const textPort = port.createImage(120, 30);
	const textRef = ref.createImage(120, 30);
	const widthPort = port.drawText(textPort, label, 2, 2, [255, 255, 255, 255], 2);
	const widthRef = ref.drawText(textRef, label, 2, 2, [255, 255, 255, 255], 2);
	check(`drawText(${JSON.stringify(label)})`, { width: widthPort, image: digest(textPort) }, { width: widthRef, image: digest(textRef) });
}

const labelPort = port.createImage(140, 40);
const labelRef = ref.createImage(140, 40);
check(
	"drawLabel",
	{ size: port.drawLabel(labelPort, "CARD 01", 4, 6), image: digest(labelPort) },
	{ size: ref.drawLabel(labelRef, "CARD 01", 4, 6), image: digest(labelRef) },
);
check(
	"drawLabel(options)",
	{ size: port.drawLabel(labelPort, "X", 0, 0, { fg: [0, 0, 0, 255], bg: [255, 255, 0, 128], scale: 1, pad: 2 }), image: digest(labelPort) },
	{ size: ref.drawLabel(labelRef, "X", 0, 0, { fg: [0, 0, 0, 255], bg: [255, 255, 0, 128], scale: 1, pad: 2 }), image: digest(labelRef) },
);

// The glyph table is private in the reference, so it is compared through what it draws: every
// character it carries, plus one it does not, is rendered and hashed above.
const drawnLabels = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789 .:-/%()#_?=+,", "~@"];
for (const label of drawnLabels) {
	const textPort = port.createImage(400, 20);
	const textRef = ref.createImage(400, 20);
	port.drawText(textPort, label, 0, 2, [255, 255, 255, 255], 1);
	ref.drawText(textRef, label, 0, 2, [255, 255, 255, 255], 1);
	check(`drawText(glyph set: ${JSON.stringify(label)})`, digest(textPort), digest(textRef));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} raster comparisons failed`);
	process.exit(1);
}
console.log(`raster parity: ${comparisons} comparisons match the reference`);
