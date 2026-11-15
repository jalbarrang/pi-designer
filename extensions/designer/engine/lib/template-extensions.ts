/**
 * One owner for "which file extensions hold UI markup". Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Before this existed, the answer was spelled out in three places and the lists drifted: the
 * detector learned configurable server-template extensions while another path kept six
 * frontend defaults, so a Phoenix project got findings on `.heex` files but "markers not found"
 * on accept.
 *
 * Extensions match the END of the filename, not `path.extname`, so double extensions like
 * `.blade.php`, `.html.erb`, and `.html.heex` work.
 */
import fs from "node:fs";
import path from "node:path";

/** Built-in markup extensions for the wrap/accept source search. */
const LIVE_TEMPLATE_EXTENSIONS: readonly string[] = Object.freeze([
	".html", ".jsx", ".tsx", ".vue", ".svelte", ".astro",
	// Elixir: Phoenix function components put `~H"""` templates directly in `lib/**/*.ex`, and
	// `.heex`/`.eex` cover standalone templates. `.exs` is deliberately absent — those are
	// scripts (`mix.exs`, config, tests) and never hold markup, so including them only gives a
	// query a chance to match build config by accident.
	".ex", ".heex", ".eex",
]);

/** One configured extension and the analyzer it asks for. */
export interface ExtensionEntry {
	readonly ext: string;
	readonly engine: "html" | "text";
}

/**
 * Normalize `detector.extensions` entries to `{ ext, engine }`. Accepts objects or bare
 * strings; `engine` defaults to `html`, which is the common case for server templates.
 */
function normalizeExtensionEntries(entries: unknown): ExtensionEntry[] {
	if (!Array.isArray(entries)) return [];
	const out: ExtensionEntry[] = [];

	for (const entry of entries) {
		const raw = typeof entry === "string" ? entry : (entry as { ext?: unknown } | null)?.ext;
		if (typeof raw !== "string") continue;

		let ext = raw.trim().toLowerCase();
		if (!ext) continue;
		if (!ext.startsWith(".")) ext = `.${ext}`;

		const engine = typeof entry !== "string" && (entry as { engine?: unknown })?.engine === "text" ? "text" : "html";
		out.push({ ext, engine });
	}
	return out;
}

/** Merge two extension lists, later entries winning per extension. */
function mergeExtensions(existing: unknown, incoming: unknown): ExtensionEntry[] {
	const map = new Map<string, ExtensionEntry>();
	for (const entry of normalizeExtensionEntries(existing)) map.set(entry.ext, entry);
	for (const entry of normalizeExtensionEntries(incoming)) map.set(entry.ext, entry);
	return Array.from(map.values());
}

/**
 * The configured entry matching a filename, or null.
 *
 * The longest matching suffix wins, so `.blade.php` beats a broader `.php` entry regardless of
 * config order.
 */
function matchConfiguredExtension(filePath: string, extensions: unknown): ExtensionEntry | null {
	if (!Array.isArray(extensions) || extensions.length === 0) return null;

	const name = path.basename(String(filePath || "")).toLowerCase();
	if (!name) return null;

	let best: ExtensionEntry | null = null;
	for (const entry of normalizeExtensionEntries(extensions)) {
		if (name.length > entry.ext.length && name.endsWith(entry.ext) && (!best || entry.ext.length > best.ext.length)) {
			best = entry;
		}
	}
	return best;
}

/**
 * True when the filename ends in one of `extensions`.
 *
 * Suffix matching rather than `path.extname` equality, so a configured `.html.erb` matches
 * `show.html.erb`, whose extname is only `.erb`. The length guard keeps a file literally named
 * `.heex` from counting as a template.
 */
function matchesTemplateExtension(filePath: string, extensions: readonly string[]): boolean {
	const name = path.basename(String(filePath || "")).toLowerCase();
	if (!name) return false;
	for (const ext of extensions) {
		if (name.length > ext.length && name.endsWith(ext)) return true;
	}
	return false;
}

// The resolver is called once per candidate query per pass, and every call would otherwise
// re-read and re-parse both config files. Keyed by cwd; one process never rewrites its own
// config mid-run.
const extensionCache = new Map<string, readonly string[]>();

/** Built-in extensions plus any the project configured for the detector. */
function resolveLiveTemplateExtensions(cwd: string = process.cwd()): readonly string[] {
	const cached = extensionCache.get(cwd);
	if (cached) return cached;

	const resolved = readLiveTemplateExtensions(cwd);
	extensionCache.set(cwd, resolved);
	return resolved;
}

/** Test seam: drop the memoized config so a fixture can rewrite `config.json`. */
function clearTemplateExtensionCache(): void {
	extensionCache.clear();
}

/** Reading `detector.extensions` here is the point: a project teaches one place, not three. */
function readLiveTemplateExtensions(cwd: string): readonly string[] {
	const configured: ExtensionEntry[] = [];
	for (const name of ["config.json", "config.local.json"]) {
		const raw = safeReadJson(path.join(cwd, ".impeccable", name));
		const detector = raw?.detector;
		if (detector && typeof detector === "object" && !Array.isArray(detector)) {
			configured.push(...normalizeExtensionEntries((detector as { extensions?: unknown }).extensions));
		}
	}

	const seen = new Set(LIVE_TEMPLATE_EXTENSIONS);
	const out = [...LIVE_TEMPLATE_EXTENSIONS];
	for (const { ext } of configured) {
		if (seen.has(ext)) continue;
		seen.add(ext);
		out.push(ext);
	}
	return out;
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export {
	clearTemplateExtensionCache,
	LIVE_TEMPLATE_EXTENSIONS,
	matchConfiguredExtension,
	matchesTemplateExtension,
	mergeExtensions,
	normalizeExtensionEntries,
	resolveLiveTemplateExtensions,
};
