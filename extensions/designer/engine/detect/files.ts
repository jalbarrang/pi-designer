/**
 * File walker and project discovery for the detector. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The walk is deliberately narrow: only files whose extension can hold UI source, and
 * only directories that are not tooling. A hidden directory is skipped wholesale, which
 * is what keeps a vendored harness install or a cache from being reported as findings,
 * with three named exceptions where real source conventionally lives hidden.
 */
import fs from "node:fs";
import path from "node:path";

/** Build and dependency directories, skipped by name. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "__pycache__"]);

/** Hidden directories that hold real UI source rather than tooling. */
const HIDDEN_SOURCE_DIRS: ReadonlySet<string> = new Set([".vitepress", ".vuepress", ".storybook"]);

/** Extensions whose content the detector can read. */
const SCANNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".html", ".htm", ".css", ".scss", ".sass", ".less",
	".jsx", ".tsx", ".js", ".ts",
	".vue", ".svelte", ".astro", ".blade.php",
]);

/** Extensions that hold a whole page. */
const HTML_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm"]);

/** True when the filename's extension is one the detector scans, including double extensions like `.blade.php`. */
function hasScannableExtension(filename: string): boolean {
	const lower = filename.toLowerCase();
	if (SCANNABLE_EXTENSIONS.has(path.extname(lower))) return true;
	for (const ext of SCANNABLE_EXTENSIONS) {
		// A double extension (`.blade.php`) never matches `path.extname` alone.
		if (ext.indexOf(".", 1) !== -1 && lower.endsWith(ext)) return true;
	}
	return false;
}

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
	/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g,
	/@import\s+(?:url\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/g,
	/@(?:use|forward)\s+['"]([^'"]+)['"]/g,
];

/** Every scannable file under `dir`, recursively. Unreadable directories yield nothing. */
function walkDir(dir: string): string[] {
	const files: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		if (entry.isDirectory() && entry.name.startsWith(".") && !HIDDEN_SOURCE_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkDir(full));
		else if (hasScannableExtension(entry.name)) files.push(full);
	}
	return files;
}

/** Resolve a relative import to a file in the set, honoring extension-less and index-file conventions. */
function resolveImport(specifier: string, fromDir: string, fileSet: ReadonlySet<string>): string | null {
	if (!/^[./]/.test(specifier)) return null; // bare specifiers are not project files
	const base = path.resolve(fromDir, specifier);
	if (fileSet.has(base)) return base;
	for (const ext of SCANNABLE_EXTENSIONS) {
		const withExt = base + ext;
		if (fileSet.has(withExt)) return withExt;
	}
	for (const ext of SCANNABLE_EXTENSIONS) {
		const indexFile = path.join(base, `index${ext}`);
		if (fileSet.has(indexFile)) return indexFile;
	}
	return null;
}

/** Which scanned file imports which: the multi-file awareness a scan needs. */
function buildImportGraph(files: readonly string[]): Map<string, Set<string>> {
	const fileSet = new Set(files);
	const graph = new Map<string, Set<string>>();

	for (const file of files) {
		const content = fs.readFileSync(file, "utf-8");
		const dir = path.dirname(file);
		const imports = new Set<string>();

		for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
			pattern.lastIndex = 0;
			for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
				const resolved = resolveImport(match[1], dir, fileSet);
				if (resolved) imports.add(resolved);
			}
		}

		graph.set(file, imports);
	}
	return graph;
}

/** How to recognize a framework's dev server: a response header, or a body marker. */
export interface FrameworkFingerprint {
	readonly header?: string;
	readonly value?: RegExp | null;
	readonly body?: RegExp;
}

/** One framework the detector knows how to find a dev server for. */
export interface FrameworkConfig {
	readonly name: string;
	readonly files: readonly string[];
	readonly defaultPort: number;
	readonly portRe: RegExp;
	readonly fingerprint: FrameworkFingerprint;
}

const FRAMEWORK_CONFIGS: readonly FrameworkConfig[] = [
	{ name: "Next.js", files: ["next.config.js", "next.config.mjs", "next.config.ts"], defaultPort: 3000, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { header: "x-powered-by", value: /next/i } },
	{ name: "SvelteKit", files: ["svelte.config.js", "svelte.config.ts"], defaultPort: 5173, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { header: "x-sveltekit-page", value: null } },
	{ name: "Nuxt", files: ["nuxt.config.js", "nuxt.config.ts"], defaultPort: 3000, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { header: "x-powered-by", value: /nuxt/i } },
	{ name: "Vite", files: ["vite.config.js", "vite.config.ts", "vite.config.mjs"], defaultPort: 5173, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { body: /@vite\/client/ } },
	{ name: "Astro", files: ["astro.config.js", "astro.config.ts", "astro.config.mjs"], defaultPort: 4321, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { body: /astro/i } },
	{ name: "Angular", files: ["angular.json"], defaultPort: 4200, portRe: /"port"\s*:\s*(\d+)/, fingerprint: { body: /ng-version/i } },
	{ name: "Remix", files: ["remix.config.js", "remix.config.ts"], defaultPort: 3000, portRe: /port\s*[:=]\s*(\d+)/, fingerprint: { header: "x-powered-by", value: /remix/i } },
];

/** What a project's dev server looks like, when a known framework config is present. */
export interface DetectedFramework {
	readonly name: string;
	readonly port: number;
	readonly configPath: string;
	readonly fingerprint: FrameworkFingerprint;
}

/** The framework and dev-server port a directory declares, or null when none does. */
function detectFrameworkConfig(dir: string): DetectedFramework | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	const entrySet = new Set(entries);

	for (const cfg of FRAMEWORK_CONFIGS) {
		const match = cfg.files.find((f) => entrySet.has(f));
		if (!match) continue;

		const configPath = path.join(dir, match);
		let port = cfg.defaultPort;
		try {
			const content = fs.readFileSync(configPath, "utf-8");
			const portMatch = content.match(cfg.portRe);
			if (portMatch) port = parseInt(portMatch[1], 10);
		} catch {
			// Unreadable config: the default port is the best available answer.
		}

		return { name: cfg.name, port, configPath, fingerprint: cfg.fingerprint };
	}
	return null;
}

/** The result of probing a dev server: whether something answers, and whether it is the expected one. */
export interface PortProbe {
	readonly listening: boolean;
	readonly matched?: boolean;
}

/**
 * Is a port listening, and does it answer as the expected framework? Without a
 * fingerprint this is a plain TCP probe; with one, it is an HTTP probe whose header or
 * body has to match, so a different app on the same port is reported as a mismatch
 * rather than mistaken for the project.
 */
async function isPortListening(port: number, fingerprint: FrameworkFingerprint | null = null): Promise<PortProbe> {
	if (!fingerprint) {
		const net = await import("node:net");
		return new Promise<PortProbe>((resolve) => {
			const sock = net.default.createConnection({ port, host: "127.0.0.1" });
			sock.setTimeout(500);
			sock.on("connect", () => {
				sock.destroy();
				resolve({ listening: true, matched: true });
			});
			sock.on("error", () => resolve({ listening: false }));
			sock.on("timeout", () => {
				sock.destroy();
				resolve({ listening: false });
			});
		});
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(`http://localhost:${port}/`, { signal: controller.signal, redirect: "follow" });
		clearTimeout(timeout);

		if (fingerprint.header) {
			const val = res.headers.get(fingerprint.header);
			if (val && (!fingerprint.value || fingerprint.value.test(val))) return { listening: true, matched: true };
		}

		if (fingerprint.body) {
			const body = await res.text();
			if (fingerprint.body.test(body)) return { listening: true, matched: true };
		}

		// Something answers, but it is not this project.
		return { listening: true, matched: false };
	} catch {
		return { listening: false };
	}
}

export {
	buildImportGraph,
	detectFrameworkConfig,
	FRAMEWORK_CONFIGS,
	hasScannableExtension,
	HIDDEN_SOURCE_DIRS,
	HTML_EXTENSIONS,
	isPortListening,
	resolveImport,
	SCANNABLE_EXTENSIONS,
	SKIP_DIRS,
	walkDir,
};
