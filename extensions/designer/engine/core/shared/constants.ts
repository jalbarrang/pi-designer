/**
 * Shared thresholds and vocabulary for the rules, ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 */

const SAFE_TAGS: ReadonlySet<string> = new Set([
	"blockquote", "nav", "a", "input", "textarea", "select",
	"pre", "code", "span", "th", "td", "tr", "li", "label",
	"button", "hr", "html", "head", "body", "script", "style",
	"link", "meta", "title", "br", "img", "svg", "path", "circle",
	"rect", "line", "polyline", "polygon", "g", "defs", "use",
]);

// The border rule re-allows <label>: card-shaped clickable labels wrapping a
// checkbox are a canonical side-tab shape and must be detected. Its other
// preconditions (non-neutral color, width >= 2px on one side, radius or width
// >= 3, element size >= 20x20 in the browser path) already filter out plain
// inline form labels, so this does not add false positives.
const BORDER_SAFE_TAGS: ReadonlySet<string> = new Set([...SAFE_TAGS].filter((tag) => tag !== "label"));

const OVERUSED_FONTS: ReadonlySet<string> = new Set([
	// Older monoculture (still ubiquitous):
	"inter", "roboto", "open sans", "lato", "montserrat", "arial", "helvetica",
	// Newer monoculture (the Anthropic-skill / Vercel / GitHub default wave):
	"fraunces", "instrument sans", "instrument serif",
	"geist", "geist sans", "geist mono",
	"mona sans",
	"plus jakarta sans", "space grotesk", "recoleta",
]);

const GOOGLE_DOMAINS: readonly string[] = [
	"google.com", "youtube.com", "android.com", "chromium.org",
	"chrome.com", "web.dev", "gstatic.com", "firebase.google.com",
];
const VERCEL_DOMAINS: readonly string[] = ["vercel.com", "nextjs.org", "v0.app"];
const GITHUB_DOMAINS: readonly string[] = ["github.com", "githubnext.com"];

/** Fonts that belong to the site that ships them, so they are not "overused" there. */
const BRAND_FONT_DOMAINS: Readonly<Record<string, readonly string[]>> = {
	roboto: GOOGLE_DOMAINS,
	"google sans": GOOGLE_DOMAINS,
	"product sans": GOOGLE_DOMAINS,
	geist: VERCEL_DOMAINS,
	"geist sans": VERCEL_DOMAINS,
	"geist mono": VERCEL_DOMAINS,
	"mona sans": GITHUB_DOMAINS,
};

/**
 * True when `font` is a brand face and `hostname` belongs to that brand.
 * The engine reads the browser's `location` here; pi passes the host of the
 * page being reviewed, so a scan of a saved URL still knows where it came from.
 */
function isBrandFontOnOwnDomain(font: string, hostname: string | null | undefined): boolean {
	const allowed = BRAND_FONT_DOMAINS[font];
	if (!allowed || !hostname) return false;
	const host = hostname.toLowerCase();
	return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Overused-font primary selection skips only CSS generics so a system stack
// keeps the system face as primary; GENERIC_FONTS includes platform faces for
// design-system and serif resolution.
const CSS_GENERIC_FONTS: ReadonlySet<string> = new Set([
	"serif", "sans-serif", "monospace", "cursive", "fantasy",
	"inherit", "initial", "unset", "revert",
]);

const GENERIC_FONTS: ReadonlySet<string> = new Set([
	...CSS_GENERIC_FONTS,
	"system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
	"-apple-system", "blinkmacsystemfont", "segoe ui",
]);

/** The first family in a `font-family` stack that is not skipped, or null when the stack is only generics. */
function primaryFontFace(fontFamily: string, skip: ReadonlySet<string> = CSS_GENERIC_FONTS): string | null {
	return (
		String(fontFamily ?? "")
			.split(",")
			.map((face) => face.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
			.find((face) => face && !skip.has(face)) ?? null
	);
}

// WCAG large text thresholds are defined in points: 18pt normal, 14pt bold.
// Browsers expose font-size in CSS pixels at 96px per inch.
const WCAG_LARGE_TEXT_PX = 18 * (96 / 72);
const WCAG_LARGE_BOLD_TEXT_PX = 14 * (96 / 72);

// Em-dash overuse (advisory) thresholds, shared by the text and browser
// analyzers so both fire on the same saturation pattern. Two gates must hold:
// an absolute floor, and a density of one dash per EM_DASH_CHARS_PER_DASH
// characters of body text. A long article with a few dashes is left alone; a
// dash-per-clause page is not.
const EM_DASH_FLOOR = 8;
const EM_DASH_CHARS_PER_DASH = 500;

// Serif faces that show up in italic-display heroes. The rule also fires when
// the primary face is unknown but the stack ends in the generic `serif` token,
// which catches custom and private faces with a serif fallback.
const KNOWN_SERIF_FONTS: ReadonlySet<string> = new Set([
	"fraunces", "recoleta", "newsreader", "playfair display", "playfair",
	"cormorant", "cormorant garamond", "garamond", "eb garamond",
	"tiempos", "tiempos headline", "tiempos text",
	"lora", "vollkorn", "spectral",
	"source serif pro", "source serif 4", "source serif",
	"ibm plex serif", "merriweather",
	"libre caslon", "libre baskerville", "baskerville",
	"georgia", "times new roman", "times",
	"dm serif display", "dm serif text",
	"instrument serif", "gt sectra", "ogg", "canela",
	"freight display", "freight text",
]);

export {
	SAFE_TAGS,
	BORDER_SAFE_TAGS,
	OVERUSED_FONTS,
	GOOGLE_DOMAINS,
	VERCEL_DOMAINS,
	GITHUB_DOMAINS,
	BRAND_FONT_DOMAINS,
	isBrandFontOnOwnDomain,
	CSS_GENERIC_FONTS,
	GENERIC_FONTS,
	primaryFontFace,
	WCAG_LARGE_TEXT_PX,
	WCAG_LARGE_BOLD_TEXT_PX,
	EM_DASH_FLOOR,
	EM_DASH_CHARS_PER_DASH,
	KNOWN_SERIF_FONTS,
};
