/**
 * Parity check: the config module against the reference.
 *
 * The config is what turns a finding into a suppression, so a matching difference here is
 * invisible until a real project's waiver silently stops working. These comparisons run the
 * normalizers, the glob matcher, the file filter, the finding filter, and the write path on
 * the same inputs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/config.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/impeccable-config.mjs");

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

// ─── Value normalizers ─────────────────────────────────────────────────────

for (const value of ["Inter", ' "Inter" ', "IBM+Plex+Sans", "  a   b  ", "", null, 42]) {
	check(`normalizeIgnoreValue(${JSON.stringify(value)})`, port.normalizeIgnoreValue(value), ref.normalizeIgnoreValue(value));
}

for (const value of ["#f00", "#ff0000", "#FF000080", "rgb(255, 0, 0)", "rgba(0,0,0,0.5)", "hsl(0, 100%, 50%)", "nonsense", ""]) {
	const entry = { rule: "design-system-color", value: `${value}` };
	const finding = { antipattern: "design-system-color", snippet: `Undocumented color ${value}`, ignoreValue: value };
	check(
		`filterDetectionFindings(color ${value})`,
		port.filterDetectionFindings([finding], { ignoreRules: [], ignoreFiles: [], ignoreValues: [entry] }),
		ref.filterDetectionFindings([finding], { ignoreRules: [], ignoreFiles: [], ignoreValues: [entry] }),
	);
}

// ─── Globs and file filtering ──────────────────────────────────────────────

const globs = ["**/*.css", "src/**", "*.min.js", "**/{a,b}/*.ts", "nested/deep/file.tsx", "legacy/**"];
for (const filePath of [
	"src/app.css",
	"app.css",
	"src/deep/app.ts",
	"a/x.ts",
	"b/y.ts",
	"c/z.ts",
	"nested/deep/file.tsx",
	"legacy/old.css",
	"other/file.ts",
]) {
	check(`matchesAnyGlob(${filePath})`, port.matchesAnyGlob(filePath, globs), ref.matchesAnyGlob(filePath, globs));
}

const root = "/tmp/project";
for (const filePath of ["/tmp/project/src/app.css", "/tmp/project/legacy/old.css", "/tmp/project/other/file.ts", "src/app.css"]) {
	const config = { ignoreRules: [], ignoreFiles: ["src/**", "legacy/**"], ignoreValues: [] };
	check(
		`shouldIgnoreDetectionFile(${filePath})`,
		port.shouldIgnoreDetectionFile(filePath, root, config),
		ref.shouldIgnoreDetectionFile(filePath, root, config),
	);
}

// ─── Entry normalization (key order matters) ───────────────────────────────

const entries = [
	{ rule: "Overused-Font", value: " Inter ", reason: " brand ", createdAt: " 2026-01-01 " },
	{ rule: "bounce-easing", value: "animate-bounce", file: " src/a.tsx ", files: ["src/b.tsx", "src/a.tsx"] },
	{ rule: "", value: "x" },
	{ rule: "x", value: "" },
	{ rule: "side-tab", value: "*" },
	"not an object",
];
check("normalizeIgnoreValueEntries", port.normalizeIgnoreValueEntries(entries), ref.normalizeIgnoreValueEntries(entries));

// ─── Finding filters, including file-scoped wildcards ──────────────────────

const findings = [
	{ antipattern: "overused-font", file: "src/a.css", snippet: "Primary font: Inter", ignoreValue: "Inter" },
	{ antipattern: "overused-font", file: "src/b.css", snippet: "Primary font: Roboto", ignoreValue: "Roboto" },
	{ antipattern: "side-tab", file: "src/c.css", snippet: "border-left: 4px" },
	{ antipattern: "bounce-easing", file: "src/d.tsx", snippet: "animate-bounce (Tailwind)" },
	{ antipattern: "design-system-color", file: "src/e.css", snippet: "Undocumented color #ff0000", ignoreValue: "#ff0000" },
];

const configs = [
	{ ignoreRules: ["overused-font"], ignoreFiles: [], ignoreValues: [] },
	{ ignoreRules: [], ignoreFiles: [], ignoreValues: [{ rule: "side-tab", value: "*", files: ["src/c.css"] }] },
	{ ignoreRules: [], ignoreFiles: [], ignoreValues: [{ rule: "overused-font", value: "inter" }] },
	{ ignoreRules: [], ignoreFiles: [], ignoreValues: [{ rule: "bounce-easing", value: "animate-bounce" }] },
	{ ignoreRules: [], ignoreFiles: [], ignoreValues: [{ rule: "design-system-color", value: "#f00" }] },
	{ ignoreRules: [], ignoreFiles: [], ignoreValues: [{ rule: "design-system-color", value: "rgb(255,0,0)" }] },
	{ ignoreRules: [], ignoreFiles: ["src/**"], ignoreValues: [] },
];
for (const [i, config] of configs.entries()) {
	check(
		`filterDetectionFindings(config #${i})`,
		port.filterDetectionFindings(findings, config).map((f) => `${f.antipattern}@${f.file}`),
		ref.filterDetectionFindings(findings, config).map((f) => `${f.antipattern}@${f.file}`),
	);
}

for (const finding of findings) {
	check(`extractFindingIgnoreValue(${finding.antipattern})`, port.extractFindingIgnoreValue(finding), ref.extractFindingIgnoreValue(finding));
}

// ─── Read and write round-trip ─────────────────────────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-config-"));
try {
	fs.mkdirSync(path.join(dir, ".impeccable"), { recursive: true });
	const shared = {
		hook: { enabled: true, ignoreRules: ["overused-font"], consent: "accepted" },
		detector: { ignoreFiles: ["legacy/**"] },
		updateCheck: false,
	};
	fs.writeFileSync(path.join(dir, ".impeccable", "config.json"), `${JSON.stringify(shared, null, 2)}\n`);
	fs.writeFileSync(
		path.join(dir, ".impeccable", "config.local.json"),
		`${JSON.stringify({ detector: { ignoreValues: [{ rule: "side-tab", value: "*", files: ["src/a.css"] }] } }, null, 2)}\n`,
	);

	check("readDetectionConfig", port.readDetectionConfig(dir), ref.readDetectionConfig(dir));

	const written = port.writeDetectionConfig(dir, {
		ignoreRules: ["side-tab", "side-tab"],
		ignoreFiles: [" legacy/** ", "dist/**"],
		ignoreValues: [{ rule: "overused-font", value: "Inter", reason: "brand font" }],
	});
	const refWritten = ref.writeDetectionConfig(dir, {
		ignoreRules: ["side-tab", "side-tab"],
		ignoreFiles: [" legacy/** ", "dist/**"],
		ignoreValues: [{ rule: "overused-font", value: "Inter", reason: "brand font" }],
	});
	check("writeDetectionConfig returns the same path", path.basename(written), path.basename(refWritten));
	check("written config matches", JSON.parse(fs.readFileSync(written, "utf-8")), JSON.parse(fs.readFileSync(refWritten, "utf-8")));
	check("written config keeps foreign keys", JSON.parse(fs.readFileSync(written, "utf-8")).updateCheck, false);
	check("written config keeps hook consent", JSON.parse(fs.readFileSync(written, "utf-8")).hook?.consent, "accepted");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} config parity comparisons failed`);
	process.exit(1);
}
console.log(`config parity: ${comparisons} comparisons match the reference`);
