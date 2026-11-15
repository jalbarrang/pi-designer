/**
 * Parity check: the context loader against the reference.
 *
 * Context resolution decides what a whole session is working on, and the failure mode is
 * silent: the wrong project root means the wrong product record, with no error anywhere. These
 * comparisons build real directory trees — a plain repo, a monorepo with workspace globs, a
 * negated pattern, a nested product — and compare what both loaders conclude.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/context.ts");
const ref = await import("../reference/impeccable-js/scripts/context.mjs");
const platform = await import("../extensions/designer/engine/lib/platform.ts");
const refPlatform = await import("../reference/impeccable-js/scripts/context.mjs");

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

// ─── Section and platform reads (string-only) ──────────────────────────────

const products = [
	null,
	"",
	"# P\n\n## Platform\nweb\n",
	"# P\n\n## Platform\nios\n",
	"# P\n\n## Platform\nios, android\n",
	"# P\n\n## Platform\nios and android\n",
	"# P\n\n## Platform\nAdaptive\n",
	"# P\n\n## Platform\nnative app\n",
	"# P\n\n## Platform\n\n## Stack\nNext.js\n",
	"# P\n\n## Platforms\nios\n",
	"# P\n\n## Platform\n  android  \n",
];
for (const product of products) {
	check(`extractPlatform(${JSON.stringify((product ?? "").slice(0, 24))})`, platform.extractPlatform(product), refPlatform.extractPlatform(product));
	for (const heading of ["Platform", "Stack", "Positioning"]) {
		check(`extractSectionValue(${JSON.stringify((product ?? "").slice(0, 16))}, ${heading})`, platform.extractSectionValue(product, heading), refPlatform.extractSectionValue(product, heading));
	}
}

// ─── Resolution over real trees ────────────────────────────────────────────

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-context-"));
const write = (rel, content = "x") => {
	const filePath = path.join(base, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	// A plain repo with a root design record and a nested product with its own.
	write("plain/.git/HEAD");
	write("plain/DESIGN.md", "# Design\n\nbody\n");
	write("plain/PRODUCT.md", "# Product\n\n## Platform\nweb\n");
	write("plain/apps/demo/PRODUCT.md", "# Demo\n\n## Platform\nios\n");
	write("plain/apps/demo/src/App.tsx", "<div />");

	// A monorepo with pnpm workspace globs, a negated pattern, and a marker file.
	write("mono/pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - '!apps/excluded'\n");
	write("mono/PRODUCT.md", "# Repo\n\n## Platform\nweb\n");
	write("mono/apps/a/package.json", "{}");
	write("mono/apps/a/src/App.tsx", "<div />");
	write("mono/apps/b/package.json", "{}");
	write("mono/apps/excluded/package.json", "{}");

	// Impeccable projectRoots win over package manager globs.
	write("rooted/.impeccable/config.json", JSON.stringify({ projectRoots: ["packages/*"] }));
	write("rooted/package.json", JSON.stringify({ workspaces: ["apps/*"] }));
	write("rooted/packages/x/package.json", "{}");
	write("rooted/apps/y/package.json", "{}");

	const cases = [
		[path.join(base, "plain"), {}],
		[path.join(base, "plain/apps/demo"), {}],
		[path.join(base, "plain"), { targetPath: "apps/demo/src/App.tsx" }],
		[path.join(base, "mono"), {}],
		[path.join(base, "mono/apps/a"), {}],
		[path.join(base, "mono"), { targetPath: "apps/b" }],
		[path.join(base, "mono"), { targetPath: "apps/excluded" }],
		[path.join(base, "rooted"), {}],
		[path.join(base, "rooted"), { targetPath: "packages/x" }],
		[path.join(base, "rooted"), { targetPath: "apps/y" }],
	];

	for (const [cwd, options] of cases) {
		const label = `${path.relative(base, cwd) || "."}${options.targetPath ? ` --target ${options.targetPath}` : ""}`;
		check(`resolveContextDir(${label})`, path.relative(base, port.resolveContextDir(cwd, options)), path.relative(base, ref.resolveContextDir(cwd, options)));
		check(`resolveProjectRoot(${label})`, path.relative(base, port.resolveProjectRoot(cwd, options)), path.relative(base, ref.resolveProjectRoot(cwd, options)));
		check(`isMonorepo(${label})`, port.resolveContext(cwd, options).isMonorepo, ref.loadContext(cwd, options).isMonorepo);

		const portLoaded = port.loadContext(cwd, options);
		const refLoaded = ref.loadContext(cwd, options);
		check(`loadContext.platform(${label})`, portLoaded.platform, refLoaded.platform);
		check(`loadContext.productPath(${label})`, portLoaded.productPath, refLoaded.productPath);
		check(`loadContext.designPath(${label})`, portLoaded.designPath, refLoaded.designPath);
		check(`loadContext.contextDir(${label})`, path.relative(base, portLoaded.contextDir), path.relative(base, refLoaded.contextDir));
		check(`loadContext.hasProduct(${label})`, portLoaded.hasProduct, refLoaded.hasProduct);
		check(`loadContext.hasVisualImplementation(${label})`, portLoaded.hasVisualImplementation, refLoaded.hasVisualImplementation);
		check(`loadContext.surfaceBriefReason(${label})`, portLoaded.surfaceBriefReason, refLoaded.surfaceBriefReason);
	}

	// Candidate discovery, including the negated pattern and the two-glob mismatch.
	for (const repo of ["mono", "rooted"]) {
		const cwd = path.join(base, repo);
		check(
			`discoverTargetCandidates(${repo})`,
			port.discoverTargetCandidates(cwd).map((c) => `${c.path}|${c.name}|${c.productStatus}|${c.designStatus}`),
			ref.resolveTargetSelection(cwd)?.targetCandidates?.map((c) => `${c.path}|${c.name}|${c.productStatus}|${c.designStatus}`) ?? [],
		);
		check(`resolveTargetSelection(${repo})`, port.resolveTargetSelection(cwd)?.targetCandidates?.length ?? null, ref.resolveTargetSelection(cwd)?.targetCandidates?.length ?? null);
	}

	// A project with real tokens counts as having a visual world; a bare scaffold does not.
	write("visual/src/theme.css", ":root { --brand: #8c2f1e; --paper: #f5efe3; --ink: #241c16; }");
	write("visual/src/App.tsx", "export const A = () => <div className=\"a b c d e f g h i j k l\" />;");
	write("bare/src/App.tsx", "export const A = () => <div />;");
	check(
		"hasVisualImplementation(tokenized theme)",
		port.hasVisualImplementation(path.join(base, "visual")),
		ref.hasVisualImplementation(path.join(base, "visual")),
	);
	check("hasVisualImplementation(bare scaffold)", port.hasVisualImplementation(path.join(base, "bare")), ref.hasVisualImplementation(path.join(base, "bare")));
	check("hasVisualImplementation(null)", port.hasVisualImplementation(null), ref.hasVisualImplementation(null));
} finally {
	fs.rmSync(base, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} context comparisons failed`);
	process.exit(1);
}
console.log(`context parity: ${comparisons} comparisons match the reference`);
