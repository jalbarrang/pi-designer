/**
 * The engine's core: the rule catalog, finding construction, colors, and the
 * shared vocabulary the engines build on. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The rule checks themselves (upstream's `crates/core/src/checks`, ~15k lines)
 * land here next; nothing in this barrel depends on them yet.
 */
export type {
	Antipattern,
	DesignScope,
	EngineName,
	Finding,
	RuleCategory,
	RuleScope,
	Severity,
} from "./types.ts";
export {
	ANTIPATTERNS,
	RULE_SCOPES,
	RULE_ENGINE_SUPPORT,
	ADVISORY_RULE_IDS,
	getAntipattern,
	getRulesForCategory,
	getRuleEngineSupport,
	isAdvisoryRule,
	filterByScopes,
} from "./core/registry/antipatterns.ts";
export { getAP, finding } from "./core/findings.ts";
export { applyInlineIgnores, isInlineIgnored, parseInlineIgnores, type InlineIgnores } from "./core/shared/inline-ignores.ts";
export {
	CSS_NAMED_COLORS,
	colorFunctionToRgb,
	colorToHex,
	compositeColorOver,
	contrastRatio,
	extractColorFunctionTokens,
	getHue,
	hasChroma,
	hslToRgb,
	hwbToRgb,
	isNeutralColor,
	isNoPaintColorValue,
	labToRgb,
	lchToRgb,
	oklabToRgb,
	oklchToRgb,
	parseAnyColor,
	parseColorMix,
	parseGradientColors,
	parseRgb,
	relativeLuminance,
	splitTopLevelCommas,
	type Color,
	type Rgb,
} from "./core/shared/color.ts";
export { extractGoogleFontFamilies, normalizeGoogleFontFamilyParam } from "./core/shared/fonts.ts";
export { isFullPage } from "./core/shared/page.ts";
export * from "./core/shared/constants.ts";
export { checkBorders } from "./core/checks/borders.ts";
export type { BorderCheckOptions, BorderSide } from "./core/checks/borders.ts";
export { checkColors, checkHoverContrast, isAccentColor, isCardLikeFromProps } from "./core/checks/colors.ts";
export type { ColorCheckOptions, HoverContrastOptions, ScanMode } from "./core/checks/colors.ts";
export { isEmojiOnlyText } from "./core/checks/text.ts";
export { scopedIgnoreActive, SCOPED_IGNORE_ATTRIBUTE } from "./core/checks/scoped-ignore.ts";
export type { ScopedIgnoreElement } from "./core/checks/scoped-ignore.ts";
export {
	checkHeroEyebrow,
	checkIconTile,
	checkItalicSerif,
	checkKickerAboveHeading,
	HEADING_TAGS,
	resolveHeroHeadingSizePx,
	resolveSerif,
} from "./core/checks/typography.ts";
export type {
	HeroEyebrowOptions,
	IconTileOptions,
	ItalicSerifOptions,
	KickerCandidate,
	SerifResolution,
} from "./core/checks/typography.ts";
export { checkMotion, LAYOUT_TRANSITION_PROPS } from "./core/checks/motion.ts";
export type { MotionOptions } from "./core/checks/motion.ts";
export {
	checkGlow,
	collectCssCustomProps,
	cssTextHasDarkRootBg,
	extractShadowLengths,
	findShadowColor,
	parseColorResolved,
	resolveVarRefs,
	scanCssTextForGlow,
	scanCssTextForGridBackground,
	scanCssTextForRadialHalo,
} from "./core/checks/css-scan.ts";
export type { GlowOptions, ShadowColor, TextHit } from "./core/checks/css-scan.ts";
export {
	collectMarqueeKeyframes,
	cssLengthToPx,
	infiniteAnimationNames,
	isRoundDotRadius,
	isZeroOffset,
	landmarkSourceRanges,
	scanCssTextForInsetStripe,
	scanCssTextForMarquee,
	scanCssTextForPseudoStripe,
	scanCssTextForPulsingDot,
	selectorHitsLandmark,
	stripReducedMotionBlocks,
} from "./core/checks/css-rules.ts";
export type { ScannedHit } from "./core/checks/css-rules.ts";
export {
	buildHtmlPatternCorpora,
	checkHtmlPatterns,
	scanCssTextForBuriedRaster,
	scanCssTextForOrganicClipPath,
	scanHtmlForShapeAssembledIllustration,
} from "./core/checks/html-patterns.ts";
export type { PatternCorpora } from "./core/checks/html-patterns.ts";
export {
	compositeGradientStops,
	parseRadiusToPx,
	readCascadeBackgroundColor,
	readOwnBackgroundColor,
	resolveBackground,
	resolveBackgroundInfo,
	resolveBorderRadiusPx,
	resolveGradientStops,
} from "./core/checks/background.ts";
export type { BackgroundInfo, ComputedStyleLike, ElementLike, StyleHost } from "./core/checks/background.ts";
export {
	checkElementAIPaletteDOM,
	checkElementGlowDOM,
	checkElementMotionDOM,
	checkElementMotionInDocStyle,
	checkElementRadialSpotlightDOM,
	checkElementRadialSpotlightInDoc,
	checkRadialSpotlight,
	elementGradientValue,
} from "./core/checks/spotlight.ts";
export type { RadialSpotlightOptions } from "./core/checks/spotlight.ts";
export {
	checkContentHiddenAtRest,
	checkContentHiddenAtRestInDoc,
	checkElementBlinkingCursorDOM,
	checkElementTextOverflowDOM,
	isScreenReaderOnlyTextStyle,
	keyframesToggleVisibility,
	measureHiddenText,
	TEXT_OVERFLOW_SKIP_TAGS,
} from "./core/checks/text-visibility.ts";
export type { BlinkingCursorOptions, HiddenTextMeasurement, KeyframesSource } from "./core/checks/text-visibility.ts";
export {
	checkEdgeFlushCards,
	checkFirstViewportColumnOverflow,
	checkTextOcclusion,
	elementDirectText,
	isLayeredElement,
	isOpaqueDecoratedBox,
	isPaintedForOcclusion,
} from "./core/checks/overlap.ts";
export type { OverlapViewport } from "./core/checks/overlap.ts";
export {
	checkElementBordersDOM,
	checkElementColorsDOM,
	checkElementHeroEyebrowDOM,
	checkElementIconTileDOM,
	checkElementItalicSerifDOM,
	checkElementPseudoStripeDOM,
	classSelector,
	directText,
	effectiveOpacity,
	isRenderedForBrowserRule,
	isStatusContextElement,
	isTabContextElement,
	readPseudoSurface,
} from "./core/checks/elements.ts";
export {
	checkEmDashOveruse,
	checkEmDashOveruseInDoc,
	checkKickersInDoc,
	checkNumberedSectionLabels,
	checkNumberedSectionLabelsInDoc,
	cleanInlineText,
	collectKickerCandidates,
	collectNumberedSectionLabelCandidates,
	isKickerCandidate,
	isKickerCardContext,
	isNumberedSectionLabelCandidate,
	KICKER_CARD_CONTEXT_SELECTOR,
	KICKER_SKIP_SELECTOR,
	kickerHeadingLevel,
	NUMBERED_LABEL_TAGS,
	parseNumberedLabelText,
} from "./core/checks/labels.ts";
export type {
	CollectedKicker,
	CollectedNumberedLabel,
	KickerCandidateOptions,
	LengthResolver,
	NumberedLabelCandidateOptions,
	StyleReader,
} from "./core/checks/labels.ts";
export { resolveFontSizePx, resolveLengthPx } from "./core/checks/lengths.ts";
export {
	collectRepeatedContainerTextFindings,
	isRepeatedTextContainer,
	REPEATED_TEXT_CONTAINER_TAGS,
	REPEATED_TEXT_SKIP_SELECTOR,
} from "./core/checks/repeated-text.ts";
export type { RepeatedTextOptions } from "./core/checks/repeated-text.ts";
export {
	checkElementQualityDOM,
	checkPageQualityFromDoc,
	checkQuality,
	isNonRenderedText,
	isVisuallyHidden,
	QUALITY_TEXT_TAGS,
	textDescendantsFlushSides,
} from "./core/checks/quality.ts";
export type { QualityOptions } from "./core/checks/quality.ts";
export {
	checkElementBordersInDoc,
	checkElementColorsInDoc,
	checkElementGlowInDoc,
	checkElementHeroEyebrowInDoc,
	checkElementHoverContrastInDoc,
	checkElementIconTileInDoc,
	checkElementItalicSerifInDoc,
	checkElementMotionInDoc,
	checkElementQualityInDoc,
} from "./core/checks/doc-checks.ts";
export type { BorderSideOverride, DocHost, HoverStyle } from "./core/checks/doc-checks.ts";
export {
	checkFlatTypeHierarchyFromDoc,
	checkFlatTypeHierarchySamples,
	checkHeadingRhythm,
	checkLayoutInDoc,
	checkPageTypography,
	checkTypographyInDoc,
	isCardLikeInDoc,
	TYPE_HIERARCHY_SELECTOR,
} from "./core/checks/page.ts";
export type { PageSource, StyleRuleLike, StyleSheetLike } from "./core/checks/page.ts";
export {
	checkCreamPalette,
	checkElementGptBorderShadow,
	checkElementOversizedH1DOM,
	checkElementOversizedH1InDoc,
	checkGptThinBorderWideShadow,
	checkOversizedH1,
	creamFromClassList,
	isCreamColor,
	shadowMaxBlurPx,
} from "./core/checks/tells.ts";
export {
	checkClippedOverflow,
	checkElementClippedOverflowDOM,
	clippedByInset,
	clippedByRect,
	elementRect,
	metricLengthPx,
	positionedChildIsDecorative,
} from "./core/checks/overflow.ts";
export type { CssStyle, DomAdapter, DomElement, DomTextNode, Rect } from "./dom.ts";
export {
	exitCodeFor,
	partitionAdvisory,
	scanDirectory,
	scanFile,
	scanTargets,
} from "./detect/scan.ts";
export { detectHtml } from "./detect/static-html/html.ts";
export { detectText } from "./detect/text.ts";
export type { DetectionConfig, ScanOptions, ScanResult, ScanTargetsOptions } from "./detect/scan.ts";
export type { RuleHit } from "./core/checks/rule-hit.ts";
