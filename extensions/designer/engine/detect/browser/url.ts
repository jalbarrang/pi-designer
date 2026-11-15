/**
 * URL scanning: load the page in a browser, run the in-page scan, then the passes that need
 * a rendered page — hidden content after a reveal sweep, page errors, and pixel contrast.
 * Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The browser arrives as an argument and the page-side scan script arrives as a string. pi
 * drives its own browser and ships its own scan bundle, so neither is imported here; the
 * orchestration — order of passes, cleanup, severity and waiver mapping — is what is ours.
 */
import { finding } from "../../core/findings.ts";
import { checkContentHiddenAtRest, type HiddenTextMeasurement } from "../../core/checks/text-visibility.ts";
import { captureVisualContrastCandidate, type ContrastCandidate, type ContrastFinding, type ScreenshotClip } from "../visual/contrast.ts";
import type { DesignSystem } from "../design-system.ts";
import type { Finding } from "../../types.ts";

/** A page, as far as this module needs one: evaluate, navigate, screenshot, listen. */
export interface BrowserPage {
	evaluate<TArg, TResult>(callback: ((arg: TArg) => TResult | Promise<TResult>) | string, arg?: TArg): Promise<TResult>;
	/** Evaluate a source string in the page (the injected scan bundle). */
	setViewport(viewport: { readonly width: number; readonly height: number }): Promise<void>;
	goto(url: string, options: { readonly waitUntil: string; readonly timeout: number }): Promise<unknown>;
	screenshot(options: { readonly encoding: "base64"; readonly clip: ScreenshotClip; readonly captureBeyondViewport: boolean }): Promise<string>;
	close(): Promise<void>;
	setRequestInterception?(enabled: boolean): Promise<void>;
	on?(event: string, listener: (payload: never) => void): void;
	authenticate?(credentials: { readonly username: string; readonly password: string }): Promise<void>;
}

/** A browser, as far as this module needs one. */
export interface BrowserLike {
	newPage(): Promise<BrowserPage>;
	close(): Promise<void>;
}

/** The Puppeteer surface `launchBrowser` needs, so the caller decides what launches it. */
export interface PuppeteerLike {
	readonly default?: { launch(options: { channel?: string; headless?: boolean; args?: readonly string[] }): Promise<BrowserLike> };
	launch?(options: { channel?: string; headless?: boolean; args?: readonly string[] }): Promise<BrowserLike>;
}

/** One request the page made, for origin-scoped auth. */
export interface RequestLike {
	url(): string;
	headers(): Record<string, string>;
	continue(options?: { headers: Record<string, string> }): Promise<unknown>;
}

/**
 * Launch a browser, preferring a system Chrome on Windows.
 *
 * On Windows, Puppeteer's bundled Chrome lives in a user-writable cache directory, and its
 * GPU process can be denied by security software or the sandbox; Chrome then crash-loops,
 * flashing a black window on every relaunch. A system-installed Chrome runs from a trusted
 * location with a healthy GPU. Other platforms do not have the bug and keep the pinned
 * bundled build for consistent measurement. If the system channel fails, the bundled launch
 * is tried and the original error is kept as its cause.
 */
async function launchBrowser(
	puppeteer: PuppeteerLike,
	{ headless = true, args = [] }: { readonly headless?: boolean; readonly args?: readonly string[] } = {},
): Promise<BrowserLike> {
	const launcher = puppeteer.default ?? puppeteer;
	let channelError: unknown;

	if (process.platform === "win32" && launcher.launch) {
		try {
			return await launcher.launch({ channel: "chrome", headless, args });
		} catch (err) {
			channelError = err;
		}
	}

	try {
		if (!launcher.launch) throw new Error("puppeteer launcher unavailable");
		return await launcher.launch({ headless, args });
	} catch (err) {
		if (channelError && err && typeof err === "object" && (err as { cause?: unknown }).cause === undefined) {
			(err as { cause?: unknown }).cause = channelError;
		}
		throw err;
	}
}

/**
 * Reveal sweep, then re-measure hidden text: scroll the whole document so every
 * IntersectionObserver and scroll-reveal handler fires, return to the top, then ask the page
 * for its measurement. A page whose reveal script died keeps its text invisible.
 */
async function measureContentHiddenAfterReveal(page: BrowserPage): Promise<HiddenTextMeasurement | null> {
	await page.evaluate(async () => {
		const max = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
		const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
		for (let y = 0; y <= max; y += step) {
			window.scrollTo({ top: y, left: 0, behavior: "instant" });
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));
		}
		window.scrollTo({ top: 0, left: 0, behavior: "instant" });
		await new Promise((resolve) => setTimeout(resolve, 700));
	});

	return page.evaluate(() => {
		const measure = (window as unknown as { impeccableMeasureHiddenText?: () => HiddenTextMeasurement }).impeccableMeasureHiddenText;
		return typeof measure === "function" ? measure() : null;
	});
}

/** The design system in the shape the in-page check reads: plain arrays, no Sets or Maps. */
export function serializeDesignSystemForBrowser(designSystem: DesignSystem | null | undefined) {
	if (!designSystem?.present) return null;
	return {
		present: true,
		hasFonts: designSystem.hasFonts === true,
		allowedFonts: Array.from(designSystem.allowedFonts || []),
		hasColors: designSystem.hasColors === true,
		allowedColors: Array.from(designSystem.allowedColorKeys?.values?.() || [])
			.map((entry) => entry?.color)
			.filter((color) => color && Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b))
			.map((color) => ({ r: color.r, g: color.g, b: color.b })),
		hasRadii: designSystem.hasRadii === true,
		allowedRadii: (designSystem.allowedRadii || []).map((entry) => Number(entry?.px)).filter((px) => Number.isFinite(px)),
		hasPillRadius: designSystem.hasPillRadius === true,
	};
}

/** One group as the in-page scan serializes it. */
interface SerializedGroup {
	readonly selector?: string;
	readonly findings?: ReadonlyArray<{ type?: string; detail?: string; ignoreValue?: string; severity?: string }>;
}

/** One candidate the in-page analyzer produced, or the finding it already settled. */
interface VisualContrastAnalysis extends ContrastCandidate {
	readonly finding?: ContrastFinding | null;
	readonly status?: "fail" | "pass" | "unresolved";
}

export interface VisualContrastOptions {
	readonly visualContrast?: boolean;
	readonly visualContrastMaxCandidates?: number;
	readonly visualContrastScrollOffscreen?: boolean;
	readonly visualContrastBrowser?: boolean;
	readonly viewport?: { readonly width: number; readonly height: number };
	readonly candidates?: ReadonlyArray<VisualContrastAnalysis>;
}

/**
 * The pixel-contrast pass: use the in-page analyzer's verdicts where it has them, and
 * measure in pixels for the candidates it left open. Selectors the analytic pass already
 * reported are skipped, so one element never gets two contrast findings.
 */
async function runVisualContrastFallback(
	page: BrowserPage,
	serializedGroups: readonly SerializedGroup[],
	options: VisualContrastOptions | null | undefined,
): Promise<ContrastFinding[]> {
	if (options?.visualContrast === false) return [];

	const maxCandidates = Number.isFinite(options?.visualContrastMaxCandidates) ? (options?.visualContrastMaxCandidates as number) : 12;
	const scrollOffscreen = options?.visualContrastScrollOffscreen !== false;
	const existingLowContrastSelectors = new Set(
		serializedGroups
			.filter((group) => group.findings?.some((f) => f.type === "low-contrast"))
			.map((group) => group.selector)
			.filter((selector): selector is string => !!selector),
	);

	let browserAnalyses: VisualContrastAnalysis[] = [];
	const findings: ContrastFinding[] = [];

	if (options?.visualContrastBrowser !== false) {
		browserAnalyses = await page.evaluate(
			async ({ maxCandidates, scrollOffscreen }: { maxCandidates: number; scrollOffscreen: boolean }) => {
				const analyze = (window as unknown as { impeccableAnalyzeVisualContrast?: (o: { maxCandidates: number; scrollOffscreen: boolean }) => VisualContrastAnalysis[] })
					.impeccableAnalyzeVisualContrast;
				if (typeof analyze !== "function") return [];
				return analyze({ maxCandidates, scrollOffscreen });
			},
			{ maxCandidates, scrollOffscreen },
		);

		findings.push(
			...browserAnalyses
				.filter((result) => result.finding && !existingLowContrastSelectors.has(result.selector))
				.map((result) => result.finding as ContrastFinding),
		);
	}

	let candidates: VisualContrastAnalysis[] = browserAnalyses.length > 0 ? browserAnalyses : [];
	if (candidates.length === 0) {
		candidates = await page.evaluate(
			async ({ maxCandidates }: { maxCandidates: number }) => {
				const collect = (window as unknown as { impeccableCollectVisualContrastCandidates?: (o: { maxCandidates: number }) => VisualContrastAnalysis[] })
					.impeccableCollectVisualContrastCandidates;
				return typeof collect === "function" ? collect({ maxCandidates }) : [];
			},
			{ maxCandidates },
		);
	}

	const viewport = options?.viewport ?? { width: 1280, height: 800 };
	const browserResolvedSelectors = new Set(
		browserAnalyses
			.filter((result) => result.status === "fail" || result.status === "pass")
			.map((result) => result.selector)
			.filter((selector): selector is string => !!selector),
	);

	for (const candidate of candidates) {
		if (existingLowContrastSelectors.has(candidate.selector)) continue;
		if (browserResolvedSelectors.has(candidate.selector)) continue;
		const measured = await captureVisualContrastCandidate(page, candidate, viewport);
		if (measured) findings.push(measured);
	}

	return findings;
}

/** The URL and any credentials it carried, split so they never reach the page as a URL. */
export interface SplitScanUrl {
	readonly href: string;
	readonly credentials: { readonly username: string; readonly password: string } | null;
}

function decodeUrlComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Split basic-auth credentials out of a scan URL: they go in a header, not the URL. */
function splitScanUrl(url: string): SplitScanUrl {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { href: url, credentials: null };
	}

	if (!parsed.username && !parsed.password) return { href: url, credentials: null };

	const credentials =
		parsed.protocol === "http:" || parsed.protocol === "https:"
			? { username: decodeUrlComponent(parsed.username), password: decodeUrlComponent(parsed.password) }
			: null;

	parsed.username = "";
	parsed.password = "";
	return { href: parsed.href, credentials };
}

function basicAuthHeader(credentials: { readonly username: string; readonly password: string }): string {
	return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

/**
 * Attach basic auth to the scan origin only.
 *
 * `page.authenticate` is page-wide, so a cross-origin redirect that then 401s would be
 * handed these credentials. Request interception lets the header go to one origin.
 */
async function applyOriginScopedAuth(
	page: BrowserPage,
	href: string,
	credentials: { readonly username: string; readonly password: string } | null,
): Promise<void> {
	if (!credentials || !page.setRequestInterception || !page.on) return;

	let origin = "";
	try {
		origin = new URL(href).origin;
	} catch {
		return;
	}
	if (!origin) return;

	const header = basicAuthHeader(credentials);
	await page.setRequestInterception(true);
	page.on("request", ((request: RequestLike) => {
		let headers: Record<string, string> | undefined;
		try {
			if (new URL(request.url()).origin === origin) headers = { ...request.headers(), authorization: header };
		} catch {
			// An invalid request URL gets no auth.
		}
		void request.continue(headers ? { headers } : undefined).catch(() => {});
	}) as (payload: never) => void);
}

export interface DetectUrlOptions extends VisualContrastOptions {
	/** The browser to drive. pi supplies its own; without one there is nothing to scan. */
	readonly browser?: BrowserLike | null;
	/** The page-side scan source, evaluated in the page. pi ships its own bundle. */
	readonly browserScript?: string | null;
	readonly waitUntil?: string;
	readonly settleMs?: number;
	readonly designSystem?: DesignSystem | null;
	readonly contentHidden?: boolean;
	readonly scriptErrors?: boolean;
}

/**
 * Scan a URL: load it, inject the page-side scan, collect what it reports, then run the
 * passes that need a rendered page — hidden content after a reveal sweep, page errors, and
 * pixel contrast — and clean up whatever happened.
 */
async function detectUrl(rawUrl: string, options: DetectUrlOptions = {}): Promise<Finding[]> {
	const { href: url, credentials } = splitScanUrl(rawUrl);
	const waitUntil = options.waitUntil || "networkidle0";
	const settleMs = Number.isFinite(options.settleMs) ? (options.settleMs as number) : 0;
	const viewport = options.viewport ?? { width: 1280, height: 800 };
	const externalBrowser = options.browser ?? null;

	if (!externalBrowser) {
		throw new Error("URL scanning needs a browser: pass options.browser (pi supplies its own).");
	}
	if (!options.browserScript) {
		throw new Error("URL scanning needs the page-side scan script: pass options.browserScript.");
	}

	const browser = externalBrowser;
	const page = await browser.newPage();

	// A syntax error fires during the initial parse, long before load, so the listener
	// attaches before navigation. Dedupe by message: one broken loop can throw hundreds.
	const pageErrors: string[] = [];
	if (options.scriptErrors !== false && page.on) {
		page.on("pageerror", ((err: { message?: string }) => {
			const message = String(err?.message || err)
				.split("\n")[0]
				.trim()
				.slice(0, 160);
			if (message && !pageErrors.includes(message)) pageErrors.push(message);
		}) as (payload: never) => void);
	}

	const results: Array<{ id: string; snippet: string; ignoreValue?: string; severity?: string }> = [];

	try {
		await page.setViewport(viewport);
		await applyOriginScopedAuth(page, url, credentials);
		await page.goto(url, { waitUntil, timeout: 30000 });
		if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

		// Configure the page scan with the design system, then inject and run it.
		const browserDesignSystem = serializeDesignSystemForBrowser(options.designSystem);
		await page.evaluate(
			(designSystem: ReturnType<typeof serializeDesignSystemForBrowser>) => {
				const target = window as unknown as { __IMPECCABLE_CONFIG__?: Record<string, unknown> };
				target.__IMPECCABLE_CONFIG__ = {
					...(target.__IMPECCABLE_CONFIG__ || {}),
					autoScan: false,
					...(designSystem ? { designSystem } : {}),
				};
			},
			browserDesignSystem,
		);
		await page.evaluate(options.browserScript);

		const serializedGroups = await page.evaluate(() => {
			const detect = (window as unknown as { impeccableDetect?: (o: { decorate: boolean; serialize: boolean }) => SerializedGroup[] }).impeccableDetect;
			return typeof detect === "function" ? detect({ decorate: false, serialize: true }) : [];
		});

		for (const { findings } of serializedGroups) {
			for (const f of findings || []) {
				results.push({
					id: f.type || "unknown",
					snippet: f.detail || "",
					...(f.ignoreValue ? { ignoreValue: f.ignoreValue } : {}),
					...(f.severity ? { severity: f.severity } : {}),
				});
			}
		}

		// Hidden content runs after the main scan (which must see the at-rest state) and
		// before the contrast pass, because the reveal sweep leaves the page at the top.
		if (options.contentHidden !== false) {
			const measured = await measureContentHiddenAfterReveal(page);
			for (const hit of measured ? checkContentHiddenAtRest(measured) : []) {
				results.push({ id: hit.id, snippet: hit.snippet });
			}
		}

		for (const message of pageErrors.slice(0, 3)) results.push({ id: "script-error", snippet: message });

		for (const hit of await runVisualContrastFallback(page, serializedGroups, options)) {
			results.push({ id: hit.id, snippet: hit.snippet });
		}
	} finally {
		// Closing the page must not mask the error that got us here.
		await page.close().catch(() => {});
	}

	return results.map((f) => {
		const item = finding(f.id, url, f.snippet);
		const withValue = f.ignoreValue ? { ...item, ignoreValue: f.ignoreValue } : item;
		// A per-finding severity promotion (a pulsing dot in page chrome, say) overrides the
		// registry default that `finding()` stamped.
		return f.severity && f.severity !== withValue.severity ? { ...withValue, severity: f.severity as Finding["severity"] } : withValue;
	});
}

export {
	applyOriginScopedAuth,
	basicAuthHeader,
	detectUrl,
	launchBrowser,
	measureContentHiddenAfterReveal,
	runVisualContrastFallback,
	splitScanUrl,
};
