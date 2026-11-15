/**
 * How a project expresses its Content Security Policy, which decides whether a scan can start a
 * browser at all: a page whose CSP forbids the page-side script is a scan that silently returns
 * nothing. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * It reports a shape, not a verdict. The shapes are ordered by how safe a patch would be:
 * structured directive arrays before string splices, and runtime or meta-tag injection last,
 * because those are the ones no tool can reliably rewrite.
 */
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".next",
	".turbo",
	".svelte-kit",
	".nuxt",
	".astro",
	"dist",
	"build",
	"out",
	".vercel",
]);

const SCAN_EXTS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);
const LAYOUT_EXTS: ReadonlySet<string> = new Set([".tsx", ".jsx", ".astro", ".vue", ".svelte", ".html"]);
const MAX_DEPTH = 6;
const MAX_READ_BYTES = 64 * 1024;

/** Signals that a policy is expressed as structured directive arrays. */
const MONOREPO_HELPER_SIGNALS: readonly RegExp[] = [
	/\bbuildCSPConfig\b/,
	/\bbuildSecurityHeaders\b/,
	/\badditionalScriptSrc\b/,
	/\badditionalConnectSrc\b/,
	/\bcreateBaseNextConfig\b/,
];
const SVELTEKIT_CSP_SIGNALS: readonly RegExp[] = [/\bkit\s*:/, /\bcsp\s*:/, /\bdirectives\s*:/];
const NUXT_SECURITY_SIGNALS: readonly RegExp[] = [/['"]nuxt-security['"]/, /\bcontentSecurityPolicy\b/];

/** Signals that a policy is written as a literal header string. */
const INLINE_HEADER_SIGNALS: readonly RegExp[] = [/["']Content-Security-Policy["']/i, /\bscript-src\b/, /\bconnect-src\b/];

const MIDDLEWARE_HINT = /headers\.set\(\s*["']Content-Security-Policy["']/i;
const META_TAG_HINT = /http-equiv\s*=\s*["']Content-Security-Policy["']/i;

/** How a policy is written, or null when the project has none this check can find. */
type CspShape = "append-arrays" | "append-string" | "middleware" | "meta-tag" | null;

interface CspResult {
	readonly shape: CspShape;
	readonly signals: readonly string[];
}

/** Walk the project, reading only the head of each candidate file. */
function walk(root: string, dir: string, depth: number, visit: (absPath: string, relPath: string, body: string) => void): void {
	if (depth > MAX_DEPTH) return;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(root, abs, depth + 1, visit);
			continue;
		}
		if (!entry.isFile()) continue;

		const ext = path.extname(entry.name);
		if (!SCAN_EXTS.has(ext) && !LAYOUT_EXTS.has(ext)) continue;

		let body: string;
		try {
			const fd = fs.openSync(abs, "r");
			try {
				const buf = Buffer.alloc(MAX_READ_BYTES);
				const read = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
				body = buf.subarray(0, read).toString("utf-8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			continue;
		}

		visit(abs, path.relative(root, abs), body);
	}
}

/**
 * The policy shape a project uses, and the files that carry it.
 *
 * Priority is append-arrays, then append-string, then middleware, then meta-tag: a structured
 * patch is safer than a string splice, and runtime or HTML injection is what no tool rewrites
 * reliably.
 */
function detectCsp(cwd: string = process.cwd()): CspResult {
	const hits = { appendArrays: [] as string[], appendString: [] as string[], middleware: [] as string[], metaTag: [] as string[] };

	walk(cwd, cwd, 0, (absPath, relPath, body) => {
		const ext = path.extname(absPath);
		const base = path.basename(absPath).toLowerCase();
		const isConfig = (name: string) => new RegExp(`(^|/)${name}\\.config\\.`).test(relPath);

		// A monorepo CSP helper: packages/*/src/**/(config|next-config|security)/*
		if (SCAN_EXTS.has(ext) && /packages\/[^/]+\/src\/.*(config|next-config|security)/.test(relPath) && MONOREPO_HELPER_SIGNALS.some((re) => re.test(body))) {
			hits.appendArrays.push(relPath);
			return;
		}

		if (SCAN_EXTS.has(ext) && isConfig("svelte") && SVELTEKIT_CSP_SIGNALS.every((re) => re.test(body))) {
			hits.appendArrays.push(relPath);
			return;
		}

		if (SCAN_EXTS.has(ext) && isConfig("nuxt") && NUXT_SECURITY_SIGNALS.every((re) => re.test(body))) {
			hits.appendArrays.push(relPath);
			return;
		}

		// An inline header in a framework config. Nuxt's routeRules is a sub-shape of
		// append-string with the same patch mechanism, so it lands here too.
		if (SCAN_EXTS.has(ext) && /(^|\/)(next|nuxt|vite|astro|svelte)\.config\./.test(relPath) && INLINE_HEADER_SIGNALS.every((re) => re.test(body))) {
			hits.appendString.push(relPath);
			return;
		}

		// Shapes no tool rewrites: a runtime middleware and a meta tag in a layout.
		if ((base === "middleware.ts" || base === "middleware.js" || base === "middleware.mjs") && MIDDLEWARE_HINT.test(body)) {
			hits.middleware.push(relPath);
		}

		if (LAYOUT_EXTS.has(ext) && META_TAG_HINT.test(body)) {
			hits.metaTag.push(relPath);
		}
	});

	if (hits.appendArrays.length > 0) return { shape: "append-arrays", signals: hits.appendArrays };
	if (hits.appendString.length > 0) return { shape: "append-string", signals: hits.appendString };
	if (hits.middleware.length > 0) return { shape: "middleware", signals: hits.middleware };
	if (hits.metaTag.length > 0) return { shape: "meta-tag", signals: hits.metaTag };
	return { shape: null, signals: [] };
}

export { detectCsp, LAYOUT_EXTS, MAX_DEPTH, MAX_READ_BYTES, SCAN_EXTS, SKIP_DIRS };
export type { CspResult, CspShape };
