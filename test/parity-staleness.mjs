/**
 * Parity check: the staleness checks against the reference.
 *
 * Each check is a handful of stats and one short read, so a fixture tree can exercise every
 * branch: a retired PRODUCT.md section, a missing stamp, native evidence on a web record, a
 * sidecar in a retired location, an unread config key, an orphaned brief.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/staleness.ts");
const ref = await import("../reference/impeccable-js/scripts/lib/staleness.mjs");

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

function sorted(findings) {
	return findings.map((f) => `${f.id}|${f.severity}|${f.path ?? ""}|${f.summary}`).sort();
}

// ─── Products ──────────────────────────────────────────────────────────────

const products = [
	null,
	"# Product\n\n## Register: brand-forward\n",
	"# Product\n\n## Positioning\n",
	"# Product\n\n<!-- impeccable:product-schema 1 -->\n",
	"# Product\n\n<!-- impeccable:product-schema 0 -->\n",
	"# Product\n\nplain prose only\n",
	"# Product\n\n## Register\n## Positioning\n",
];
for (const product of products) {
	check(`checkProduct(${JSON.stringify((product ?? "").slice(0, 24))})`, sorted(port.checkProduct(product, "PRODUCT.md")), sorted(ref.checkProduct(product, "PRODUCT.md")));
}

// ─── Fixture tree for the fs-backed checks ─────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-staleness-"));
const write = (rel, content) => {
	const filePath = path.join(root, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	// Native evidence on a project whose product says web.
	write("PRODUCT.md", "# Product\n\n## Platform: web\n");
	write("ios/Podfile", "platform :ios\n");
	write("package.json", JSON.stringify({ dependencies: { "react-native": "^0.7.0" } }));
	const platformFinding = port.checkNativePlatformEvidence({ projectRoot: root, platform: "web", product: "# x", productPath: "PRODUCT.md" });
	check(
		"checkNativePlatformEvidence(web with native files)",
		sorted(platformFinding),
		sorted(ref.checkNativePlatformEvidence({ projectRoot: root, platform: "web", product: "# x", productPath: "PRODUCT.md" })),
	);
	check(
		"checkNativePlatformEvidence(native platform is skipped)",
		port.checkNativePlatformEvidence({ projectRoot: root, platform: "ios", product: "# x" }),
		ref.checkNativePlatformEvidence({ projectRoot: root, platform: "ios", product: "# x" }),
	);

	// Sidecar in the retired location, older schema, older than DESIGN.md.
	write("DESIGN.json", JSON.stringify({ tokens: {} }));
	write("DESIGN.md", "# Design\n");
	const sidecarCandidates = port.designSidecarCandidatesFor(root);
	check("designSidecarCandidatesFor", sidecarCandidates, ref.designSidecarCandidatesFor(root));
	check(
		"checkDesignSidecar(legacy path)",
		sorted(port.checkDesignSidecar({ designPath: path.join(root, "DESIGN.md"), sidecarCandidates, projectRoot: root })),
		sorted(ref.checkDesignSidecar({ designPath: path.join(root, "DESIGN.md"), sidecarCandidates, projectRoot: root })),
	);

	// Config drift: unknown key, bad build path, unknown detector key.
	write(".impeccable/config.json", JSON.stringify({ hook: {}, detector: { ignoreRule: ["x"] }, buildPath: "bogus", mystery: true }));
	check("checkConfig", sorted(port.checkConfig({ projectRoot: root, repoRoot: root })), sorted(ref.checkConfig({ projectRoot: root, repoRoot: root })));

	// A project with direction work and no buildPath: only fired without a declared value.
	fs.mkdirSync(path.join(root, ".impeccable", "surfaces"), { recursive: true });
	check(
		"checkBuildPathUnset(declared value ends it)",
		port.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: "# P" }),
		ref.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: "# P" }),
	);
	fs.rmSync(path.join(root, ".impeccable", "config.json"));
	check(
		"checkBuildPathUnset(unset, with direction work)",
		sorted(port.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: "# P" })),
		sorted(ref.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: "# P" })),
	);
	check(
		"checkBuildPathUnset(no product is silent)",
		port.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: null }),
		ref.checkBuildPathUnset({ projectRoot: root, repoRoot: root, product: null }),
	);

	// Orphaned surface brief.
	const briefCandidates = [
		{ path: ".impeccable/surfaces/gone.md", primaryTarget: "src/gone.tsx" },
		{ path: ".impeccable/surfaces/route.md", primaryTarget: "route:/pricing" },
		{ path: ".impeccable/surfaces/live.md", primaryTarget: "https://example.com/x" },
	];
	check(
		"checkSurfaceBriefs(orphaned)",
		sorted(port.checkSurfaceBriefs({ candidates: briefCandidates, projectRoot: root })),
		sorted(ref.checkSurfaceBriefs({ candidates: briefCandidates, projectRoot: root })),
	);

	// projectRoots that match nothing.
	check(
		"checkProjectRoots(no candidates)",
		sorted(port.checkProjectRoots({ patterns: ["apps/*", "!packages/x"], candidates: [] })),
		sorted(ref.checkProjectRoots({ patterns: ["apps/*", "!packages/x"], candidates: [] })),
	);
	check(
		"checkProjectRoots(candidates exist)",
		port.checkProjectRoots({ patterns: ["apps/*"], candidates: [{ name: "a", path: "apps/a" }] }),
		ref.checkProjectRoots({ patterns: ["apps/*"], candidates: [{ name: "a", path: "apps/a" }] }),
	);

	// The grouped boot report, which is the shape the context loader consumes.
	const ctx = { projectRoot: root, repoRoot: root, product: "# Product\n\n## Register\n", productPath: "PRODUCT.md", designPath: "DESIGN.md", surfaceBriefCandidates: briefCandidates };
	const extras = { absDesignPath: path.join(root, "DESIGN.md"), sidecarCandidates, projectRootPatterns: ["apps/*"], targetCandidates: [] };
	const portGroups = port.collectBootFindingGroups(ctx, extras);
	const refGroups = ref.collectBootFindingGroups(ctx, extras);
	check(
		"collectBootFindingGroups",
		Object.fromEntries(Object.entries(portGroups).map(([key, value]) => [key, sorted(value ?? [])])),
		Object.fromEntries(Object.entries(refGroups).map(([key, value]) => [key, sorted(value ?? [])])),
	);
	check("collectBootFindings", sorted(port.collectBootFindings(ctx, extras)), sorted(ref.collectBootFindings(ctx, extras)));
	check("collectBootFindings(null)", port.collectBootFindings(null), ref.collectBootFindings(null));
	check(
		"describeWorkspaceContext",
		port.describeWorkspaceContext([{ name: "a", path: "apps/a", productStatus: "inherited" }]),
		ref.describeWorkspaceContext([{ name: "a", path: "apps/a", productStatus: "inherited" }]),
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} staleness comparisons failed`);
	process.exit(1);
}
console.log(`staleness parity: ${comparisons} comparisons match the reference`);
