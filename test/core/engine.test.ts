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
} from "../../extensions/designer/engine/index.ts";

// --- catalog ---------------------------------------------------------------

checkOk("catalog: 61 rules", ANTIPATTERNS.length === 61, String(ANTIPATTERNS.length));
checkOk(
	"catalog: ids are unique",
	new Set(ANTIPATTERNS.map((rule) => rule.id)).size === ANTIPATTERNS.length,
);
checkOk(
	"catalog: every rule has a name and description",
	ANTIPATTERNS.every((rule) => rule.name.length > 0 && rule.description.length > 0),
);
checkOk("catalog: lookup by id", getAntipattern("side-tab")?.category === "slop");
checkOk("catalog: unknown id is undefined", getAntipattern("no-such-rule") === undefined);
checkOk(
	"catalog: advisory set derives from the flag",
	ADVISORY_RULE_IDS.size > 0 && [...ADVISORY_RULE_IDS].every((id) => getAntipattern(id)?.advisory === true),
	[...ADVISORY_RULE_IDS].join(", "),
);
checkOk("catalog: isAdvisoryRule", isAdvisoryRule([...ADVISORY_RULE_IDS][0]) && !isAdvisoryRule("side-tab"));

// --- findings --------------------------------------------------------------

const sideTab = finding("side-tab", "src/Card.tsx", "border-left: 4px solid red", 12);
checkOk("finding: takes name and category from the catalog", sideTab.name === "Side-tab accent border" && sideTab.category === "slop");
checkOk("finding: defaults severity to warning", sideTab.severity === "warning");
checkOk("finding: unknown rule still produces a finding", finding("ghost-rule", "a.css", "x").severity === "warning");

const advisory = [...ADVISORY_RULE_IDS][0];
checkOk("finding: stamps advisory only when the rule is advisory", finding(advisory, "a.tsx", "x").advisory === true);
checkOk("finding: omits the advisory key otherwise", !("advisory" in sideTab));

// --- scope filtering -------------------------------------------------------

const layoutFinding = finding("flat-type-hierarchy", "a.css", "h1,h2", 1);
checkOk(
	"scope: filters to the declared domain",
	filterByScopes([layoutFinding, sideTab], ["type"]).length === 1 &&
		filterByScopes([layoutFinding, sideTab], ["type"])[0] === layoutFinding,
);
import { checkOk } from "../helpers/check.ts";
checkOk("scope: no scopes means no filtering", filterByScopes([layoutFinding, sideTab]).length === 2);

// --- inline ignores --------------------------------------------------------

const source = [
	"/* impeccable-disable too-many-em-dashes -- long-form article */",
	".a { color: red; } /* impeccable-disable-line side-tab */",
	"// impeccable-disable-next-line bounce-easing: intentional",
	".b { }",
].join("\n");
const directives = parseInlineIgnores(source);
checkOk("ignores: whole-file directive", directives.file.has("too-many-em-dashes"));
checkOk("ignores: line directive keys the same line", directives.line.get(2)?.has("side-tab") === true);
checkOk("ignores: next-line directive keys the line below", directives.nextLine.get(4)?.has("bounce-easing") === true);

const dropped = applyInlineIgnores(
	[
		finding("side-tab", "a.css", "x", 2),
		finding("bounce-easing", "a.css", "x", 4),
		finding("too-many-em-dashes", "a.css", "x", 1),
		finding("overused-font", "a.css", "x", 2),
	],
	source,
);
checkOk(
	"ignores: drops the waived findings and keeps the rest",
	dropped.length === 1 && dropped[0].antipattern === "overused-font",
	dropped.map((f) => `${f.antipattern}@${f.line}`).join(", "),
);
checkOk("ignores: `*` waives every rule", applyInlineIgnores([finding("side-tab", "a.css", "x", 0)], "impeccable-disable").length === 0);
checkOk("ignores: a file without directives is untouched", applyInlineIgnores([sideTab], "body { }").length === 1);

// --- shared helpers --------------------------------------------------------

checkOk("page: whole document", isFullPage("<!doctype html><html><body></body></html>"));
checkOk("page: component is not a page", !isFullPage("<div class='card'></div>"));
checkOk("page: comment-only doctype does not count", !isFullPage("<!-- <!doctype html> --><div></div>"));

const families = extractGoogleFontFamilies(
	'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Geist+Sans|Space+Grotesk&amp;display=swap">',
);
checkOk(
	"fonts: families extracted from a css2 URL",
	families.join(",") === "inter,geist sans,space grotesk",
	families.join(","),
);
checkOk("fonts: no URL means no families", extractGoogleFontFamilies("body { }").length === 0);

checkOk("fonts: primary face skips generics", primaryFontFace("'Inter', system-ui, sans-serif") === "inter");
checkOk("fonts: pure CSS generics mean null", primaryFontFace("serif, sans-serif") === null);
checkOk("fonts: a system stack keeps its system face as primary", primaryFontFace("system-ui, -apple-system, sans-serif") === "system-ui");

checkOk("brand: geist is fine on vercel.com", isBrandFontOnOwnDomain("geist", "vercel.com"));
checkOk("brand: geist is fine on a vercel subdomain", isBrandFontOnOwnDomain("geist", "design.vercel.com"));
checkOk("brand: geist is flagged elsewhere", !isBrandFontOnOwnDomain("geist", "example.com"));
checkOk("brand: unknown font is never brand-owned", !isBrandFontOnOwnDomain("inter", "example.com"));
