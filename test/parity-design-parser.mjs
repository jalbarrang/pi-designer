/**
 * Parity check: the design-record parser against the reference.
 *
 * The parser is heuristic, so the risk is a silent misread: a color group merged, a font role
 * dropped, a shadow's name lost. These comparisons run whole design records through both
 * implementations and compare the entire model plus the coverage report.
 */
import * as port from "../extensions/designer/engine/lib/design-parser.ts";
import * as ref from "../reference/impeccable-js/scripts/lib/design-parser.mjs";

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const documents = {
	empty: "",
	frontmatterOnly: "---\nname: Test\ncolors:\n  primary: \"#8c2f1e\"\n---\n",
	impeccable: `# Racing Form
Warm parchment design system.

## Overview: The Starting Gate
**Creative North Star: "The Morning Program"**
A racing paper that trusts the reader.

**Key Characteristics:**
- Warm parchment ground
- Ink-dark type

**The Two-Tone Rule.** Only two families, always.

## Colors
Warm paper under ink.

### Primary
- **Track Ink** (#241c16): the body text
- **Turf Green** (oklch(0.42 0.08 155)): the accent

### Neutrals
- **Paper** (#f5efe3): the ground
- **Chalk** (#ffffff): highlights

## Typography
**Display Font:** Fraunces (with Georgia, serif)
**Body Font:** Inter (with system-ui, sans-serif)

**Character:** Tight, editorial, confident.

### Hierarchy
- **Display** (Fraunces, weight 600, clamp(2rem, 5vw, 4rem), line-height 1.05): the hero headline
- **Body** (Inter, weight 400, 1rem, line-height 1.6): running text

## Layout
A single column with a wide left margin.

### The Margin Rule
Content never touches the edge.

## Elevation
**Character:** Nearly flat; paper does not float.

- **Card** (\`box-shadow: 0 1px 2px rgba(0,0,0,0.08)\`): the resting card
Use an extra-diffused shadow: \`box-shadow: 0 12px 40px rgba(0,0,0,0.12)\` for modals.

## Shapes
Corners are tight squares; radius only on chips.

## Components
### Card
A paper panel with a hairline edge.
- **Shape:** 0 radius
- **Background:** Paper
- **Primary:** the default state
- **Hover:** lift by one pixel

## Do's and Don'ts
### Do
- Keep the ground warm.
### Don't
- Don't add a second accent.
`,
	stitch: `# Stitch Record

## 1. Colors
- **Primary (Noto Sans):** the brand
- **Secondary (Noto Sans):** the support

## 2. Typography
*   **Display & Headlines (Noto Serif):** the hero
*   **UI & Body (Noto Sans):** everything else

## 3. Elevation & Depth
- **Card** (\`0 1px 2px rgba(0,0,0,0.08)\`): flat

## 4. Do's and Don'ts
*   **The Layering Principle:** stack surfaces, not shadows.
- Do use one accent.
- Don't stack radii.
`,
	unnamedSections: `# Untitled

## Overview
Only prose here.

## Not A Section
This heading is not canonical and stops the previous section.

## Colors
- #ff0000 red
`,
};

for (const [name, document] of Object.entries(documents)) {
	const portModel = port.parseDesignMd(document);
	const refModel = ref.parseDesignMd(document);
	check(`parseDesignMd(${name})`, portModel, refModel);
	check(`assessCoverage(${name})`, port.assessCoverage(portModel), ref.assessCoverage(refModel));
}

// The canonical section matcher decides where every line lands. The reference does not export
// it, so these are asserted against the catalog rather than compared.
for (const [heading, expected] of [
	["Overview", "Overview"],
	["Overview & Creative North Star", "Overview"],
	["1. Colors", "Colors"],
	["Elevation & Depth", "Elevation"],
	["Shapes", "Shapes"],
	["Do’s and Don’ts", "Do's and Don'ts"],
	["Do's and Don'ts", "Do's and Don'ts"],
	["Not A Section", null],
	["typography", "Typography"],
]) {
	check(`matchCanonicalSection(${heading})`, port.matchCanonicalSection(heading), expected);
}

// A frontmatter value with a nested quoted font family keeps its escapes decoded.
const escaped = port.parseDesignMd(`---\ntypography:\n  display:\n    fontFamily: "\\"IBM Plex Sans\\", system-ui, sans-serif"\n---\n# T\n`);
check(
	"frontmatter unescapes a nested quoted family",
	escaped.frontmatter?.typography?.display?.fontFamily,
	'"IBM Plex Sans", system-ui, sans-serif',
);

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} design-parser comparisons failed`);
	process.exit(1);
}
console.log(`design-parser parity: ${comparisons} comparisons match the reference`);
