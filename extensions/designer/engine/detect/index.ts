/**
 * The engine's public surface: one import for everything a host needs.
 *
 * Upstream this file is also the executable entry point (it calls the CLI when run
 * directly). pi has no such entry: a host imports `scanTargets` and owns its own process,
 * so the facade stops at the exports.
 */
export { ANTIPATTERNS, RULE_ENGINE_SUPPORT, getAntipattern, getRulesForCategory, getRuleEngineSupport } from "../core/registry/antipatterns.ts";
export { SAFE_TAGS, BORDER_SAFE_TAGS, OVERUSED_FONTS, GENERIC_FONTS, KNOWN_SERIF_FONTS } from "../core/shared/constants.ts";
export {
	isNeutralColor,
	parseRgb,
	relativeLuminance,
	contrastRatio,
	parseGradientColors,
	hasChroma,
	getHue,
	colorToHex,
} from "../core/shared/color.ts";
export { isFullPage } from "../core/shared/page.ts";
export {
	checkElementBordersInDoc as checkElementBorders,
	checkElementGlowInDoc as checkElementGlow,
} from "../core/checks/doc-checks.ts";
export { checkElementMotionInDocStyle as checkElementMotion } from "../core/checks/spotlight.ts";
export { checkPageTypography, checkLayoutInDoc as checkPageLayout } from "../core/checks/page.ts";
export { checkHtmlPatterns } from "../core/checks/html-patterns.ts";
export { createDetectorProfile, summarizeDetectorProfile } from "./profile.ts";
export {
	parseFrontmatter as parseDesignFrontmatter,
	normalizeDesignSystem,
	loadDesignSystemForCwd,
	checkSourceDesignSystem,
	collectStaticDesignSystemFindings,
} from "./design-system.ts";
export { detectHtml } from "./static-html/html.ts";
export { detectUrl } from "./browser/url.ts";
export { detectText } from "./text.ts";
export { extractStyleBlocks, extractCssInJs as extractCSSinJS } from "./strip-comments.ts";
export {
	walkDir,
	hasScannableExtension,
	SCANNABLE_EXTENSIONS,
	SKIP_DIRS,
	buildImportGraph,
	resolveImport,
	detectFrameworkConfig,
	isPortListening,
	FRAMEWORK_CONFIGS,
} from "./files.ts";
export { formatFindings, scanTargets, scanFile, scanDirectory, detectLocalFile } from "./scan.ts";
export type { ScanOptions, ScanTargetsOptions, ScanResult, DetectionConfig } from "./scan.ts";
export type { HtmlModules } from "./static-html/html.ts";
export type { BrowserLike, BrowserPage, DetectUrlOptions } from "./browser/url.ts";
export type { DesignSystem } from "./design-system.ts";
