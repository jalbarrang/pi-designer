/**
 * Parity check: the deep staleness checks against the reference.
 *
 * These are the checks that cost real work — a git log, a workspace sweep, an ignore-list
 * validation — and the failure mode is a report that quietly stops mentioning something. A
 * fixture tree with a real git repository exercises the drift path; the rest run on files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/staleness-deep.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/staleness-deep.mjs");
const designParser = await import("../extensions/designer/engine/lib/design-parser.ts");
const platform = await import("../extensions/designer/engine/lib/platform.ts");
const refPlatform = await import("../reference/impeccable-js/scripts/context.mjs");
const staleness = await import("../extensions/designer/engine/lib/staleness.ts");
const refStaleness = await import("../reference/impeccable-js/scripts/lib/staleness.mjs");

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

const sorted = (findings) => findings.map((f) => `${f.id}|${f.severity}|${f.path ?? ""}|${f.summary}`).sort();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-deep-"));
const write = (rel, content = "x") => {
	const filePath = path.join(root, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	// ─── Design coverage ────────────────────────────────────────────────
	const designs = [
		"",
		"# T\n\n## Colors\n- **Ink** (#241c16): text\n",
		"# T\n\n## Colors\n- **Ink** (#241c16): text\n\n## Typography\n**Body Font:** Inter\n",
		"# T\n\n## Colors\n- **Ink** (#241c16)\n\n## Typography\n**Body Font:** Inter\n\n## Components\n### Card\nA card.\n",
		`# T\n\n<!-- SEED: established with the user before implementation; re-run /impeccable document once there's code to capture the actual tokens and components. -->\n\n## Colors\n- **Ink** (#241c16)\n`,
	];
	for (const [i, design] of designs.entries()) {
		check(
			`checkDesignCoverage(#${i})`,
			sorted(port.checkDesignCoverage({ design, designPath: "DESIGN.md", parseDesignMd: designParser.parseDesignMd })),
			sorted(ref.checkDesignCoverage({ design, designPath: "DESIGN.md", parseDesignMd: refDesignParser() })),
		);
	}
	function refDesignParser() {
		// The reference takes the parser as an argument; import it lazily so the module graph
		// stays identical to the port's.
		return (markdown) => designParser.parseDesignMd(markdown);
	}

	// ─── Ignore lists ───────────────────────────────────────────────────
	write(
		".impeccable/config.json",
		JSON.stringify({
			detector: {
				ignoreRules: ["side-tab", "ghost-rule", "*"],
				ignoreFiles: ["src/gone.css", "**/keep.css", "src/present.css"],
			},
		}),
	);
	write("src/present.css", ".a {}");
	write(".impeccable/config.local.json", JSON.stringify({ detector: { ignoreFiles: ["legacy/missing.css"] } }));

	const known = new Set(["side-tab", "overused-font"]);
	check(
		"checkDetectorIgnores(all known)",
		sorted(port.checkDetectorIgnores({ projectRoot: root, knownRuleIds: known })),
		sorted(ref.checkDetectorIgnores({ projectRoot: root, knownRuleIds: known })),
	);
	check(
		"checkDetectorIgnores(no registry)",
		sorted(port.checkDetectorIgnores({ projectRoot: root, knownRuleIds: null })),
		sorted(ref.checkDetectorIgnores({ projectRoot: root, knownRuleIds: null })),
	);

	// ─── Retired live state ─────────────────────────────────────────────
	check("checkLegacyLiveState(clean)", port.checkLegacyLiveState({ projectRoot: root }), ref.checkLegacyLiveState({ projectRoot: root }));
	write(".impeccable-live.json", "{}");
	check("checkLegacyLiveState(present)", sorted(port.checkLegacyLiveState({ projectRoot: root })), sorted(ref.checkLegacyLiveState({ projectRoot: root })));

	// ─── Workspace sweep ────────────────────────────────────────────────
	write("PRODUCT.md", "# Repo\n\n## Platform\nweb\n");
	write("apps/native/ios/Podfile", "platform :ios\n");
	write("apps/web/package.json", "{}");
	const candidates = [
		{ name: "native", path: "apps/native", productStatus: "inherited", productPath: "PRODUCT.md", designStatus: "missing", designPath: null },
		{ name: "web", path: "apps/web", productStatus: "inherited", productPath: "PRODUCT.md", designStatus: "missing", designPath: null },
	];
	const portWorkspaces = port.checkWorkspaces({
		repoRoot: root,
		candidates,
		checkNativePlatformEvidence: staleness.checkNativePlatformEvidence,
		extractPlatform: platform.extractPlatform,
		readFile: (filePath) => {
			try {
				return fs.readFileSync(filePath, "utf-8");
			} catch {
				return null;
			}
		},
	});
	const refWorkspaces = ref.checkWorkspaces({
		repoRoot: root,
		candidates,
		checkNativePlatformEvidence: refStaleness.checkNativePlatformEvidence,
		extractPlatform: refPlatform.extractPlatform,
		readFile: (filePath) => {
			try {
				return fs.readFileSync(filePath, "utf-8");
			} catch {
				return null;
			}
		},
	});
	check("checkWorkspaces findings", sorted(portWorkspaces.findings), sorted(refWorkspaces.findings));
	check("checkWorkspaces report", portWorkspaces.workspaces, refWorkspaces.workspaces);
	check("checkWorkspaces(no candidates)", port.checkWorkspaces({ repoRoot: root }), ref.checkWorkspaces({ repoRoot: root }));

	// ─── Git drift ──────────────────────────────────────────────────────
	const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	write("DESIGN.md", "# Design\n");
	write("src/app.css", ".a { color: red; }\n");
	git(["add", "-A"]);
	git(["commit", "-qm", "design plus a style"]);
	for (let i = 0; i < 30; i++) {
		write("src/app.css", `.a { color: red; } /* ${i} */\n`);
		git(["add", "-A"]);
		git(["commit", "-qm", `change ${i}`]);
	}

	check(
		"checkDesignDrift(over threshold)",
		sorted(port.checkDesignDrift({ designPath: path.join(root, "DESIGN.md"), projectRoot: root })),
		sorted(ref.checkDesignDrift({ designPath: path.join(root, "DESIGN.md"), projectRoot: root })),
	);
	check(
		"checkDesignDrift(high threshold is silent)",
		port.checkDesignDrift({ designPath: path.join(root, "DESIGN.md"), projectRoot: root, threshold: 1000 }),
		ref.checkDesignDrift({ designPath: path.join(root, "DESIGN.md"), projectRoot: root, threshold: 1000 }),
	);
	check("checkDesignDrift(no design)", port.checkDesignDrift({ designPath: null, projectRoot: root }), ref.checkDesignDrift({ designPath: null, projectRoot: root }));
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} deep-staleness comparisons failed`);
	process.exit(1);
}
console.log(`deep-staleness parity: ${comparisons} comparisons match the reference`);
