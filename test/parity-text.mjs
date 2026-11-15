/**
 * Parity check: the ported text engine against the reference implementation.
 *
 * This is the end-to-end oracle for `detectText`, which makes it the oracle for the
 * comment stripper too: a stripper that blanked the wrong bytes would change which
 * rules fire and on which line, and this comparison would see it.
 */
import * as port from "../extensions/designer/engine/detect/text.ts";
import * as ref from "../reference/impeccable-js/scripts/detector/engines/regex/detect-text.mjs";

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     port: ${a}\n     ref:  ${e}`);
}

const fixtures = [
	["styles.css", `.card {
  border-left: 4px solid #c81414;
  border-radius: 8px;
  transition: width 200ms ease;
  animation: bounce 1s infinite;
}
.card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: rgb(200, 20, 20); }
.item { box-shadow: inset 4px 0 0 rgb(200, 20, 20); }
.grid { background-image: linear-gradient(to right, #222 1px, transparent 1px), linear-gradient(to bottom, #222 1px, transparent 1px); background-size: 32px 32px; }
.hero { background-clip: text; background-image: linear-gradient(#7c3aed, #06b6d4); }
/* .commented { border-left: 6px solid red; } */
.card2 { border-left: 5px solid rgb(20, 20, 20); }
.pad { padding: 16px; margin: 16px; gap: 16px; }
.pad2 { padding: 16px; margin: 16px; gap: 16px; }
.pad3 { padding: 16px; margin: 16px; gap: 16px; }
.pad4 { padding: 16px; margin: 16px; gap: 16px; }
`],
	["component.tsx", `const Card = styled.div\`
  border-left: 4px solid #c81414;
  transition: height 200ms ease;
  animation: elastic 1s infinite;
\`;
export const A = () => <div className="animate-bounce border-l-4 rounded-lg px-4 py-4 mx-4 my-4" />;
export const B = () => <img src="" alt="broken" />;
export const C = () => <span className="bg-clip-text bg-gradient-to-r from-purple-500 to-cyan-400" />;
`],
	["page.html", `<!doctype html>
<html><body>
<p>We streamline your workflow and empower your team — really — with a seamless experience — and it is — quite something — honestly — yes — truly — fine.</p>
<p>Not a tool. The workflow you always wanted.</p>
<p>Not a dashboard. The answer you needed.</p>
<p>Not a platform. A place to work.</p>
<div style="box-shadow: 0 0 24px rgb(120, 20, 200)">glow</div>
<img src="#">
</body></html>
`],
	["partial.html", `<div class="card border-left: 4px solid red">partial page, no doctype</div>`],
	["ignored.css", `.card { border-left: 4px solid #c81414; } /* impeccable-disable side-tab */`],
	["plain.ts", `export const x = 1; // border-left: 4px solid #c81414`],
	["unknown.md", `# Title\n\nborder-left: 4px solid #c81414`],
];

for (const [filePath, content] of fixtures) {
	check(`detectText(${filePath})`, port.detectText(content, filePath), ref.detectText(content, filePath));
	check(
		`detectText(${filePath}, inlineIgnores: false)`,
		port.detectText(content, filePath, { inlineIgnores: false }),
		ref.detectText(content, filePath, { inlineIgnores: false }),
	);
}

// Individual matchers, so a divergence names the pattern instead of a diff.
const probeLines = [
	"border-left: 4px solid #c81414",
	"border-left: 1px solid #c81414",
	"border-left: 4px solid rgb(20, 20, 20)",
	"border-t-2 rounded-lg",
	"border-l-4 rounded-lg",
	"font-family: 'Inter', sans-serif",
	"background-clip: text; background-image: linear-gradient(red, blue)",
	"transition: width 200ms",
	"transition: all 200ms",
	"animation: bounce 1s infinite",
	"cubic-bezier(0.34, 1.56, 0.64, 1)",
	"<img src=\"\">",
	"<img alt=\"no src\">",
	'<img src="a.png">',
	"text-gray-400 bg-blue-500",
	"text-violet-500 text-3xl",
	"from-purple-500 to-cyan-400",
	"ignore me",
];
for (const [i, line] of probeLines.entries()) {
	check(`runRegexMatchers(#${i} ${line.slice(0, 24)})`, port.runRegexMatchers([line], "probe.css"), ref.runRegexMatchers([line], "probe.css"));
}

const analyzerFixtures = [
	"<!doctype html><html><body><p>We streamline your workflow, empower your team, and supercharge your results.</p></body></html>",
	"<!doctype html><html><body><p>Not a tool. The workflow you always wanted. Not a dashboard. The answer. Not a platform. A place.</p></body></html>",
	"<html><head></head><body>" + "padding: 16px; ".repeat(12) + "</body></html>",
	"<html><head></head><body><p>a — b — c — d — e — f — g — h — i — j</p></body></html>",
	"<html><head></head><body><div style=\"box-shadow: 0 0 24px rgb(120, 20, 200)\">x</div></body></html>",
	"<marquee>hi</marquee>",
];
for (const [i, content] of analyzerFixtures.entries()) {
	check(`runTextContentAnalyzers(#${i})`, port.runTextContentAnalyzers(content, "page.html"), ref.runTextContentAnalyzers(content, "page.html"));
}

for (const [i, css] of [
	".item { box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	"red 4px 0 inset",
	".item { box-shadow: inset 4px 0 8px rgb(200, 20, 20); }",
	".item.active { box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	".logo { width: 24px; box-shadow: inset 4px 0 0 rgb(200, 20, 20); }",
	".item { box-shadow: inset 0 4px 0 var(--accent-red); }",
].entries()) {
	check(`scanInsetStripeCss(#${i})`, port.scanInsetStripeCss(css, "a.css"), ref.detectText(css, "a.css"));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} detect-text engine comparisons failed`);
	process.exit(1);
}
console.log(`detect-text engine parity: ${comparisons} comparisons match the reference`);
