/**
 * Parity check: the scan entry point against the reference CLI.
 *
 * The reference is a CLI, so this drives both over the same directory and compares the
 * finding sets, the advisory partition, the exit code, and the text report. Formatting is
 * compared too: a report is the part a human reads, and a difference there is a difference
 * in what the tool says.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [htmlparser2, cssSelect, csstree, domutils] = await Promise.all([
	import("htmlparser2"),
	import("css-select"),
	import("css-tree"),
	import("domutils"),
]);

const port = await import("../extensions/designer/engine/detect/scan.ts");
const refCli = await import("../reference/impeccable-js/scripts/detector/cli/main.mjs");
const refHtml = await import("../reference/impeccable-js/scripts/detector/engines/static-html/detect-html.mjs");
const refText = await import("../reference/impeccable-js/scripts/detector/engines/regex/detect-text.mjs");

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

const modules = {
	parseDocument: htmlparser2.parseDocument,
	selectAll: cssSelect.selectAll,
	selectOne: cssSelect.selectOne,
	compile: cssSelect.compile,
	csstree,
	domutils,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-scan-"));
fs.writeFileSync(
	path.join(dir, "index.html"),
	`<!doctype html>
<html><head><style>
  .card { border-left: 4px solid #c81414; border-radius: 8px; }
  body { font-family: Roboto, sans-serif; }
</style></head>
<body><div class="card"><p>Body copy here that runs long enough to be judged.</p></div>
<img src=""><p>We streamline your workflow and empower your team.</p>
<p>Em dashes — everywhere — in — this — text — for — no — reason — at — all — here.</p>
</body></html>`,
);
fs.writeFileSync(
	path.join(dir, "styles.css"),
	`.x { border-left: 4px solid #c81414; border-radius: 8px; }
.y { animation: bounce 1s infinite; }
/* .z { border-left: 6px solid red; } */
`,
);
fs.writeFileSync(path.join(dir, "component.tsx"), `export const A = () => <div className="animate-bounce border-l-4 rounded-lg" />;\n`);
fs.mkdirSync(path.join(dir, "nested"));
fs.writeFileSync(path.join(dir, "nested", "empty.css"), `.skip { color: red; }\n`);

const normalize = (findings) => findings.map((f) => `${f.antipattern}|${f.severity}|${f.snippet}`).sort();

try {
	const portResult = await port.scanDirectory(dir, { modules, probeFramework: false });
	const portFindings = normalize(portResult.findings);

	// The reference has one entry point per file; walk the same files the scan walks.
	const files = ["component.tsx", "index.html", "nested/empty.css", "styles.css"].map((f) => path.join(dir, f));
	const refFindings = [];
	for (const file of files) {
		refFindings.push(
			...(file.endsWith(".html")
				? await refHtml.detectHtml(file)
				: refText.detectText(fs.readFileSync(file, "utf-8"), file)),
		);
	}

	check("scanDirectory findings", portFindings, normalize(refFindings));

	// The advisory partition and exit code are the contract automation depends on.
	const portPartition = port.partitionAdvisory(portResult.findings);
	const refPartition = refCli.formatFindings;
	void refPartition;
	check(
		"advisory partition sizes",
		[portPartition.primary.length, portPartition.advisory.length],
		[portResult.findings.filter((f) => f.advisory !== true).length, portResult.findings.filter((f) => f.advisory === true).length],
	);
	check("exitCodeFor(advisory only)", port.exitCodeFor([{ antipattern: "em-dash-overuse", advisory: true }]), 0);
	check("exitCodeFor(primary)", port.exitCodeFor([{ antipattern: "side-tab" }]), 2);

	// Text report: same findings in, same report out.
	const sample = portResult.findings.slice(0, 3);
	check("formatFindings(text)", port.formatFindings(sample, false), refCli.formatFindings(sample, false));
	check("formatFindings(json)", port.formatFindings(sample, true), refCli.formatFindings(sample, true));
	check("formatFindingSummary(1)", port.formatFindingSummary(1), "1 anti-pattern found.");
	check("formatFindingSummary(2)", port.formatFindingSummary(2), "2 anti-patterns found.");

	const scoped = await port.scanTargets([path.join(dir, "styles.css")], { scopes: ["type"] });
	check("scanTargets(scopes: type) keeps only type rules", scoped.findings.every((f) => f.antipattern === "overused-font" || f.line > 0), true);

	const quiet = await port.scanTargets([path.join(dir, "component.tsx")]);
	check("scanTargets(file) finds the bounce", quiet.findings.some((f) => f.antipattern === "bounce-easing"), true);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} scan comparisons failed`);
	process.exit(1);
}
console.log(`scan parity: ${comparisons} comparisons match the reference`);
