/**
 * Checks for the ported engine spine: the rule catalog, finding construction,
 * inline ignores, and the shared helpers. Behavior here is what the engine
 * guarantees; the rule checks that land next get their own file.
 */
import {
	ADVISORY_RULE_IDS,
	ANTIPATTERNS,
	applyInlineIgnores,
	extractGoogleFontFamilies,
	filterByScopes,
	finding,
	getAntipattern,
	isAdvisoryRule,
	isBrandFontOnOwnDomain,
	isFullPage,
	parseInlineIgnores,
	primaryFontFace,
} from "../extensions/designer/engine/index.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`ok   ${name}`);
		return;
	}
	failures++;
	console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

// --- catalog ---------------------------------------------------------------

check("catalog: 61 rules", ANTIPATTERNS.length === 61, String(ANTIPATTERNS.length));
check(
	"catalog: ids are unique",
	new Set(ANTIPATTERNS.map((rule) => rule.id)).size === ANTIPATTERNS.length,
);
check(
	"catalog: every rule has a name and description",
	ANTIPATTERNS.every((rule) => rule.name.length > 0 && rule.description.length > 0),
);
check("catalog: lookup by id", getAntipattern("side-tab")?.category === "slop");
check("catalog: unknown id is undefined", getAntipattern("no-such-rule") === undefined);
check(
	"catalog: advisory set derives from the flag",
	ADVISORY_RULE_IDS.size > 0 && [...ADVISORY_RULE_IDS].every((id) => getAntipattern(id)?.advisory === true),
	[...ADVISORY_RULE_IDS].join(", "),
);
check("catalog: isAdvisoryRule", isAdvisoryRule([...ADVISORY_RULE_IDS][0]) && !isAdvisoryRule("side-tab"));

// --- findings --------------------------------------------------------------

const sideTab = finding("side-tab", "src/Card.tsx", "border-left: 4px solid red", 12);
check("finding: takes name and category from the catalog", sideTab.name === "Side-tab accent border" && sideTab.category === "slop");
check("finding: defaults severity to warning", sideTab.severity === "warning");
check("finding: unknown rule still produces a finding", finding("ghost-rule", "a.css", "x").severity === "warning");

const advisory = [...ADVISORY_RULE_IDS][0];
check("finding: stamps advisory only when the rule is advisory", finding(advisory, "a.tsx", "x").advisory === true);
check("finding: omits the advisory key otherwise", !("advisory" in sideTab));

// --- scope filtering -------------------------------------------------------

const layoutFinding = finding("flat-type-hierarchy", "a.css", "h1,h2", 1);
check(
	"scope: filters to the declared domain",
	filterByScopes([layoutFinding, sideTab], ["type"]).length === 1 &&
		filterByScopes([layoutFinding, sideTab], ["type"])[0] === layoutFinding,
);
check("scope: no scopes means no filtering", filterByScopes([layoutFinding, sideTab]).length === 2);

// --- inline ignores --------------------------------------------------------

const source = [
	"/* impeccable-disable too-many-em-dashes -- long-form article */",
	".a { color: red; } /* impeccable-disable-line side-tab */",
	"// impeccable-disable-next-line bounce-easing: intentional",
	".b { }",
].join("\n");
const directives = parseInlineIgnores(source);
check("ignores: whole-file directive", directives.file.has("too-many-em-dashes"));
check("ignores: line directive keys the same line", directives.line.get(2)?.has("side-tab") === true);
check("ignores: next-line directive keys the line below", directives.nextLine.get(4)?.has("bounce-easing") === true);

const dropped = applyInlineIgnores(
	[
		finding("side-tab", "a.css", "x", 2),
		finding("bounce-easing", "a.css", "x", 4),
		finding("too-many-em-dashes", "a.css", "x", 1),
		finding("overused-font", "a.css", "x", 2),
	],
	source,
);
check(
	"ignores: drops the waived findings and keeps the rest",
	dropped.length === 1 && dropped[0].antipattern === "overused-font",
	dropped.map((f) => `${f.antipattern}@${f.line}`).join(", "),
);
check("ignores: `*` waives every rule", applyInlineIgnores([finding("side-tab", "a.css", "x", 0)], "impeccable-disable").length === 0);
check("ignores: a file without directives is untouched", applyInlineIgnores([sideTab], "body { }").length === 1);

// --- shared helpers --------------------------------------------------------

check("page: whole document", isFullPage("<!doctype html><html><body></body></html>"));
check("page: component is not a page", !isFullPage("<div class='card'></div>"));
check("page: comment-only doctype does not count", !isFullPage("<!-- <!doctype html> --><div></div>"));

const families = extractGoogleFontFamilies(
	'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Geist+Sans|Space+Grotesk&amp;display=swap">',
);
check(
	"fonts: families extracted from a css2 URL",
	families.join(",") === "inter,geist sans,space grotesk",
	families.join(","),
);
check("fonts: no URL means no families", extractGoogleFontFamilies("body { }").length === 0);

check("fonts: primary face skips generics", primaryFontFace("'Inter', system-ui, sans-serif") === "inter");
check("fonts: pure CSS generics mean null", primaryFontFace("serif, sans-serif") === null);
check("fonts: a system stack keeps its system face as primary", primaryFontFace("system-ui, -apple-system, sans-serif") === "system-ui");

check("brand: geist is fine on vercel.com", isBrandFontOnOwnDomain("geist", "vercel.com"));
check("brand: geist is fine on a vercel subdomain", isBrandFontOnOwnDomain("geist", "design.vercel.com"));
check("brand: geist is flagged elsewhere", !isBrandFontOnOwnDomain("geist", "example.com"));
check("brand: unknown font is never brand-owned", !isBrandFontOnOwnDomain("inter", "example.com"));

if (failures > 0) {
	console.log(`\n${failures} engine check(s) failed`);
	process.exit(1);
}
console.log("\nall engine checks passed");
