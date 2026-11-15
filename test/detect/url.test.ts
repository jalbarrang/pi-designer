/**
 * Checks for the URL engine: the URL/credential split, design system serialization, and the
 * orchestration's order and cleanup against a fake browser.
 *
 * The browser is the seam, so a stub page can assert the things that matter: the scan is
 * injected after configuration, hidden content is measured after the main scan, page errors
 * are deduped and capped, the page is always closed, and a finding's severity and waiver
 * value survive the mapping.
 */

import * as port from "../../extensions/designer/engine/detect/browser/url.ts";
import { normalizeDesignSystem } from "../../extensions/designer/engine/detect/design-system.ts";
import type { BrowserLike, BrowserPage } from "../../extensions/designer/engine/detect/browser/url.ts";
import type { HiddenTextMeasurement } from "../../extensions/designer/engine/core/checks/text-visibility.ts";
import { check } from "../helpers/check.ts";

// ─── URL splitting ────────────────────────────────────────────────────────

// Credentials belong in the auth header, never in the URL the page navigates to.
const credentialUrls: ReadonlyArray<readonly [string, string, string | null]> = [
	["https://user:pass@example.com/secret", "https://example.com/secret", "user:pass"],
	["https://us%40er:p%40ss@example.com/", "https://example.com/", "us@er:p@ss"],
	["http://user@example.com/", "http://example.com/", "user:"],
	["ftp://user:pass@example.com/file", "ftp://example.com/file", null],
	["https://example.com:8080/x?y=1#z", "https://example.com:8080/x?y=1#z", null],
	["not a url at all", "not a url at all", null],
];
for (const [input, href, credentials] of credentialUrls) {
	const split = port.splitScanUrl(input);
	check(`splitScanUrl(${input}) href`, split.href, href);
	check(
		`splitScanUrl(${input}) credentials`,
		split.credentials ? `${split.credentials.username}:${split.credentials.password}` : null,
		credentials,
	);
}

// ─── Design-system serialization ───────────────────────────────────────────

const designSystem = normalizeDesignSystem({
	frontmatter: {
		colors: { primary: "#8c2f1e", paper: "#f5efe3" },
		typography: { body: { fontFamily: "Inter, sans-serif" } },
		rounded: { sm: "4px", full: "9999px" },
	},
});
check(
	"serializeDesignSystemForBrowser",
	port.serializeDesignSystemForBrowser(designSystem),
	{
		present: true,
		hasFonts: true,
		allowedFonts: ["inter"],
		hasColors: true,
		allowedColors: [
			{ r: 140, g: 47, b: 30 },
			{ r: 245, g: 239, b: 227 },
		],
		hasRadii: true,
		allowedRadii: [4, 9999],
		hasPillRadius: true,
	},
);

// `serializeDesignSystemForBrowser` is internal to the reference; the shape above is asserted
// directly against what the in-page check reads.

// ─── Orchestration (stub browser) ──────────────────────────────────────────

// One group as the page-side scan reports it, which is what the stub hands back.
interface FakeScanGroup {
	readonly selector: string;
	readonly findings: ReadonlyArray<{ readonly type: string; readonly detail: string; readonly severity: string; readonly ignoreValue: string }>;
}

// The stub answers each in-page callback from its source text, so `evaluate` stays loose: one
// cast at the boundary is all the friction the generic page signature needs.
function fakeBrowser({
	groups = [{ selector: ".a", findings: [{ type: "side-tab", detail: "border-left: 4px", severity: "error", ignoreValue: "#c81414" }] }],
	pageErrors = ["boom", "boom", "second"],
	hidden = null,
	contrastFindings = [],
}: {
	groups?: FakeScanGroup[];
	pageErrors?: string[];
	hidden?: HiddenTextMeasurement | null;
	contrastFindings?: unknown[];
} = {}) {
	const events: string[] = [];
	const evaluate = async (fn: unknown): Promise<unknown> => {
		const source = String(fn);
		if (source.includes("__IMPECCABLE_CONFIG__")) {
			events.push("configure");
			return undefined;
		}
		if (source.includes("impeccableDetect")) {
			events.push("scan");
			return groups;
		}
		if (source.includes("impeccableMeasureHiddenText")) {
			events.push("measure");
			return hidden;
		}
		if (source.includes("scrollTo")) {
			events.push("reveal");
			return undefined;
		}
		if (source.includes("impeccableAnalyzeVisualContrast")) {
			events.push("contrast");
			return contrastFindings;
		}
		if (source.includes("impeccableCollectVisualContrastCandidates")) return [];
		if (source.includes("getImageData")) return { glyphPixels: 100, strongestDelta: 300, worstRatio: 1.1, p10Ratio: 1.5, medianRatio: 2 };
		if (source.includes("removeAttribute")) return undefined;
		if (source.includes("data-impeccable-visual-contrast-target")) return true;
		events.push("inject");
		return undefined;
	};
	const page: BrowserPage = {
		async setViewport() {
			events.push("viewport");
		},
		async goto(url: string) {
			events.push(`goto:${url}`);
		},
		evaluate: evaluate as BrowserPage["evaluate"],
		async screenshot() {
			return "base64";
		},
		async close() {
			events.push("close-page");
		},
		on(event: string, listener: (payload: never) => void) {
			if (event !== "pageerror") return;
			// The page reports each error as `{ message }`; the stub's listener only reads that.
			for (const message of pageErrors) (listener as (payload: { readonly message: string }) => void)({ message });
		},
	};
	const browser: BrowserLike & { events: string[] } = {
		events,
		async newPage() {
			events.push("new-page");
			return page;
		},
		async close() {
			events.push("close-browser");
		},
	};
	return browser;
}

{
	const browser = fakeBrowser();
	const findings = await port.detectUrl("https://user:pass@example.com/app", {
		browser,
		browserScript: "/* scan */",
		designSystem,
		settleMs: 0,
	});
	const ids = findings.map((f) => `${f.antipattern}|${f.severity}|${f.snippet}`);
	check("detectUrl findings", ids, ["side-tab|error|border-left: 4px", "script-error|error|boom", "script-error|error|second"]);
	check("detectUrl maps the waiver value", findings[0].ignoreValue, "#c81414");
	check("the page is configured before the scan is injected", browser.events.indexOf("configure") < browser.events.indexOf("inject"), true);
	check("the main scan runs before the reveal sweep", browser.events.indexOf("scan") < browser.events.indexOf("reveal"), true);
	check("the page is always closed", browser.events.includes("close-page"), true);
	check("an external browser is not closed", browser.events.includes("close-browser"), false);
}

{
	const browser = fakeBrowser({ hidden: { totalChars: 1000, hiddenChars: 900, hiddenSamples: ["Hidden copy"] } });
	const findings = await port.detectUrl("https://example.com/", { browser, browserScript: "/* scan */", contentHidden: true });
	check(
		"hidden content is reported after the reveal sweep",
		findings.some((f) => f.antipattern === "content-hidden-at-rest"),
		true,
	);
}

{
	const browser = fakeBrowser();
	const findings = await port.detectUrl("https://example.com/", { browser, browserScript: "/* scan */", contentHidden: false, scriptErrors: false });
	check("hidden content and page errors can be turned off", findings.map((f) => f.antipattern), ["side-tab"]);
}

{
	let threw = null;
	try {
		await port.detectUrl("https://example.com/");
	} catch (error) {
		threw = error instanceof Error ? error.message : String(error);
	}
	check("no browser is a clear error", threw?.includes("pass options.browser"), true);
}

{
	let threw = null;
	try {
		await port.detectUrl("https://example.com/", { browser: { async newPage() { throw new Error("unused"); }, async close() {} } });
	} catch (error) {
		threw = error instanceof Error ? error.message : String(error);
	}
	check("no scan script is a clear error", threw?.includes("options.browserScript"), true);
}
