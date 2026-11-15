/**
 * The HTML parser, loaded lazily.
 *
 * The static-HTML engine takes its parser as an interface rather than importing one, so a host decides
 * what it is willing to carry. This is that decision for pi: the four packages upstream needs are
 * loaded on demand, and a project without them still scans — HTML files fall to the text engine and the
 * report says so, rather than the command failing.
 *
 * The imports are by name at runtime because these are the reference's own packages, and pinning their
 * types here would tie this file to whichever copy happens to be installed.
 */
import type { HtmlModules } from "../detect/static-html/html.ts";

type LoadedModule = Record<string, unknown>;

/** A dynamic import by name, so a missing package is a null result rather than a type error. */
const load = (name: string): Promise<LoadedModule> => import(name) as Promise<LoadedModule>;

/**
 * The parser modules, or null when they are not installed.
 *
 * Loaded once per process: a scan of fifty files must not probe fifty times to discover the same
 * absence.
 */
let cached: Promise<HtmlModules | null> | null = null;

async function loadHtmlModules(): Promise<HtmlModules | null> {
	if (cached) return cached;

	cached = (async () => {
		try {
			const [htmlparser2, cssSelect, csstree, domutils] = await Promise.all([
				load("htmlparser2"),
				load("css-select"),
				load("css-tree"),
				load("domutils"),
			]);
			return { parseDocument: htmlparser2.parseDocument, selectAll: cssSelect.selectAll, selectOne: cssSelect.selectOne, compile: cssSelect.compile, csstree, domutils } as unknown as HtmlModules;
		} catch {
			return null;
		}
	})();

	return cached;
}

/** Forget the memoized result, for a test that stubs the modules. */
function clearHtmlModulesCache(): void {
	cached = null;
}

export { clearHtmlModulesCache, loadHtmlModules };
