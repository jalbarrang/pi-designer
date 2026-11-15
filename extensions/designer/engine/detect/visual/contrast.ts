/**
 * Pixel-level contrast: hide the glyphs, screenshot again, and measure what the text was
 * actually painted on. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * This exists because the analytic contrast check can only compare `color` against a
 * resolved surface. Text over an image, a gradient, or a painted texture has no analytic
 * answer, so the measurement happens in pixels: capture, hide the text, capture again, and
 * the pixels that changed are the glyphs.
 *
 * The two in-page callbacks are passed to the host to evaluate, because they run in the
 * browser page (Image, canvas, DOM), not in this process.
 */

/** A screenshot region, in CSS pixels. */
export interface ScreenshotClip {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** One element the analytic pass could not settle, with where to look and what it needs. */
export interface ContrastCandidate {
	readonly selector: string;
	readonly clip: ScreenshotClip | null;
	readonly text?: string;
	/** The CSS text color, used unless `preferRenderedForeground` asks for the painted pixels. */
	readonly textColor?: { readonly r: number; readonly g: number; readonly b: number } | null;
	readonly preferRenderedForeground?: boolean;
	readonly backgroundClipText?: boolean;
	readonly threshold: number;
	readonly reasons?: readonly string[];
}

/** What the pixel comparison measured. */
export interface ContrastMetrics {
	readonly glyphPixels: number;
	readonly strongestDelta: number;
	readonly worstRatio: number | null;
	readonly p10Ratio: number | null;
	readonly medianRatio: number | null;
}

/** The page surface the measurement needs. pi supplies its browser, not Puppeteer. */
export interface ContrastPage {
	evaluate<TArg, TResult>(callback: (arg: TArg) => TResult | Promise<TResult>, arg: TArg): Promise<TResult>;
	screenshot(options: { readonly encoding: "base64"; readonly clip: ScreenshotClip; readonly captureBeyondViewport: boolean }): Promise<string>;
}

/**
 * Clamp a clip to something capturable: non-negative, at least 1x1, no taller than 320px
 * (a contrast probe is a band of text, not a page), and no wider than the viewport.
 */
function sanitizeScreenshotClip(clip: Partial<ScreenshotClip> | null | undefined, viewport?: { readonly width?: number } | null): ScreenshotClip | null {
	if (!clip) return null;
	const x = Math.max(0, Math.floor(clip.x || 0));
	const y = Math.max(0, Math.floor(clip.y || 0));
	const width = Math.min(Math.max(1, Math.ceil(clip.width || 0)), Math.max(1, viewport?.width || 1600));
	const height = Math.min(Math.max(1, Math.ceil(clip.height || 0)), 320);
	if (width < 1 || height < 1) return null;
	return { x, y, width, height };
}

/**
 * Compare two captures pixel by pixel: the pixels that changed are the glyphs, and each
 * one's contrast is measured against what sits behind it in the second capture.
 *
 * Runs in the page, where `Image` and canvas exist. Returns null when the images cannot be
 * decoded, and `worstRatio: null` when too few pixels changed to mean anything — a
 * measurement that thin would be noise dressed as evidence.
 */
async function compareScreenshotContrast(
	page: ContrastPage,
	beforeBase64: string,
	afterBase64: string,
	candidate: ContrastCandidate,
): Promise<ContrastMetrics | null> {
	return page.evaluate(
		async ({
			beforeBase64,
			afterBase64,
			candidate,
		}: {
			beforeBase64: string;
			afterBase64: string;
			candidate: ContrastCandidate;
		}): Promise<ContrastMetrics | null> => {
			const loadImage = (base64: string): Promise<HTMLImageElement> =>
				new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = () => reject(new Error("Could not decode contrast screenshot"));
					img.src = `data:image/png;base64,${base64}`;
				});

			const [before, after] = await Promise.all([loadImage(beforeBase64), loadImage(afterBase64)]);
			const width = Math.min(before.width, after.width);
			const height = Math.min(before.height, after.height);
			if (width < 1 || height < 1) return null;

			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return null;

			ctx.drawImage(before, 0, 0, width, height);
			const beforePixels = ctx.getImageData(0, 0, width, height).data;
			ctx.clearRect(0, 0, width, height);
			ctx.drawImage(after, 0, 0, width, height);
			const afterPixels = ctx.getImageData(0, 0, width, height).data;

			const luminance = ({ r, g, b }: { r: number; g: number; b: number }): number => {
				const convert = (c: number): number => {
					const v = c / 255;
					return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
			};
			const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number => {
				const l1 = luminance(a);
				const l2 = luminance(b);
				return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
			};

			const cssTextColor =
				candidate.textColor && !candidate.preferRenderedForeground
					? { r: candidate.textColor.r, g: candidate.textColor.g, b: candidate.textColor.b }
					: null;

			const ratios: number[] = [];
			let glyphPixels = 0;
			let strongestDelta = 0;

			for (let i = 0; i < beforePixels.length; i += 4) {
				const delta =
					Math.abs(beforePixels[i] - afterPixels[i]) +
					Math.abs(beforePixels[i + 1] - afterPixels[i + 1]) +
					Math.abs(beforePixels[i + 2] - afterPixels[i + 2]) +
					Math.abs(beforePixels[i + 3] - afterPixels[i + 3]);
				strongestDelta = Math.max(strongestDelta, delta);
				if (delta < 10) continue;

				glyphPixels++;
				const fg = cssTextColor || { r: beforePixels[i], g: beforePixels[i + 1], b: beforePixels[i + 2] };
				const bg = { r: afterPixels[i], g: afterPixels[i + 1], b: afterPixels[i + 2] };
				ratios.push(ratio(fg, bg));
			}

			if (ratios.length < 8) {
				return { glyphPixels, strongestDelta, worstRatio: null, p10Ratio: null, medianRatio: null };
			}

			ratios.sort((a, b) => a - b);
			const pick = (pct: number): number => ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor((pct / 100) * ratios.length)))];
			return {
				glyphPixels,
				strongestDelta,
				worstRatio: ratios[0],
				p10Ratio: pick(10),
				medianRatio: pick(50),
			};
		},
		{ beforeBase64, afterBase64, candidate },
	);
}

/** The finding shape this module produces. */
export interface ContrastFinding {
	readonly id: string;
	readonly snippet: string;
}

/**
 * Measure one candidate: capture, hide its glyphs, capture again, compare, and report only
 * when the tenth-percentile contrast is under the threshold. The 10th percentile rather
 * than the worst pixel, because one antialiased edge pixel is not a contrast failure.
 */
async function captureVisualContrastCandidate(
	page: ContrastPage,
	candidate: ContrastCandidate,
	viewport?: { readonly width?: number; readonly height?: number } | null,
): Promise<ContrastFinding | null> {
	const clip = sanitizeScreenshotClip(candidate.clip, viewport);
	if (!clip) return null;

	const beforeBase64 = await page.screenshot({ encoding: "base64", clip, captureBeyondViewport: true });
	const token = `impeccable-contrast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	const applied = await page.evaluate(
		({ selector, token, backgroundClipText }: { selector: string; token: string; backgroundClipText?: boolean }): boolean => {
			let el: Element | null;
			try {
				el = document.querySelector(selector);
			} catch {
				return false;
			}
			if (!el) return false;

			let style = document.getElementById("impeccable-visual-contrast-hide-style") as HTMLStyleElement | null;
			if (!style) {
				style = document.createElement("style");
				style.id = "impeccable-visual-contrast-hide-style";
				style.textContent = [
					"[data-impeccable-visual-contrast-target] {",
					"  color: transparent !important;",
					"  -webkit-text-fill-color: transparent !important;",
					"  text-shadow: none !important;",
					"}",
					'[data-impeccable-visual-contrast-target][data-impeccable-bgclip-text="true"] {',
					"  background-image: none !important;",
					"}",
				].join("\n");
				document.head.appendChild(style);
			}

			el.setAttribute("data-impeccable-visual-contrast-target", token);
			if (backgroundClipText) el.setAttribute("data-impeccable-bgclip-text", "true");
			return true;
		},
		{ selector: candidate.selector, token, backgroundClipText: candidate.backgroundClipText },
	);
	if (!applied) return null;

	let afterBase64: string;
	try {
		afterBase64 = await page.screenshot({ encoding: "base64", clip, captureBeyondViewport: true });
	} finally {
		// The page must go back to how it was, whatever happened during the capture.
		await page
			.evaluate(
				({ selector }: { selector: string }) => {
					try {
						const el = document.querySelector(selector);
						if (el) {
							el.removeAttribute("data-impeccable-visual-contrast-target");
							el.removeAttribute("data-impeccable-bgclip-text");
						}
					} catch {
						// Invalid or stale selector during cleanup: nothing to restore.
					}
				},
				{ selector: candidate.selector },
			)
			.catch(() => {
				// The page closed mid-measurement; the finding is lost, not the scan.
			});
	}

	const metrics = await compareScreenshotContrast(page, beforeBase64, afterBase64, candidate);
	if (!metrics || !Number.isFinite(metrics.p10Ratio) || metrics.glyphPixels < 8) return null;

	const measuredRatio = metrics.p10Ratio as number;
	if (measuredRatio >= candidate.threshold) return null;

	const textLabel = candidate.text ? ` "${candidate.text}"` : "";
	const reasonLabel = (candidate.reasons || []).slice(0, 3).join(", ") || "visual background";
	return {
		id: "low-contrast",
		snippet: `pixel contrast ${measuredRatio.toFixed(1)}:1 median ${(metrics.medianRatio as number).toFixed(1)}:1 (need ${candidate.threshold}:1) on ${reasonLabel}${textLabel}`,
	};
}

export { captureVisualContrastCandidate, compareScreenshotContrast, sanitizeScreenshotClip };
