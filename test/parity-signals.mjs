/**
 * Parity check: the context signals against the reference.
 *
 * These signals decide which command a bare session proposes, so a wrong `git.base` drags a
 * whole integration branch into the scan targets. The comparisons use real git repositories:
 * one develop-based with a feature branch, one on main with a dirty tree, and one detached.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/context-signals.ts");
const ref = await import("../reference/impeccable-js/scripts/context-signals.mjs");

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-signals-"));
const write = (dir, rel, content = "x") => {
	const filePath = path.join(dir, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};
const gitIn = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

/** Compare everything except the dev-server probe, which depends on this machine's ports. */
function comparable(signals) {
	return { setup: signals.setup, critique: signals.critique, git: signals.git, scan: signals.scan };
}

try {
	// 1. A develop-based repo with a feature branch: the base must be develop, not main.
	const developRepo = path.join(base, "develop-repo");
	fs.mkdirSync(developRepo, { recursive: true });
	write(developRepo, "PRODUCT.md", "# P\n\n## Platform\nweb\n");
	write(developRepo, "src/app.css", ".a { color: red }\n");
	gitIn(developRepo, ["init", "-q", "-b", "develop"]);
	gitIn(developRepo, ["config", "user.email", "t@example.com"]);
	gitIn(developRepo, ["config", "user.name", "T"]);
	gitIn(developRepo, ["add", "-A"]);
	gitIn(developRepo, ["commit", "-qm", "base"]);
	gitIn(developRepo, ["checkout", "-q", "-b", "main"]);
	gitIn(developRepo, ["commit", "-qm", "main diverges", "--allow-empty"]);
	gitIn(developRepo, ["checkout", "-q", "develop"]);
	gitIn(developRepo, ["checkout", "-q", "-b", "feature/x"]);
	write(developRepo, "src/page.css", ".b { color: blue }\n");
	gitIn(developRepo, ["add", "-A"]);
	gitIn(developRepo, ["commit", "-qm", "feature"]);
	write(developRepo, "src/dirty.css", ".c { color: green }\n");

	const portDevelop = await port.gatherSignals(developRepo);
	const refDevelop = await ref.gatherSignals(developRepo);
	check("develop repo: signals", comparable(portDevelop), comparable(refDevelop));
	check("develop repo: base is develop", portDevelop.git.base, "develop");

	// 2. A repo sitting on main with a dirty tree: working tree is the scope hint.
	const mainRepo = path.join(base, "main-repo");
	fs.mkdirSync(mainRepo, { recursive: true });
	write(mainRepo, "index.html", "<!doctype html><html></html>");
	gitIn(mainRepo, ["init", "-q", "-b", "main"]);
	gitIn(mainRepo, ["config", "user.email", "t@example.com"]);
	gitIn(mainRepo, ["config", "user.name", "T"]);
	gitIn(mainRepo, ["add", "-A"]);
	gitIn(mainRepo, ["commit", "-qm", "base"]);
	write(mainRepo, "styles.css", ".a { color: red }\n");

	const portMain = await port.gatherSignals(mainRepo);
	const refMain = await ref.gatherSignals(mainRepo);
	check("main repo: signals", comparable(portMain), comparable(refMain));
	check("main repo: no diff base on an integration branch", portMain.git.base, null);
	check("main repo: scan targets are the dirty tree", portMain.scan, refMain.scan);

	// 3. No repository at all: everything is best-effort and nothing throws.
	const plain = path.join(base, "plain");
	fs.mkdirSync(path.join(plain, "src"), { recursive: true });
	write(plain, "src/app.css", ".a { color: red }\n");
	const portPlain = await port.gatherSignals(plain);
	const refPlain = await ref.gatherSignals(plain);
	check("plain dir: signals", comparable(portPlain), comparable(refPlain));
	check("plain dir: not a repo", portPlain.git.isRepo, false);

	// 4. A vendored path is not a scan target, which is what keeps a harness install out.
	write(developRepo, ".claude/skills/thing.css", ".d { color: pink }\n");
	check("isVendoredPath(hidden dir)", port.isVendoredPath(".claude/skills/thing.css"), true);
	check("isVendoredPath(source)", port.isVendoredPath("src/app.css"), false);
	check("isVendoredPath(vitepress)", port.isVendoredPath(".vitepress/theme/a.css"), false);
	check("isVendoredPath(node_modules)", port.isVendoredPath("node_modules/pkg/a.css"), true);
} finally {
	fs.rmSync(base, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} context-signals comparisons failed`);
	process.exit(1);
}
console.log(`context-signals parity: ${comparisons} comparisons match the reference`);
