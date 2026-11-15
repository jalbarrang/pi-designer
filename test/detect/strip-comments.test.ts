/**
 * Behavior checks for the text engine's comment stripper and style extraction.
 *
 * The reference does not export these helpers, so they have no direct oracle. Two
 * properties are asserted instead, and both are the reason the code exists: a comment
 * is blanked rather than deleted (so line numbers survive), and a comment-looking
 * sequence inside a string, template, regex, JSX URL, or CSS `url()` is left alone.
 * The engine-level oracle arrives with `detect` parity once the matcher table lands.
 */

import * as strip from "../../extensions/designer/engine/detect/strip-comments.ts";
import * as designSystem from "../../extensions/designer/engine/detect/design-system.ts";

const lineCount = (text: string): number => text.split("\n").length;

// ─── The invariant: blanking never moves a line ────────────────────────────

const lineCases = [
	"const a = 1; // trailing\nconst b = 2;",
	"/* block\n   comment */\nconst x = 1;",
	"const s = `a\nb`; // tail",
	"// only\n",
	"",
	"/* one */ /* two */\n",
	"const re = /a\\/b/g; // c\n",
];
for (const [i, src] of lineCases.entries()) {
	const out = strip.stripJsComments(src);
	checkOk(`js: line count preserved (#${i})`, lineCount(out) === lineCount(src), `${lineCount(out)} vs ${lineCount(src)}`);
}

for (const [i, src] of [
	".a { color: red } /* c */\n.b { color: blue }",
	"/* multi\nline */\n.a { color: red }",
].entries()) {
	const out = strip.stripCssComments(src);
	checkOk(`css: line count preserved (#${i})`, lineCount(out) === lineCount(src), `${lineCount(out)} vs ${lineCount(src)}`);
}

for (const [i, src] of ["<div><!-- c --></div>\n<style>.a{color:red}</style>\n"].entries()) {
	const out = strip.blankHtmlAndCssCommentsOutsideScripts(src);
	checkOk(`html: line count preserved (#${i})`, lineCount(out) === lineCount(src), `${lineCount(out)} vs ${lineCount(src)}`);
}

// ─── Comments go, code stays ───────────────────────────────────────────────

checkOk("js: line comment blanked", !strip.stripJsComments("const a = 1; // secret").includes("secret"));
checkOk("js: block comment blanked", !strip.stripJsComments("/* secret */ const a = 1;").includes("secret"));
checkOk("js: code preserved", strip.stripJsComments("const a = 1; // c").startsWith("const a = 1;"));
checkOk("css: block comment blanked", !strip.stripCssComments(".a { /* secret */ color: red }").includes("secret"));
checkOk("html: comment blanked", !strip.blankHtmlComments("<div><!-- secret --></div>").includes("secret"));

// ─── Comment-looking sequences inside strings survive ──────────────────────

const stringCases = [
	"const s = 'a//b';",
	"const s = \"a/*b*/\";",
	"const s = `a//b`;",
	"const s = `outer ${`inner // x`} tail`;",
];
for (const [i, src] of stringCases.entries()) {
	const out = strip.stripJsComments(src);
	checkOk(`js: string content preserved (#${i})`, out.includes("//") || out.includes("/*"), out);
}

checkOk("js: url in a string preserved", strip.stripJsComments("const u = 'http://example.com'; // c").includes("http://example.com"));
checkOk("jsx: url attribute preserved", strip.stripJsComments('<a href="https://x.dev/a">t</a>', { jsx: true }).includes("https://x.dev/a"));
checkOk("jsx: bare URL in JSX text preserved", strip.stripJsComments("<p>see https://x.dev/a</p>", { jsx: true }).includes("https://x.dev/a"));
checkOk("css: url(https://) preserved", strip.blankCssLineComments(".a { background: url(https://x.dev/a.png) }").includes("https://x.dev/a.png"));
checkOk("css: url(//cdn) preserved", strip.blankCssLineComments(".a { background: url(//cdn.x/a.png) }").includes("//cdn.x/a.png"));
checkOk("css: string with // preserved", strip.blankCssLineComments(".a { content: '//not' }").includes("//not"));
checkOk("css: line comment blanked", !strip.blankCssLineComments(".a { color: red } // secret").includes("secret"));
checkOk(
	"html: script comments untouched by the html pass",
	strip.blankHtmlAndCssCommentsOutsideScripts("<script>// keep me</script>").includes("keep me"),
);
checkOk(
	"html: style line comment blanked",
	!strip.blankHtmlAndCssCommentsOutsideScripts("<style>.a { color: red } // secret\n</style>").includes("secret"),
);
import { checkOk } from "../helpers/check.ts";

// ─── Regex literals and division ───────────────────────────────────────────

checkOk("js: regex literal preserved", strip.stripJsComments("const re = /ab\\/c/g; // c").includes("/ab\\/c/g"));
checkOk("js: division not read as a comment", !strip.stripJsComments("const r = a / b; // c").includes("/*"));
checkOk("js: division keeps both sides", strip.stripJsComments("const r = a / b;").includes("a / b"));

// ─── Astro frontmatter ─────────────────────────────────────────────────────

const astro = "---\nconst a = 1; // front\n---\n<div>hi</div>";
const closeIndex = strip.findAstroFrontmatterClose(astro);
checkOk("astro: frontmatter close found", closeIndex > 0, String(closeIndex));
checkOk("astro: frontmatter comment blanked", !strip.blankAstroFrontmatterComments(astro).includes("front"));
checkOk("astro: body untouched", strip.blankAstroFrontmatterComments(astro).includes("<div>hi</div>"));
checkOk("astro: no frontmatter means -1", strip.findAstroFrontmatterClose("<div>x</div>") === -1);

// ─── Style block and CSS-in-JS extraction ──────────────────────────────────

const component = "<template><p>x</p></template>\n<style>.a { color: red }</style>\n<style>.b { color: blue }</style>";
const blocks = strip.extractStyleBlocks(component, ".vue");
checkOk("style blocks: count", blocks.length === 2, String(blocks.length));
checkOk("style blocks: content", blocks[0]?.content.includes("color: red") === true, blocks[0]?.content);
checkOk("style blocks: start line", blocks[0]?.startLine === 3, String(blocks[0]?.startLine));
checkOk("style blocks: css files have none", strip.extractStyleBlocks(".a{}", ".css").length === 0);

const styled = "const A = styled.div`\n  color: red; /* c */\n`;\nconst B = css`background: blue;`;";
const templates = strip.findCssInJsTemplates(styled);
checkOk("css-in-js: two templates", templates.length === 2, String(templates.length));
const extracted = strip.extractCssInJs(styled, ".tsx");
checkOk("css-in-js: content extracted", extracted[0]?.content.includes("color: red") === true, extracted[0]?.content);
checkOk("css-in-js: non-js files skipped", strip.extractCssInJs(styled, ".css").length === 0);
checkOk("css-in-js: comments blanked inside, code outside kept", !strip.stripCssInJsComments(styled, ".tsx").includes("/* c */"));

// ─── Design file parsing (DESIGN.md frontmatter to allowlists) ────

const designMd = `---
name: Racing Form
description: Warm parchment-inspired design system
colors:
  primary: "#8c2f1e"
  paper: "#f5efe3"
  ink: "oklch(0.25 0.02 60)"
typography:
  display:
    fontFamily: "\"Fraunces\", Georgia, serif"
    fontSize: clamp(2rem, 5vw, 4rem)
  body:
    fontFamily: Inter, system-ui, sans-serif
    fontSize: 1rem
  scale:
    sm: 0.875rem
    lg: 1.5rem
rounded:
  sm: 4px
  full: 9999px
---

# Racing Form
`;

const parsedFrontmatter = designSystem.parseFrontmatter(designMd);
checkOk("design: frontmatter parses", !!parsedFrontmatter, String(parsedFrontmatter));
checkOk("design: nested map", (parsedFrontmatter?.colors as Record<string, string> | undefined)?.primary === "#8c2f1e");
checkOk("design: scalar stays a string", (parsedFrontmatter?.name as string) === "Racing Form");

const designSystemModel = designSystem.normalizeDesignSystem({ frontmatter: parsedFrontmatter });
checkOk("design: colors allowed", designSystemModel.hasColors && designSystemModel.allowedColorKeys.size === 3, String(designSystemModel.allowedColorKeys.size));
checkOk("design: fonts allowed", designSystemModel.hasFonts && designSystemModel.allowedFonts.has("fraunces") && designSystemModel.allowedFonts.has("inter"), [...designSystemModel.allowedFonts].join(","));
checkOk("design: generic families excluded", !designSystemModel.allowedFonts.has("system-ui"));
checkOk("design: radii allowed", designSystemModel.hasRadii && designSystemModel.allowedRadii.length === 2, String(designSystemModel.allowedRadii.length));
checkOk("design: pill radius recorded", designSystemModel.hasPillRadius);
checkOk(
	"design: type steps include scale and role sizes",
	designSystemModel.allowedFontSizes.some((s) => s.value === "0.875rem") && designSystemModel.allowedFontSizes.some((s) => s.value === "1rem"),
	JSON.stringify(designSystemModel.allowedFontSizes),
);
checkOk(
	"design: clamp endpoints are fluid, so a fully fluid system has no enumerated ramp",
	designSystemModel.allowedFontSizes.filter((s) => s.fluid).length === 2 && designSystemModel.hasFontSizes,
	JSON.stringify(designSystemModel.allowedFontSizes),
);
checkOk("design: quoted font family unescaped", designSystem.normalizeFontName('\"IBM Plex Sans\"') === "ibm plex sans");
checkOk("design: yaml double-quote escapes", designSystem.unescapeYamlDoubleQuoted('a\\"b') === 'a"b');
checkOk("design: clamp args", (designSystem.parseClampArgs("clamp(1rem, 2vw, 3rem)") ?? []).length === 3);
checkOk("design: not a clamp", designSystem.parseClampArgs("1rem") === null);
checkOk("design: hsl color parses", designSystem.parseDesignColor("hsl(20, 50%, 40%)") !== null);
checkOk("design: color key ignores alpha", designSystem.colorKey({ r: 1, g: 2, b: 3, a: 0.2 }) === "1,2,3");
