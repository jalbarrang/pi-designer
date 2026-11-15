/**
 * Parity check: the doctor report against the reference.
 *
 * The doctor is the report a maintainer reads to decide what to fix, and its two risky parts
 * are both here: which findings appear (a missing one means silent drift) and what `--fix`
 * touches (an over-eager fix rewrites a file the user did not approve). A fixture project
 * with real drift drives both.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/doctor.ts");
const ref = await import("../reference/impeccable-js/scripts/doctor.mjs");

let failures = 0;
let comparisons = 0;

function assert(name, ok, detail = "") {
	comparisons++;
	if (ok) return;
	failures++;
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-doctor-"));
const write = (rel, content = "x") => {
	const filePath = path.join(root, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	// A project with drift in every tier the doctor covers.
	write(".git/HEAD");
	write("PRODUCT.md", "# Product\n\n## Register: brand-forward\n");
	write(
		"DESIGN.md",
		"# Design\n\n## Colors\n- **Ink** (#241c16): text\n\n## Typography\n**Body Font:** Inter (with system-ui, sans-serif)\n",
	);
	write("DESIGN.json", JSON.stringify({ tokens: {} }));
	write(
		".impeccable/config.json",
		JSON.stringify({ detector: { ignoreRules: ["ghost-rule"], ignoreFiles: ["src/gone.css"] }, buildPath: "nope", mystery: true }),
	);
	fs.mkdirSync(path.join(root, ".impeccable", "surfaces"), { recursive: true });
	write(".impeccable/surfaces/orphan.md", '---\nslug: "orphan"\nprimary_target: "src/gone.tsx"\n---\n\nbody\n');
	write(".impeccable-live.json", "{}");

	const portReport = port.collect(root);
	const refReport = await ref.collect(root);

	const sorted = (findings) => findings.map((f) => `${f.id}|${f.severity}|${f.path ?? ""}`).sort();
	check("collect findings", sorted(portReport.findings), sorted(refReport.findings));
	check("collect workspaces", portReport.workspaces, refReport.workspaces);
	check("collect ruleRegistryAvailable", portReport.ruleRegistryAvailable, refReport.ruleRegistryAvailable);
	check("collect platform", portReport.ctx.platform, refReport.ctx.platform);

	// The rendered text is what a maintainer reads, so it is compared whole.
	// The report body must match; the closing hint names the front door, which differs by design.
	const bodyOf = (text) => text.split("\n").filter((line) => !line.startsWith("Run ")).join("\n");
	check("renderText body", bodyOf(port.renderText(portReport, null, root)), bodyOf(ref.renderText(refReport, null, root)));
	assert("renderText names pi\u2019s front door", port.renderText(portReport, null, root).includes("/designer doctor"));

	// `--fix` on a copy, so both implementations start from the same bytes.
	const makeCopy = (suffix) => {
		const dir = `${root}-${suffix}`;
		fs.cpSync(root, dir, { recursive: true });
		return dir;
	};
	const portDir = makeCopy("port");
	const refDir = makeCopy("ref");
	try {
		const portFix = port.applyFixes(port.collect(portDir));
		const refFix = ref.applyFixes(await ref.collect(refDir));
		check("applyFixes applied", portFix.applied, refFix.applied);
		check("applyFixes skipped ids", portFix.skipped.map((s) => s.id).sort(), refFix.skipped.map((s) => s.id).sort());
		check(
			"applyFixes moved the sidecar",
			fs.existsSync(path.join(portDir, ".impeccable", "design.json")),
			fs.existsSync(path.join(refDir, ".impeccable", "design.json")),
		);
		check(
			"applyFixes stamped the product record",
			fs.readFileSync(path.join(portDir, "PRODUCT.md"), "utf-8").includes("impeccable:product-schema"),
			fs.readFileSync(path.join(refDir, "PRODUCT.md"), "utf-8").includes("impeccable:product-schema"),
		);
		check(
			"applyFixes left the live state alone",
			fs.existsSync(path.join(portDir, ".impeccable-live.json")),
			fs.existsSync(path.join(refDir, ".impeccable-live.json")),
		);
	} finally {
		fs.rmSync(portDir, { recursive: true, force: true });
		fs.rmSync(refDir, { recursive: true, force: true });
	}

	// A clean project reports that explicitly.
	const clean = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-doctor-clean-"));
	try {
		fs.writeFileSync(path.join(clean, "DESIGN.md"), "# D\n");
		const cleanReport = port.collect(clean);
		const cleanRef = await ref.collect(clean);
		check("clean project: findings", cleanReport.findings.map((f) => `${f.id}|${f.severity}`).sort(), cleanRef.findings.map((f) => `${f.id}|${f.severity}`).sort());
		check("clean project: renderText", bodyOf(port.renderText(cleanReport, null, clean)), bodyOf(ref.renderText(cleanRef, null, clean)));
	} finally {
		fs.rmSync(clean, { recursive: true, force: true });
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} doctor comparisons failed`);
	process.exit(1);
}
console.log(`doctor parity: ${comparisons} comparisons match the reference`);
