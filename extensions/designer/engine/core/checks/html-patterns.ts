/**
 * Page-level pattern checks over raw HTML, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * These need no DOM, only the source string. CSS-property and utility-class
 * patterns scan scoped corpora so prose about CSS never flags; only
 * markup-shaped and rendered-text checks read the full source.
 */
import { enclosingCssSelector, scanCssTextForGlow, scanCssTextForGridBackground, scanCssTextForRadialHalo } from "./css-scan.ts";
import {
	scanCssTextForInsetStripe,
	scanCssTextForMarquee,
	scanCssTextForPseudoStripe,
	scanCssTextForPulsingDot,
	type ScannedHit,
} from "./css-rules.ts";

/** The two scoped extraction corpora a page-level scan reads. */
export interface PatternCorpora {
	/** `<style>` block contents plus `style="…"` values, kept in attribute form so block-scoped scanners still see one declaration block each. */
	readonly styleText: string;
	/** `class` attribute values, for utility-class scans. */
	readonly classText: string;
}

/**
 * A large inline SVG that composes a pictorial scene from many primitive shapes
 * in several fill colors: the clip-art hero mascot. Gates keep legitimate SVG out:
 * icons and logos fail the intrinsic-size gate (200px on both axes, from width or
 * height attributes, else the viewBox); charts fail the two-text-node gate
 * (axis labels, callouts); line drawings fail the primitive count or the fill
 * count; tiling textures fail on `<pattern>`.
 */
function scanHtmlForShapeAssembledIllustration(html: string): ScannedHit[] {
	const findings: ScannedHit[] = [];
	const svgRe = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;

	for (let m = svgRe.exec(html); m !== null; m = svgRe.exec(html)) {
		const block = m[0];
		const openTag = (block.match(/^<svg\b[^>]*>/i) || [""])[0];

		const textCount = (block.match(/<(?:text|tspan)\b/gi) || []).length;
		if (textCount > 2) continue;
		if (/<pattern\b/i.test(block)) continue;

		const primitives = (block.match(/<(?:rect|circle|ellipse|polygon)\b/gi) || []).length;
		if (primitives < 8) continue;

		// Explicit width/height attributes win; the viewBox speaks for an axis left
		// at a percentage or missing. `(?<![-\w])` keeps `stroke-width` from
		// masquerading as the svg's own width.
		const attrDim = (name: string): number | null => {
			const am = openTag.match(new RegExp(`(?<![-\\w])${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`, "i"));
			return am ? parseFloat(am[1]) : null;
		};
		const vb = openTag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
		const w = attrDim("width") ?? (vb ? parseFloat(vb[1]) : null);
		const h = attrDim("height") ?? (vb ? parseFloat(vb[2]) : null);
		if (w == null || h == null || w < 200 || h < 200) continue;

		// Distinct fill paints, from attributes and inline styles, excluding
		// non-paints. Multiple fills are what turn a shape pile into a scene.
		const fills = new Set<string>();
		for (const fm of block.matchAll(/\bfill\s*[:=]\s*["']?\s*([^"';>}\s]+)/gi)) {
			const paint = fm[1].trim().toLowerCase();
			if (!paint || ["none", "transparent", "currentcolor", "inherit"].includes(paint)) continue;
			fills.add(paint);
		}
		if (fills.size < 3) continue;

		findings.push({
			id: "shape-assembled-illustration",
			snippet: `inline <svg> scene: ${primitives} primitive shapes, ~${Math.round(w)}x${Math.round(h)}px, ${fills.size} fill colors`,
		});
	}
	return findings;
}

/** A polygon needs at least this many vertices before it reads as a contour rather than a shape. */
const ORGANIC_POLYGON_MIN_VERTICES = 10;

/**
 * CSS approximating an organic contour: a `clip-path: polygon()` with many
 * vertices, or `path()` with curves. That approximation reads as the cheap
 * version of the effect and is the signature of a comp's produced material being
 * replaced with code. Geometric clips (few vertices, or vertices on the 0/50/100
 * grid), `circle()`/`inset()`/`ellipse()`, and alpha-matte masks all pass.
 */
function scanCssTextForOrganicClipPath(styleText: string): ScannedHit[] {
	const findings: ScannedHit[] = [];
	const re = /clip-path\s*:\s*(polygon|path)\s*\(([^)]*(?:\)[^;}]*)?)/gi;

	for (let m = re.exec(styleText); m !== null; m = re.exec(styleText)) {
		const kind = m[1].toLowerCase();
		const body = m[2];
		const selector = enclosingCssSelector(styleText, m.index) ?? undefined;

		if (kind === "path") {
			// Curves (C, S, Q, T, A) draw a contour; a rectilinear M/L/Z outline
			// does not. Path data letters are only commands.
			const curves = (body.match(/[CSQTA]/gi) || []).length;
			if (curves < 3) continue;
			findings.push({ id: "organic-clip-path", snippet: `clip-path: path() with ${curves} curve segments`, selector });
			continue;
		}

		const points = body.split(",").map((p) => p.trim()).filter(Boolean);
		if (points.length < ORGANIC_POLYGON_MIN_VERTICES) continue;

		// Vertices on a coarse grid (multiples of 25%) are geometric; a contour has
		// arbitrary values on at least one axis per point.
		let offGrid = 0;
		for (const p of points) {
			for (const n of p.match(/-?[\d.]+/g) || []) {
				const v = parseFloat(n);
				if (Math.abs(v - Math.round(v / 25) * 25) > 0.5) offGrid++;
			}
		}
		if (offGrid < points.length) continue;
		findings.push({
			id: "organic-clip-path",
			snippet: `clip-path: polygon() with ${points.length} vertices approximating an organic contour`,
			selector,
		});
	}
	return findings;
}

/**
 * A raster (background-image url, or an `<img>`) that never reaches the screen:
 * under a near-opaque gradient wash listed before it in the same background
 * stack, or on an element at near-zero opacity. It is how a produced texture
 * "ships" while the page shows flat color. A tint under 0.9 alpha passes (hero
 * darkening), a blend mode passes (multiply/overlay keep the material visible),
 * and opacity at 0.15 or above passes.
 */
function scanCssTextForBuriedRaster(styleText: string): ScannedHit[] {
	const findings: ScannedHit[] = [];
	const declRe = /background(?:-image)?\s*:\s*([^;}]+)/gi;

	for (let m = declRe.exec(styleText); m !== null; m = declRe.exec(styleText)) {
		const value = m[1];
		if (!/url\(/i.test(value) || !/gradient\(/i.test(value)) continue;

		// A blend mode declared in the same rule keeps the raster visible.
		const ruleStart = styleText.lastIndexOf("{", m.index);
		const ruleEnd = styleText.indexOf("}", m.index);
		const rule = styleText.slice(ruleStart < 0 ? 0 : ruleStart, ruleEnd < 0 ? styleText.length : ruleEnd);
		if (/background-blend-mode\s*:\s*(?!normal)/i.test(rule) || /mix-blend-mode\s*:\s*(?!normal)/i.test(rule)) continue;

		// Layers paint first-on-top: only a wash listed before the url() covers it.
		const firstUrl = value.search(/url\(/i);
		const gradients = [...value.matchAll(/(?:linear|radial|conic)-gradient\([^()]*(?:\([^()]*\)[^()]*)*\)/gi)]
			.filter((gm) => (gm.index ?? 0) < firstUrl)
			.map((gm) => gm[0]);

		let opaqueWash = false;
		const alphaOf = (a: string | undefined | null): number => {
			if (a == null) return 1;
			const v = parseFloat(a);
			return String(a).trim().endsWith("%") ? v / 100 : v;
		};

		for (const g of gradients) {
			const alphas: number[] = [...g.matchAll(/rgba?\(\s*[\d.]+%?\s*,?\s*[\d.]+%?\s*,?\s*[\d.]+%?\s*(?:[,/]\s*([\d.]+%?))?\s*\)|hsla?\([^)]*?(?:[,/]\s*([\d.]+%?))?\s*\)/gi)]
				.map((a) => alphaOf(a[1] ?? a[2]));
			const stripped = g.replace(/rgba?\([^)]*\)|hsla?\([^)]*\)/gi, "");
			// 4- and 8-digit hex stops carry their own alpha.
			for (const h of stripped.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
				const hex = h[1];
				if (hex.length === 4) alphas.push(parseInt(hex[3] + hex[3], 16) / 255);
				else if (hex.length === 8) alphas.push(parseInt(hex.slice(6), 16) / 255);
				else alphas.push(1);
			}
			if (/\b(?:white|black|ivory|beige|linen|snow|cream)\b/i.test(stripped)) alphas.push(1);
			if (alphas.length > 0 && alphas.every((a) => !Number.isFinite(a) || a >= 0.9)) {
				opaqueWash = true;
				break;
			}
		}
		if (!opaqueWash) continue;

		findings.push({
			id: "buried-raster",
			snippet: `raster under a near-opaque gradient wash: ${value.trim().slice(0, 90)}`,
			selector: enclosingCssSelector(styleText, m.index) ?? undefined,
		});
	}
	return findings;
}

/**
 * Scoped scan corpora for the page-level checks. A CSS-property regex over the
 * whole source fires on documentation *about* CSS — `<code>background-clip:
 * text</code>` prose, `<pre>` samples, comments — so the checks read only the
 * strings that actually style the page.
 *
 * Bare CSS input (no markup at all) is its own style text, which keeps direct
 * `checkHtmlPatterns(css)` callers behaving as before.
 */
function buildHtmlPatternCorpora(html: string): PatternCorpora {
	const source = String(html || "");
	if (!/<[a-zA-Z!/]/.test(source)) {
		return { styleText: source, classText: source };
	}

	const styleParts: string[] = [];
	const classParts: string[] = [];
	const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
	for (let m = styleBlockRe.exec(source); m !== null; m = styleBlockRe.exec(source)) styleParts.push(m[1]);

	// Attribute reads are tag-scoped, so escaped samples (`&lt;div style="…"&gt;`)
	// never contribute.
	const tagRe = /<[a-zA-Z][^>]*>/g;
	for (let m = tagRe.exec(source); m !== null; m = tagRe.exec(source)) {
		const tag = m[0];
		const sm = tag.match(/\bstyle\s*=\s*("[^"]*"|'[^']*')/i);
		if (sm) styleParts.push(`style=${sm[1]}`);
		const cm = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
		if (cm) classParts.push(cm[1] ?? cm[2] ?? "");
	}

	return { styleText: styleParts.join("\n"), classText: classParts.join("\n") };
}

/**
 * Regex-on-HTML checks for a whole page, shared by the browser and file engines.
 * CSS-property and utility-class patterns read the scoped corpora; markup-shaped
 * and rendered-text checks read the full source.
 */
function checkHtmlPatterns(html: string, corpora?: PatternCorpora | null): ScannedHit[] {
	const { styleText, classText } = corpora ?? buildHtmlPatternCorpora(html);
	const findings: ScannedHit[] = [];

	// --- Color ---

	// The generated purple/violet palette: a purple accent anywhere, reported once
	// when it is used as text or in a gradient.
	const purpleHexRe = /#(?:7c3aed|8b5cf6|a855f7|9333ea|7e22ce|6d28d9|6366f1|764ba2|667eea)\b/gi;
	if (purpleHexRe.test(styleText)) {
		const purpleTextRe = /(?:(?:^|;)\s*color\s*:\s*(?:.*?)(?:#(?:7c3aed|8b5cf6|a855f7|9333ea|7e22ce|6d28d9))|gradient.*?#(?:7c3aed|8b5cf6|a855f7|764ba2|667eea))/gi;
		purpleTextRe.lastIndex = 0;
		const purpleMatch = purpleTextRe.exec(styleText);
		if (purpleMatch) {
			findings.push({
				id: "ai-color-palette",
				snippet: "Purple/violet accent colors detected",
				selector: enclosingCssSelector(styleText, purpleMatch.index + 1) ?? undefined,
			});
		}
	}

	// Gradient text: `background-clip: text` with a gradient in the same context.
	const gradientRe = /(?:-webkit-)?background-clip\s*:\s*text/gi;
	for (let gm = gradientRe.exec(styleText); gm !== null; gm = gradientRe.exec(styleText)) {
		const start = Math.max(0, gm.index - 200);
		const context = styleText.substring(start, gm.index + gm[0].length + 200);
		if (/gradient/i.test(context)) {
			findings.push({
				id: "gradient-text",
				snippet: "background-clip: text + gradient",
				selector: enclosingCssSelector(styleText, gm.index) ?? undefined,
			});
			break;
		}
	}
	if (/\bbg-clip-text\b/.test(classText) && /\bbg-gradient-to-/.test(classText)) {
		findings.push({ id: "gradient-text", snippet: "bg-clip-text + bg-gradient (Tailwind)" });
	}

	// --- Borders ---

	// The stripe drawn as a pseudo-element or an inset shadow: no border property
	// is involved, so the element-level border check never sees it.
	findings.push(...scanCssTextForPseudoStripe(styleText));
	findings.push(...scanCssTextForInsetStripe(styleText));

	// --- Layout ---

	// Monotonous spacing: one rounded value dominating most declarations, with at
	// most three distinct values in play.
	const spacingValues: number[] = [];
	let sm: RegExpExecArray | null;
	const spacingRe = /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*(\d+)px/gi;
	while ((sm = spacingRe.exec(styleText)) !== null) {
		const v = parseInt(sm[1], 10);
		if (v > 0 && v < 200) spacingValues.push(v);
	}
	const gapRe = /gap\s*:\s*(\d+)px/gi;
	while ((sm = gapRe.exec(styleText)) !== null) spacingValues.push(parseInt(sm[1], 10));
	const twSpaceRe = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)-(\d+)\b/g;
	while ((sm = twSpaceRe.exec(classText)) !== null) spacingValues.push(parseInt(sm[1], 10) * 4);
	const remSpacingRe = /(?:padding|margin)(?:-(?:top|right|bottom|left))?\s*:\s*([\d.]+)rem/gi;
	while ((sm = remSpacingRe.exec(styleText)) !== null) {
		const v = Math.round(parseFloat(sm[1]) * 16);
		if (v > 0 && v < 200) spacingValues.push(v);
	}

	const roundedSpacing = spacingValues.map((v) => Math.round(v / 4) * 4);
	if (roundedSpacing.length >= 10) {
		const counts: Record<string, number> = {};
		for (const v of roundedSpacing) counts[v] = (counts[v] || 0) + 1;
		const maxCount = Math.max(...Object.values(counts));
		const dominantPct = maxCount / roundedSpacing.length;
		const unique = [...new Set(roundedSpacing)].filter((v) => v > 0);
		if (dominantPct > 0.6 && unique.length <= 3) {
			const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
			findings.push({
				id: "monotonous-spacing",
				snippet: `~${dominant}px used ${maxCount}/${roundedSpacing.length} times (${Math.round(dominantPct * 100)}%)`,
			});
		}
	}

	// --- Motion ---

	const bounceRe = /animation(?:-name)?\s*:\s*([^;{}]*(?:bounce|elastic|wobble|jiggle|spring)[^;{}]*)/gi;
	const bounceMatch = bounceRe.exec(styleText);
	if (bounceMatch) {
		const animationToken = bounceMatch[1].split(/[,\s]+/).find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
		findings.push({
			id: "bounce-easing",
			snippet: `animation: ${animationToken || bounceMatch[1].trim()}`,
			selector: enclosingCssSelector(styleText, bounceMatch.index) ?? undefined,
		});
	}

	const bezierRe = /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g;
	for (let bz = bezierRe.exec(styleText); bz !== null; bz = bezierRe.exec(styleText)) {
		const y1 = parseFloat(bz[2]);
		const y2 = parseFloat(bz[4]);
		if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) {
			findings.push({
				id: "bounce-easing",
				snippet: `cubic-bezier(${bz[1]}, ${bz[2]}, ${bz[3]}, ${bz[4]})`,
				selector: enclosingCssSelector(styleText, bz.index) ?? undefined,
			});
			break;
		}
	}

	const transRe = /transition(?:-property)?\s*:\s*([^;{}]+)/gi;
	for (let tm = transRe.exec(styleText); tm !== null; tm = transRe.exec(styleText)) {
		const val = tm[1].toLowerCase();
		if (/\ball\b/.test(val)) continue;
		const found = val.match(/\b(?:(?:max|min)-)?(?:width|height)\b|\bpadding(?:-(?:top|right|bottom|left))?\b|\bmargin(?:-(?:top|right|bottom|left))?\b/gi);
		if (found) {
			findings.push({ id: "layout-transition", snippet: `transition: ${found.join(", ")}` });
			break;
		}
	}

	// The CSS rules come from styleText; the markup carries landmark ranges and
	// Tailwind class attributes.
	findings.push(...scanCssTextForPulsingDot(styleText, html));
	findings.push(...scanHtmlForShapeAssembledIllustration(html));
	findings.push(...scanCssTextForOrganicClipPath(styleText));
	findings.push(...scanCssTextForBuriedRaster(styleText));
	findings.push(...scanCssTextForMarquee(styleText, html));

	// --- Dark glow and radial halo ---

	const glowHits = scanCssTextForGlow(styleText);
	if (glowHits.length > 0) {
		findings.push({ id: "dark-glow", snippet: glowHits[0].snippet, selector: enclosingCssSelector(styleText, glowHits[0].index) ?? undefined });
	}
	const haloHits = scanCssTextForRadialHalo(styleText);
	if (haloHits.length > 0) {
		findings.push({ id: "radial-halo", snippet: haloHits[0].snippet, selector: enclosingCssSelector(styleText, haloHits[0].index) ?? undefined });
	}

	// Repeating-gradient stripes.
	const stripesMatch = /repeating-(?:linear|radial|conic)-gradient\s*\(/i.exec(styleText);
	if (stripesMatch) {
		findings.push({
			id: "repeating-stripes-gradient",
			snippet: "repeating-gradient decorative stripes",
			selector: enclosingCssSelector(styleText, stripesMatch.index) ?? undefined,
		});
	}

	// Two-axis grid-line background: two hairline gradient layers tiled by a pixel
	// cell, both signals in the same block. A single hairline is a ruled line, and
	// two without a tiling size are a fixed crosshair.
	const gridHits = scanCssTextForGridBackground(styleText);
	if (gridHits.length > 0) {
		findings.push({ id: "codex-grid-background", snippet: gridHits[0].snippet, selector: enclosingCssSelector(styleText, gridHits[0].index) ?? undefined });
	}

	// "X theater" framing copy, read from rendered text so it works in the bundled
	// browser path too.
	{
		const bodyText = html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ");
		const tm = /\b(\w+)\s+theater\b/i.exec(bodyText);
		if (tm) findings.push({ id: "theater-slop-phrase", snippet: `"${tm[0].trim()}"` });
	}

	// Image hover transform: a CSS rule or a Tailwind utility on an `<img>`, each
	// mechanism its own finding.
	const imgHoverCss = /\bimg\b[^,{}]*:hover\b[^{}]*\{[^}]*\btransform\s*:\s*(?:scale|rotate|translate|matrix|skew)/i;
	{
		const imgHoverMatch = imgHoverCss.exec(styleText);
		if (imgHoverMatch) {
			findings.push({
				id: "image-hover-transform",
				snippet: "img:hover { transform } rule",
				selector: enclosingCssSelector(styleText, imgHoverMatch.index + imgHoverMatch[0].indexOf("{") + 1) ?? undefined,
			});
		}
	}
	const imgTagRe = /<img\b[^>]*\bclass\s*=\s*"([^"]*)"/gi;
	for (let im = imgTagRe.exec(html); im !== null; im = imgTagRe.exec(html)) {
		if (/\bhover:(?:scale|rotate|translate|skew)-/.test(im[1])) {
			findings.push({ id: "image-hover-transform", snippet: "Tailwind hover transform on <img>" });
		}
	}

	return findings;
}

export {
	buildHtmlPatternCorpora,
	checkHtmlPatterns,
	ORGANIC_POLYGON_MIN_VERTICES,
	scanCssTextForBuriedRaster,
	scanCssTextForOrganicClipPath,
	scanHtmlForShapeAssembledIllustration,
};
export type { ScannedHit };
