/**
 * Platform and section reads from a product record. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Kept apart from the context loader so the loader can import it without a cycle, and so the
 * parsing can be tested on strings alone.
 */

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value: string): string {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The first non-empty line under a bare `## <heading>` section, or null when the section is
 * absent or empty. The heading match is exact so a near-miss heading cannot shadow the field.
 */
function extractSectionValue(product: string | null | undefined, heading: string): string | null {
	if (!product) return null;
	const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
	const lines = product.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (!headingRe.test(lines[i].trim())) continue;
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j].trim();
			// A new heading before any value means the section is empty.
			if (/^#{1,6}\s/.test(next)) return null;
			if (next) return next;
		}
	}
	return null;
}

/**
 * The platform a product record declares: `web`, `ios`, `android`, or `adaptive`.
 *
 * `adaptive` is for cross-platform apps that ship both native targets from one codebase, and
 * a short list naming both (`ios, android`, `ios and android`) reads as adaptive too. An
 * unrecognized value returns null, which is not the same as absent: the caller warns rather
 * than defaulting.
 */
function extractPlatform(product: string | null | undefined): "web" | "ios" | "android" | "adaptive" | null {
	const value = (extractSectionValue(product, "Platform") || "").toLowerCase();
	if (!value) return null;
	if (value === "web" || value === "ios" || value === "android" || value === "adaptive") return value;

	// Only list separators and the two platform words may appear; prose or a negation falls
	// through to the caller's warning path.
	const tokens = value.split(/[\s,+&/]+/).filter((token) => token && token !== "and");
	if (tokens.length >= 2 && tokens.every((token) => token === "ios" || token === "android") && tokens.includes("ios") && tokens.includes("android")) {
		return "adaptive";
	}
	return null;
}

export { escapeRegExp, extractPlatform, extractSectionValue };
