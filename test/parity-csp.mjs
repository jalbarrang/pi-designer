/**
 * Parity check: CSP shape detection against the reference.
 *
 * The shape decides whether a scan can patch a project's policy or has to report it and stop, so
 * the precedence between shapes matters more than a single hit: a project with both a structured
 * helper and a meta tag must land on the structured one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = await import("../extensions/designer/engine/lib/detect-csp.ts");
const ref = await import("../reference/impeccable-js/scripts/detect-csp.mjs");

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-csp-"));
const write = (rel, content) => {
	const filePath = path.join(root, rel);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
};

try {
	check("empty project", port.detectCsp(root), ref.detectCsp(root));

	// A structured monorepo helper wins over everything else.
	write("packages/web/src/config/security.ts", "export const buildCSPConfig = () => ({ scriptSrc: [] });\n");
	write("src/layouts/base.astro", '<meta http-equiv="Content-Security-Policy" content="script-src self">\n');
	check("append-arrays (monorepo helper)", port.detectCsp(root), ref.detectCsp(root));
	check("append-arrays shape", port.detectCsp(root).shape, "append-arrays");

	const clean = (rel) => fs.rmSync(path.join(root, rel), { recursive: true, force: true });

	// SvelteKit's kit.csp.directives.
	clean("packages");
	clean("src");
	write("svelte.config.js", "export default { kit: { csp: { directives: { 'script-src': ['self'] } } } };\n");
	check("append-arrays (sveltekit)", port.detectCsp(root), ref.detectCsp(root));
	clean("svelte.config.js");

	// Nuxt's security module.
	write("nuxt.config.ts", "export default defineNuxtConfig({ modules: ['nuxt-security'], security: { contentSecurityPolicy: {} } });\n");
	check("append-arrays (nuxt security)", port.detectCsp(root), ref.detectCsp(root));
	clean("nuxt.config.ts");

	// A literal header string in a framework config.
	write("next.config.mjs", 'export default { headers: () => [{ key: "Content-Security-Policy", value: "script-src self; connect-src self" }] };\n');
	check("append-string", port.detectCsp(root), ref.detectCsp(root));
	check("append-string shape", port.detectCsp(root).shape, "append-string");
	clean("next.config.mjs");

	// Shapes nothing rewrites.
	write("middleware.ts", 'export function middleware(res) { res.headers.set("Content-Security-Policy", "default-src self"); }\n');
	check("middleware", port.detectCsp(root), ref.detectCsp(root));
	clean("middleware.ts");

	write("src/routes/+layout.svelte", '<svelte:head><meta http-equiv="Content-Security-Policy" content="default-src self"></svelte:head>\n');
	check("meta-tag", port.detectCsp(root), ref.detectCsp(root));
	check("meta-tag shape", port.detectCsp(root).shape, "meta-tag");

	// A skipped directory is never read, even when it holds a policy.
	clean("src");
	write("node_modules/pkg/next.config.mjs", 'export default { key: "Content-Security-Policy", value: "script-src connect-src" };\n');
	check("skips node_modules", port.detectCsp(root), ref.detectCsp(root));
	clean("node_modules");

	// A config that mentions the header without the full signal set is not a hit.
	write("vite.config.ts", "export default { plugins: [] };\n");
	check("config without signals", port.detectCsp(root), ref.detectCsp(root));
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} CSP comparisons failed`);
	process.exit(1);
}
console.log(`detect-csp parity: ${comparisons} comparisons match the reference`);
