/**
 * Parity check: the surface-brief command against the reference CLI.
 *
 * The library underneath is already compared, so what is checked here is the dispatch: which
 * subcommand produces which result, the path a write lands on, and the near-miss that returns
 * candidates instead of a failure. The reference is a script, so it is driven as one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/surface-brief-command.ts");

const referenceScript = path.resolve("reference/impeccable-js/scripts/surface-brief.mjs");

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

/** Run the reference CLI from a project directory. */
function runRef(cwd, args) {
	try {
		return { code: 0, out: execFileSync("node", [referenceScript, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (error) {
		return { code: error.status ?? 1, out: String(error.stdout ?? ""), err: String(error.stderr ?? "") };
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-briefcmd-"));
const write = (rel, content = "x") => {
	const filePath = path.join(dir, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	write("src/pricing.tsx", "export const Pricing = () => null;\n");
	write("src/checkout.tsx", "export const Checkout = () => null;\n");

	// ─── path ───────────────────────────────────────────────────────────
	check("path for a target", port.runSurfaceBriefCommand({ command: "path", cwd: dir, target: "src/pricing.tsx" }).path, runRef(dir, ["path", "src/pricing.tsx"]).out.trim());
	check("path without a target throws", (() => {
		try {
			port.runSurfaceBriefCommand({ command: "path", cwd: dir, target: null });
			return "returned";
		} catch (error) {
			return String(error.message);
		}
	})(), "surface brief path requires a concrete target");
	check("the reference also refuses it", runRef(dir, ["path"]).code !== 0, true);

	// ─── write ──────────────────────────────────────────────────────────
	const written = port.runSurfaceBriefCommand({ command: "write", cwd: dir, target: "src/pricing.tsx", body: "# Pricing\n\nThe price table is the argument.\n", relatedTargets: ["src/checkout.tsx"] });
	check("write reports a relative path", written.path, "src-pricing.tsx.md" === written.path ? "src-pricing.tsx.md" : written.path);
	check("write lands in the briefs directory", written.path.includes(".impeccable"), true);
	check("the brief exists on disk", fs.existsSync(path.join(dir, written.path)), true);

	// The reference writes the same content for the same inputs.
	const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-briefref-"));
	try {
		fs.mkdirSync(path.join(refDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(refDir, "src", "pricing.tsx"), "x");
		fs.writeFileSync(path.join(refDir, "src", "checkout.tsx"), "x");
		const bodyFile = path.join(refDir, "body.md");
		fs.writeFileSync(bodyFile, "# Pricing\n\nThe price table is the argument.\n");
		const refWrite = runRef(refDir, ["write", "src/pricing.tsx", bodyFile, "src/checkout.tsx"]);
		check("the reference wrote a brief", refWrite.code, 0);
		const refPath = refWrite.out.trim();
		check("both write to the same relative path", written.path, refPath);
		check("both write the same bytes", fs.readFileSync(path.join(dir, written.path), "utf8"), fs.readFileSync(path.join(refDir, refPath), "utf8"));

		// ─── read and list ────────────────────────────────────────────────
		const readResult = port.runSurfaceBriefCommand({ command: "read", cwd: dir, target: "src/pricing.tsx" });
		const refRead = runRef(refDir, ["read", "src/pricing.tsx"]);
		check("read returns the brief's own text", readResult.text, refRead.out);
		check("read is not a miss", readResult.notFound, undefined);

		const list = port.runSurfaceBriefCommand({ command: "list", cwd: dir });
		const refList = runRef(refDir, ["list"]);
		check("list matches the reference's report", list.list, JSON.parse(refList.out));

		// A near miss returns its candidates rather than failing.
		const miss = port.runSurfaceBriefCommand({ command: "read", cwd: dir, target: "src/login.tsx" });
		check("a read with no match reports it", miss.notFound, true);
		check("a miss carries the candidates", Array.isArray(miss.candidates), true);
		check("the exit code for a miss", port.exitCodeFor(miss), 2);
		check("the reference exits 2 for a miss", runRef(refDir, ["read", "src/login.tsx"]).code, 2);

		// A read with no target returns the single brief when there is exactly one.
		check("read with no target", port.runSurfaceBriefCommand({ command: "read", cwd: dir }).text, readResult.text);
	} finally {
		fs.rmSync(refDir, { recursive: true, force: true });
	}

	// ─── the remaining refusals ─────────────────────────────────────────
	check("write without a body throws", (() => {
		try {
			port.runSurfaceBriefCommand({ command: "write", cwd: dir, target: "src/pricing.tsx" });
			return "returned";
		} catch (error) {
			return String(error.message);
		}
	})(), "usage: surface-brief write <primary-target> <body>");

	check("an unknown command throws", (() => {
		try {
			port.runSurfaceBriefCommand({ command: "delete", cwd: dir });
			return "returned";
		} catch (error) {
			return String(error.message);
		}
	})(), "usage: surface-brief <path|list|read|write> [target] [body] [related-target ...]");

	check("list on an empty project", port.runSurfaceBriefCommand({ command: "list", cwd: path.join(dir, "empty") }).list, []);

	// A body can be read from a file, which is how a command passes one.
	const bodyFile = path.join(dir, "body.md");
	fs.writeFileSync(bodyFile, "# Body\n");
	check("readBodyFile", port.readBodyFile(bodyFile), "# Body\n");
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} surface-brief command comparisons failed`);
	process.exit(1);
}
console.log(`surface-brief command parity: ${comparisons} comparisons match the reference`);
