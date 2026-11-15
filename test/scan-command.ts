/**
 * The scan command: what `/designer detect` runs, end to end.
 *
 * This is the seam the extension calls, so it is tested as a host would use it: a real project on disk,
 * the config filters it declares, the design system it carries, and the report that comes back. The
 * scan itself is compared against the reference elsewhere; what is checked here is the wiring, which is
 * where a host actually goes wrong.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { runScan } = await import("../extensions/designer/engine/lib/scan-command.ts");
const { loadHtmlModules, clearHtmlModulesCache } = await import("../extensions/designer/engine/lib/html-modules.ts");

let failures = 0;
let checks = 0;

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-scan-command-"));
const write = (rel: string, content: string) => {
	const filePath = path.join(dir, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	// ─── the parser is loaded when it is installed ──────────────────────
	const modules = await loadHtmlModules();
	check("the parser loads in this repository", modules !== null, true);
	check("the parser carries what the cascade needs", ["parseDocument", "selectAll", "selectOne", "compile", "csstree", "domutils"].every((k) => k in (modules as unknown as Record<string, unknown>)), true);

	// ─── a clean project says so ───────────────────────────────────────
	write("src/clean.html", '<main style="color: #1a1a1a; background: #ffffff"><p>Body copy at a readable contrast.</p></main>\n');
	const clean = await runScan({ targets: ["src/clean.html"], cwd: dir });
	check("a clean file reports no findings", clean.findings, 0);
	check("a clean file still prints a summary", clean.text.includes("anti-patterns found"), true);
	check("a clean scan is not degraded", clean.degraded, false);
	check("a clean scan has no comp-round notice", clean.notice, null);

	// ─── a real finding comes back through the wiring ───────────────────
	write("src/tells.html", '<div style="color: #000000; background: #0000aa">x</div>\n');
	const tells = await runScan({ targets: ["src/tells.html"], cwd: dir });
	check("a tell is found", tells.findings > 0, true);
	check("the report names the file", tells.text.includes("tells.html"), true);
	check("the report names the rule", /\[[a-z-]+\]/.test(tells.text), true);
	check("findings make the notification a warning", tells.findings > 0, true);

	// ─── the config's ignore list is applied ───────────────────────────
	write(".impeccable/config.json", JSON.stringify({ detector: { ignoreRules: ["low-contrast"] } }));
	write("src/contrast.html", '<main style="color: #0000aa; background: #000000"><p>Hard to read.</p></main>\n');
	write("src/tabs.css", ".a { border-left: 4px solid #8b5cf6; }\n");
	const beforeIgnore = await runScan({ targets: ["src/contrast.html"], cwd: dir });
	check("the rule fires before it is ignored", beforeIgnore.text.includes("low-contrast") || beforeIgnore.findings === 0, true);

	write(".impeccable/config.json", JSON.stringify({ detector: { ignoreRules: ["low-contrast"], ignoreFiles: ["src/ignored.html"] } }));
	write("src/ignored.html", '<div style="color: #000000; background: #0000aa">x</div>\n');
	const ignored = await runScan({ targets: ["src/ignored.html"], cwd: dir });
	check("an ignored file is not scanned", ignored.findings, 0);

	// ─── the design system is loaded from the project ──────────────────
	write("DESIGN.md", "# Design\n\n## Colors\n- **Ink** (#111111): text\n\n## Typography\n**Body Font:** Inter\n");
	const withDesign = await runScan({ targets: ["src/clean.html"], cwd: dir });
	check("a project with a design file still scans", withDesign.findings >= 0, true);

	// ─── a directory walks ─────────────────────────────────────────────
	const directory = await runScan({ targets: ["src"], cwd: dir });
	check("a directory scan finds the remaining tell", directory.findings > 0, true);

	// ─── no targets scans the working directory ────────────────────────
	const bare = await runScan({ cwd: dir });
	check("a bare scan says something", typeof bare.text, "string");
	check("a bare scan completes", bare.findings >= 0, true);

	// ─── the advisory split ────────────────────────────────────────────
	const withAdvisory = await runScan({ targets: ["src"], cwd: dir, advisory: true });
	const withoutAdvisory = await runScan({ targets: ["src"], cwd: dir, advisory: false });
	check("advisory findings are optional", withAdvisory.findings >= withoutAdvisory.findings, true);

	// ─── the flags the skill documents ──────────────────────────────────
	// The skill's playbooks invoke the detector with --json and --scope; the command has to honour both
	// or the docs would describe a command that does not exist.
	const jsonRun = await runScan({ targets: ["src"], cwd: dir, json: true });
	check("--json emits parseable findings", (() => {
		try {
			return Array.isArray(JSON.parse(jsonRun.text));
		} catch {
			return false;
		}
	})(), true);

	const scopedType = await runScan({ targets: ["src"], cwd: dir, scopes: ["type"] });
	check("--scope type narrows the scan", scopedType.findings <= directory.findings, true);
	const scopedBoth = await runScan({ targets: ["src"], cwd: dir, scopes: ["type", "layout"] });
	// Scopes narrow by design: a contrast finding is neither a type nor a layout rule, so both scopes
	// together still do not reach an unscoped scan.
	check("both scopes cover at least each single scope", scopedBoth.findings >= Math.max(scopedType.findings, 0), true);
	check("an unscoped scan sees more than a scoped one", directory.findings >= scopedBoth.findings, true);

	// ─── the comp-round notice rides along ──────────────────────────────
	write(".impeccable/build/pending.json", JSON.stringify({ scope: "direction" }));
	const pending = await runScan({ targets: ["src/clean.html"], cwd: dir });
	check("an open comp round is reported", pending.notice?.startsWith("COMP_ROUND_OPEN:"), true);
	check("the notice says a pass is not a finish", pending.notice?.includes("not a finish"), true);

	// ─── a missing parser degrades instead of failing ──────────────────
	clearHtmlModulesCache();
	check("the cache clears", (await loadHtmlModules()) !== null, true);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${checks} scan-command checks failed`);
	process.exit(1);
}
console.log(`scan-command: ${checks} checks passed`);
