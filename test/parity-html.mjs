/**
 * Parity check: the whole static HTML engine against the reference.
 *
 * This is the broadest oracle in the port: it runs the CSS cascade, the element rules, the
 * design-system pass, and the page rules over the same file, so a mistake anywhere in that
 * chain shows up as a different finding set. The parser modules come from the upstream
 * checkout, because that is where they are installed; the engine itself takes them as an
 * argument, which is exactly the seam this test exercises.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The engines take the parser as an argument; this test supplies the same four packages the
// reference imports for itself, so import them by name rather than by path.
const [htmlparser2, cssSelect, csstree, domutils] = await Promise.all([
	import("htmlparser2"),
	import("css-select"),
	import("css-tree"),
	import("domutils"),
]);

const port = await import("../extensions/designer/engine/detect/static-html/html.ts");
const ref = await import("../reference/impeccable-js/scripts/detector/engines/static-html/detect-html.mjs");

let failures = 0;
let comparisons = 0;

function normalize(findings) {
	return findings
		.map((f) => ({ id: f.antipattern ?? f.id, snippet: f.snippet, severity: f.severity ?? null }))
		.map((f) => `${f.id}|${f.severity ?? ""}|${f.snippet}`)
		.sort();
}

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	const missing = expected.filter((item) => !actual.includes(item));
	const extra = actual.filter((item) => !expected.includes(item));
	console.log(`FAIL ${name}\n     only port: ${JSON.stringify(extra)}\n     only ref:  ${JSON.stringify(missing)}`);
}

const modules = {
	parseDocument: htmlparser2.parseDocument,
	selectAll: cssSelect.selectAll,
	selectOne: cssSelect.selectOne,
	compile: cssSelect.compile,
	csstree,
	domutils,
};

const fixtures = [
	[
		"card.html",
		`<!doctype html>
<html><head><style>
  :root { --brand: #8c2f1e; --paper: #f5efe3; }
  body { background: var(--paper); color: #241c16; font-family: Inter, sans-serif; }
  .card { border-left: 4px solid var(--brand); border-radius: 8px; padding: 0; }
  .chip { background: var(--brand); color: #fff; font-size: 8px; }
  .glow { box-shadow: 0 0 24px rgb(120, 20, 200); }
  .tight { line-height: 1.1; font-size: 16px; }
  h1 { font-family: 'Playfair Display', serif; font-style: italic; font-size: 72px; }
  .caps { text-transform: uppercase; letter-spacing: 4px; font-size: 12px; }
</style></head>
<body>
  <div class="card"><p class="tight">${"Body copy that runs on. ".repeat(4)}</p></div>
  <span class="chip">New</span>
  <h1>An italic serif hero headline that is long enough to matter</h1>
  <p class="caps">STATUS: ONLINE</p>
  <div class="glow">glow</div>
  <img src="">
  <p>We streamline your workflow and empower your team.</p>
</body></html>`,
	],
	[
		"motion.html",
		`<!doctype html>
<html><head><style>
  .b { animation: bounce 1s infinite; transition: width 200ms ease; }
  .g { background-image: linear-gradient(to right, #222 1px, transparent 1px), linear-gradient(to bottom, #222 1px, transparent 1px); background-size: 32px 32px; }
  .s { background-clip: text; background-image: linear-gradient(#7c3aed, #06b6d4); }
</style></head>
<body><div class="b">x</div><div class="g">y</div><div class="s">z</div></body></html>`,
	],
	[
		"partial.html",
		`<div style="border-left: 4px solid #c81414; border-radius: 8px">partial page, no doctype</div>`,
	],
	[
		"links.html",
		`<!doctype html>
<html><head><link rel="stylesheet" href="style.css"></head>
<body><div class="linked">linked stylesheet</div></body></html>`,
	],
	[
		"empty.html",
		`<!doctype html><html><head></head><body><p>plain</p></body></html>`,
	],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-html-"));
fs.writeFileSync(path.join(dir, "style.css"), ".linked { border-left: 5px solid #c81414; border-radius: 4px; }\n");

try {
	for (const [name, html] of fixtures) {
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, html);

		const portFindings = normalize(await port.detectHtml(filePath, { modules }));
		const refFindings = normalize(await ref.detectHtml(filePath));
		check(`detectHtml(${name})`, portFindings, refFindings);

		const portIgnored = normalize(await port.detectHtml(filePath, { modules, inlineIgnores: false }));
		const refIgnored = normalize(await ref.detectHtml(filePath, { inlineIgnores: false }));
		check(`detectHtml(${name}, inlineIgnores: false)`, portIgnored, refIgnored);
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} static-html comparisons failed`);
	process.exit(1);
}
console.log(`static-html parity: ${comparisons} comparisons match the reference`);
