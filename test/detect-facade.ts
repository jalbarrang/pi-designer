/**
 * The engine's public surface: one import resolves, and every name it advertises is real.
 *
 * A barrel is the easiest place for drift to hide — a rename in a module leaves the facade
 * pointing at nothing, and nothing fails until a host calls it. This walks the facade and
 * checks each export is a function, a class, or a collection rather than undefined.
 */
import * as engine from "../extensions/designer/engine/index.ts";
import * as detect from "../extensions/designer/engine/detect/index.ts";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
	checks++;
	if (ok) return;
	failures++;
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

function audit(label: string, barrel: Record<string, unknown>, expected: readonly string[]): void {
	check(`${label}: every expected name is exported`, expected.every((name) => name in barrel), expected.filter((name) => !(name in barrel)).join(", "));
	check(
		`${label}: no export is undefined`,
		Object.values(barrel).every((value) => value !== undefined),
		Object.entries(barrel)
			.filter(([, value]) => value === undefined)
			.map(([name]) => name)
			.join(", "),
	);
}

audit("engine", engine as Record<string, unknown>, [
	"checkBorders",
	"checkColors",
	"checkQuality",
	"checkHtmlPatterns",
	"checkElementBordersInDoc",
	"scanTargets",
	"detectHtml",
	"detectText",
	"isNeutralColor",
	"parseAnyColor",
	"filterByScopes",
	"ANTIPATTERNS",
]);

audit("detect facade", detect as Record<string, unknown>, [
	"ANTIPATTERNS",
	"RULE_ENGINE_SUPPORT",
	"getAntipattern",
	"getRulesForCategory",
	"getRuleEngineSupport",
	"SAFE_TAGS",
	"BORDER_SAFE_TAGS",
	"OVERUSED_FONTS",
	"GENERIC_FONTS",
	"KNOWN_SERIF_FONTS",
	"isNeutralColor",
	"parseRgb",
	"relativeLuminance",
	"contrastRatio",
	"parseGradientColors",
	"hasChroma",
	"getHue",
	"colorToHex",
	"isFullPage",
	"checkElementBorders",
	"checkElementMotion",
	"checkElementGlow",
	"checkPageTypography",
	"checkPageLayout",
	"checkHtmlPatterns",
	"createDetectorProfile",
	"summarizeDetectorProfile",
	"parseDesignFrontmatter",
	"normalizeDesignSystem",
	"loadDesignSystemForCwd",
	"checkSourceDesignSystem",
	"collectStaticDesignSystemFindings",
	"detectHtml",
	"detectUrl",
	"detectText",
	"extractStyleBlocks",
	"extractCSSinJS",
	"walkDir",
	"hasScannableExtension",
	"SCANNABLE_EXTENSIONS",
	"SKIP_DIRS",
	"buildImportGraph",
	"resolveImport",
	"detectFrameworkConfig",
	"isPortListening",
	"FRAMEWORK_CONFIGS",
	"formatFindings",
	"scanTargets",
	"scanFile",
	"scanDirectory",
	"detectLocalFile",
]);

// The facade's useful behavior, end to end, with no parser and no browser.
const textFindings = detect.detectText(".x { border-left: 4px solid #c81414; border-radius: 8px; }", "a.css");
check("facade: detectText finds the stripe", textFindings.some((f) => f.antipattern === "side-tab"), JSON.stringify(textFindings));
check("facade: formatFindings renders it", detect.formatFindings(textFindings, false).includes("side-tab"), detect.formatFindings(textFindings, false));

const profile = detect.createDetectorProfile();
check("facade: profile starts empty", detect.summarizeDetectorProfile(profile).length === 0);

if (failures > 0) {
	console.log(`\n${failures} of ${checks} facade checks failed`);
	process.exit(1);
}
console.log(`facade: ${checks} checks passed`);
