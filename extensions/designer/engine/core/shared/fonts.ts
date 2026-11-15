/**
 * Font helpers, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */

const GOOGLE_FONTS_URL_RE = /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi;

/** `family=Inter:wght@400|Geist` splits into first-token, lowercased family names. */
function normalizeGoogleFontFamilyParam(value: string | null | undefined): string[] {
	return String(value ?? "")
		.split("|")
		.map((part) => part.split(":")[0].trim().toLowerCase())
		.filter(Boolean);
}

/** Every family a stylesheet or HTML file asks Google Fonts for, in source order. */
function extractGoogleFontFamilies(text: string | null | undefined): string[] {
	const families: string[] = [];
	if (!text) return families;

	GOOGLE_FONTS_URL_RE.lastIndex = 0;
	for (let match = GOOGLE_FONTS_URL_RE.exec(text); match !== null; match = GOOGLE_FONTS_URL_RE.exec(text)) {
		const url = match[0];
		const queryStart = url.indexOf("?");
		if (queryStart === -1) continue;

		const params = new URLSearchParams(url.slice(queryStart + 1).replace(/&amp;/g, "&"));
		for (const value of params.getAll("family")) {
			families.push(...normalizeGoogleFontFamilyParam(value));
		}
	}

	return families;
}

export { extractGoogleFontFamilies, normalizeGoogleFontFamilyParam };
