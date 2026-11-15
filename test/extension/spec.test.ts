/**
 * Focused checks for the DESIGN.md reader and validator.

 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOk } from "../helpers/check.ts";

const { findDesignFile } = await import("../../extensions/designer/design-file.ts");
const { analyzeDesign, summarize } = await import("../../extensions/designer/spec.ts");
const { default: designer } = await import("../../extensions/designer/index.ts");

const severities = (report: { findings: Array<{ severity: string }> }) =>
	report.findings.map((finding) => finding.severity);

// --- a spec-compliant document, folded description and all -------------------

const GOOD = `---
version: alpha
name: Racing Form
description: >
  Warm parchment design system for a race simulator.
  Dark mode switches to neutral charcoal.
colors:
  primary: '#66bf0d'
  surface: '#f5f1e6'
typography:
  label-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
rounded:
  lg: 12px
spacing:
  md: 16px
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    rounded: '{rounded.lg}'
    typography: '{typography.label-md}'
    padding: 0px 10px
    height: 32px
---

# Racing Form

## Overview

**Creative North Star: The Trainer's Notebook**

## Colors

Parchment and ink.

## Typography

Two weights of Inter.

## Layout

An 8px rhythm.

## Elevation & Depth

Tonal layers, no shadows.

## Shapes

Soft 12px corners.

## Components

Buttons and cards.

## Do's and Don'ts

- Do keep one primary action per screen.
`;

const good = analyzeDesign(GOOD);
checkOk("good file: no findings at all", good.findings.length === 0, summarize(good.findings) + " " + JSON.stringify(good.findings));
checkOk("good file: name", good.meta.name === "Racing Form", good.meta.name);
checkOk(
	"good file: folded description on one line",
	good.meta.summary === "Warm parchment design system for a race simulator. Dark mode switches to neutral charcoal.",
	good.meta.summary,
);
checkOk("good file: all eight sections", good.sections.length === 8, good.sections.join(", "));
checkOk("good file: references counted", good.references === 3, String(good.references));

// --- summary fallbacks ------------------------------------------------------

const noDescription = analyzeDesign(GOOD.replace(/description: >[\s\S]*?colors:/, "colors:"));
checkOk(
	"missing description: Overview routes it",
	noDescription.meta.summary === "Creative North Star: The Trainer's Notebook",
	noDescription.meta.summary,
);
checkOk(
	"missing description: noted, not warned",
	noDescription.findings.some((f) => f.severity === "note" && f.message.includes("description")),
	JSON.stringify(noDescription.findings),
);

const headingsOnly = analyzeDesign("---\nname: Bare\ncolors:\n  primary: '#fff'\n---\n\n# Title\n\n## Overview\n");
checkOk("headings only: no summary invented", headingsOnly.meta.summary === undefined, headingsOnly.meta.summary);

const noFrontmatter = analyzeDesign("# Title\n\n```\nnot this\n```\n\nReal prose line.\n");
checkOk("no frontmatter: warned", severities(noFrontmatter).includes("warning"));
checkOk("no frontmatter: prose summary", noFrontmatter.meta.summary === "Real prose line.", noFrontmatter.meta.summary);
checkOk("no frontmatter: no errors", !severities(noFrontmatter).includes("error"));

// --- spec violations --------------------------------------------------------

const malformed = analyzeDesign('---\nname: "unterminated\n  bad: [\n---\n\n## Overview\n');
checkOk("malformed yaml: error, not a throw", malformed.findings[0]?.severity === "error", JSON.stringify(malformed.findings[0]));
checkOk("malformed yaml: overview still used", malformed.meta.summary === undefined || typeof malformed.meta.summary === "string");

const noName = analyzeDesign("---\nversion: alpha\ncolors:\n  primary: '#fff'\n---\n\n## Overview\n\nProse.\n");
checkOk(
	"missing name: error",
	noName.findings.some((f) => f.severity === "error" && f.message.includes("name")),
	JSON.stringify(noName.findings),
);

const duplicate = analyzeDesign("---\nname: Dup\n---\n\n## Colors\n\nA.\n\n## Colors\n\nB.\n");
checkOk(
	"duplicate section: error",
	duplicate.findings.some((f) => f.severity === "error" && f.message.includes("duplicate")),
	JSON.stringify(duplicate.findings),
);

const outOfOrder = analyzeDesign("---\nname: Order\n---\n\n## Typography\n\nA.\n\n## Colors\n\nB.\n");
checkOk(
	"out of order: warning",
	outOfOrder.findings.some((f) => f.severity === "warning" && f.message.includes("order")),
	JSON.stringify(outOfOrder.findings),
);

const missingSections = analyzeDesign("---\nname: Sparse\ncolors:\n  primary: '#fff'\n---\n\n## Overview\n\nA.\n");
checkOk(
	"missing sections: warned",
	missingSections.findings.some((f) => f.severity === "warning" && f.message.includes("missing section")),
	JSON.stringify(missingSections.findings),
);

const omitted = analyzeDesign(
	"---\nname: Sparse\nversion: alpha\ncolors:\n  primary: '#fff'\nomitted:\n  - colors\n  - typography\n  - section: rounded\n    reason: no rounded corners\n  - layout\n  - shapes\n  - components\n  - \"Do's and Don'ts\"\n  - \"Elevation & Depth\"\n---\n\n## Overview\n\nA.\n",
);
checkOk(
	"omitted: suppresses the missing-section warning",
	!omitted.findings.some((f) => f.message.includes("missing section")),
	JSON.stringify(omitted.findings),
);

const unknownHeading = analyzeDesign("---\nname: Extra\ncolors:\n  primary: '#fff'\n---\n\n## Iconography\n\nIcons.\n");
checkOk(
	"unknown heading: note, not error",
	unknownHeading.findings.some((f) => f.severity === "note" && f.message.includes("Iconography")) &&
		!severities(unknownHeading).includes("error"),
	JSON.stringify(unknownHeading.findings),
);
checkOk("unknown heading: not counted as a section", unknownHeading.sections.length === 0);

const curlyApostrophe = analyzeDesign("---\nname: Curly\ncolors:\n  primary: '#fff'\n---\n\n## Do\u2019s and Don\u2019ts\n\nA.\n");
checkOk("curly apostrophe heading recognized", curlyApostrophe.sections.includes("Do's and Don'ts"), curlyApostrophe.sections.join(", "));

const noPrimary = analyzeDesign("---\nname: NoPrimary\ncolors:\n  surface: '#fff'\n---\n\n## Colors\n\nA.\n");
checkOk(
	"no colors.primary: warned",
	noPrimary.findings.some((f) => f.severity === "warning" && f.message.includes("colors.primary")),
	JSON.stringify(noPrimary.findings),
);

const omittedColors = analyzeDesign("---\nname: Omitted\nomitted:\n  - colors\n---\n\n## Overview\n\nA.\n");
checkOk(
	"omitted colors: no primary warning",
	!omittedColors.findings.some((f) => f.message.includes("colors.primary")),
	JSON.stringify(omittedColors.findings),
);

const dangling = analyzeDesign("---\nname: Dangling\ncolors:\n  primary: '#fff'\ncomponents:\n  card:\n    backgroundColor: '{colors.ghost}'\n---\n\n## Overview\n\nA.\n");
checkOk(
	"dangling reference: warned",
	dangling.findings.some((f) => f.severity === "warning" && f.message.includes("colors.ghost")),
	JSON.stringify(dangling.findings),
);

const groupReference = analyzeDesign(
	"---\nname: Groups\ncolors:\n  primary: '#fff'\nrounded:\n  default: '{colors}'\ncomponents:\n  card:\n    rounded: '{rounded}'\n---\n\n## Overview\n\nA.\n",
);
checkOk(
	"group reference outside components: warned",
	groupReference.findings.some((f) => f.severity === "warning" && f.message.includes("rounded.default")),
	JSON.stringify(groupReference.findings),
);
checkOk(
	"group reference inside components: allowed",
	!groupReference.findings.some((f) => f.message.includes("components.card")),
	JSON.stringify(groupReference.findings),
);

const unknownProperty = analyzeDesign(
	"---\nname: Props\ncolors:\n  primary: '#fff'\ncomponents:\n  card:\n    borderColor: '#000'\n---\n\n## Overview\n\nA.\n",
);
checkOk(
	"unknown component property: note",
	unknownProperty.findings.some((f) => f.severity === "note" && f.message.includes("borderColor")),
	JSON.stringify(unknownProperty.findings),
);

const lineNumbers = analyzeDesign("---\nversion: alpha\ncolors:\n  primary: '#fff'\n---\n\n## Overview\n\nA.\n\n## Overview\n\nB.\n");
const duplicateFinding = lineNumbers.findings.find((f) => f.message.includes("duplicate"));
checkOk("duplicate reports its line", duplicateFinding?.line === 11, String(duplicateFinding?.line));

// --- discovery --------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), "designer-"));
const repo = join(base, "outer", "repo");
const deep = join(repo, "packages", "web");
mkdirSync(deep, { recursive: true });
mkdirSync(join(repo, ".git"));
writeFileSync(join(base, "outer", "DESIGN.md"), "# Above the repo\n");

checkOk("discovery: nothing yet", findDesignFile(deep) === null);
checkOk("discovery: ignores files above the repo root", findDesignFile(join(repo, "packages")) === null);
writeFileSync(join(repo, "DESIGN.md"), "# Root\n");
checkOk("discovery: repo root found from nested cwd", findDesignFile(deep) === join(repo, "DESIGN.md"));
writeFileSync(join(deep, "DESIGN.md"), "# Package\n");
checkOk("discovery: closest file wins", findDesignFile(deep) === join(deep, "DESIGN.md"));
checkOk("discovery: filesystem root is safe", findDesignFile("/") === null);

// --- extension wiring ------------------------------------------------------

const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
let command: { getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
const sentMessages: string[] = [];
const fakePi = {
	on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => handlers.set(event, handler),
	registerCommand: (_name: string, options: typeof command) => (command = options),
	sendUserMessage: (message: string) => sentMessages.push(message),
} as never;

designer(fakePi);

const runPrompt = async (cwd: string) => {
	const options: { sections: Record<string, string> } = { sections: {} };
	await handlers.get("before_agent_start")!({ systemPromptOptions: options }, { cwd, hasUI: false, ui: { notify: () => {} } });
	return options.sections;
};

const sections = await runPrompt(deep);
const section = sections.design_context;
checkOk("prompt: project file advertised", section?.includes(join(deep, "DESIGN.md")), section);
checkOk("prompt: advertises, does not inline", !!section && !section.includes("# Package"), section);
checkOk("prompt: no design_hook section", sections.design_hook === undefined, JSON.stringify(sections));
checkOk(
	"prompt: validity is deferred to the command",
	!!sections.design_context?.includes("/designer validate"),
	section,
);
checkOk(
	"prompt: audit routing names the skill",
	!!sections.design_workflow?.includes("SKILL.md"),
	sections.design_workflow,
);

// Removing the design file deletes its section; the audit routing is independent
// of the file, so it must survive.
rmSync(join(deep, "DESIGN.md"));
rmSync(join(repo, "DESIGN.md"));
const noDesign = await runPrompt(deep);
checkOk("prompt: section removed when the file is gone", noDesign.design_context === undefined, JSON.stringify(noDesign));
checkOk(
	"prompt: audit routing survives without a DESIGN.md",
	Object.keys(noDesign).join(",") === "design_workflow",
	JSON.stringify(noDesign),
);

// --- impeccable routing ------------------------------------------------------

const notes: string[] = [];
const notify = (message: string) => notes.push(message);

/** A document that satisfies every rule, for the clean-report path. */
const CLEAN = `---
name: Clean
description: Clean minimal document.
version: alpha
colors:
  primary: '#fff'
omitted:
  - typography
  - layout
  - shapes
  - components
  - "Elevation & Depth"
  - "Do's and Don'ts"
---

## Overview

Prose.

## Colors

Parchment.
`;

for (const [label, content, expected] of [
	["clean file", CLEAN, "conforms to the design.md spec"],
	["unclean file", "# Package\n\n## Iconography\n", "1 note"],
] as const) {
	writeFileSync(join(deep, "DESIGN.md"), content);
	notes.length = 0;
	await command!.handler("validate", { cwd: deep, hasUI: true, ui: { notify } });
	const output = notes.join("\n");
	checkOk(`command: validate reports the path (${label})`, output.includes(join(deep, "DESIGN.md")), output);
	checkOk(`command: validate reports the verdict (${label})`, output.includes(expected), output);
}

notes.length = 0;
writeFileSync(join(deep, "DESIGN.md"), "---\nname: Broken\n---\n\n## Colors\n\nA.\n\n## Colors\n\nB.\n");
await command!.handler("", { cwd: deep, hasUI: true, ui: { notify } });
checkOk("command: status shows the spec verdict", notes.join("\n").includes("spec: 1 error"), notes.join(" | "));

notes.length = 0;
const promptCtx = { cwd: deep, hasUI: true, ui: { notify } };
await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, promptCtx);
checkOk("prompt: spec errors surface to the human", notes.join("\n").includes("spec errors"), notes.join(" | "));
checkOk("prompt: error warning names the line", notes.join("\n").includes("line 9"), notes.join(" | "));

notes.length = 0;
await handlers.get("before_agent_start")!({ systemPromptOptions: { sections: {} } }, promptCtx);
checkOk("prompt: error warning is not repeated", notes.length === 0, notes.join(" | "));

notes.length = 0;
await command!.handler("nonsense", { cwd: deep, hasUI: true, ui: { notify } });
checkOk("command: unknown subcommand warns", notes.join("\n").includes("unknown subcommand"), notes.join(" | "));

notes.length = 0;
await command!.handler("validate /does/not/exist.md", { cwd: deep, hasUI: true, ui: { notify } });
checkOk("command: missing file warns", notes.join("\n").includes("no DESIGN.md at"), notes.join(" | "));

const completions = command!.getArgumentCompletions?.("p") as Array<{ value: string }> | null;
checkOk(
	"completions: playbooks come from the vendored metadata",
	!!completions?.some((item) => item.value === "polish") && !!completions?.some((item) => item.value === "polish"),
	JSON.stringify(completions),
);
checkOk(
	"completions: designer's own verbs included",
	(command!.getArgumentCompletions?.("va") as Array<{ value: string }>).some((item) => item.value === "validate"),
	JSON.stringify(command!.getArgumentCompletions?.("va")),
);

sentMessages.length = 0;
notes.length = 0;
await command!.handler("polish src/routes", { cwd: deep, hasUI: true, ui: { notify } });
checkOk("command: playbook routes to the vendored skill", sentMessages.length === 1, String(sentMessages.length));
checkOk(
	"command: routed message names the vendored SKILL.md",
	sentMessages[0]?.includes(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "designer", "skill", "SKILL.md")) ?? false,
	sentMessages[0] ?? "",
);
checkOk("command: routed message carries the arguments", sentMessages[0]?.includes("polish src/routes") ?? false, sentMessages[0] ?? "");
checkOk("command: playbook does not notify", notes.length === 0, notes.join(" | "));

for (const missing of ["document", "audit"]) {
	sentMessages.length = 0;
	await command!.handler(missing, { cwd: deep, hasUI: true, ui: { notify } });
	checkOk(`command: ${missing} is a known playbook`, sentMessages.length === 1, notes.join(" | "));
}

// The detector and the doctor run in this process, so they notify instead of routing: a command that
// still sent a message would mean the engine was not wired, which is the failure this guards.
for (const own of ["detect", "doctor"]) {
	sentMessages.length = 0;
	notes.length = 0;
	await command!.handler(own, { cwd: deep, hasUI: true, ui: { notify } });
	checkOk(`command: ${own} runs here rather than routing`, sentMessages.length === 0, sentMessages.join(" | "));
	checkOk(`command: ${own} reports through a notification`, notes.length > 0, "no notification");
}

rmSync(base, { recursive: true, force: true });

// --- a real project file, when this machine has one ------------------------

/** Sample `DESIGN.md` from a sibling checkout; the run skips when it is absent. */
const torena =
	process.env.DESIGNER_SAMPLE_DESIGN ??
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "torena-hub", "DESIGN.md");
try {
	const real = analyzeDesign(readFileSync(torena, "utf8"));
	checkOk("torena-hub: no spec errors", !severities(real).includes("error"), summarize(real.findings));
	checkOk("torena-hub: name", real.meta.name === "Racing Form", real.meta.name);
	checkOk(
		"torena-hub: folded description parsed",
		!!real.meta.summary?.startsWith("Warm parchment-inspired design system"),
		real.meta.summary,
	);
	checkOk("torena-hub: sections found", real.sections.length >= 6, real.sections.join(", "));
	console.log(`torena-hub DESIGN.md: ${summarize(real.findings)}`);
	for (const finding of real.findings) {
		console.log(`  ${finding.severity}${finding.line ? ` (line ${finding.line})` : ""}: ${finding.message}`);
	}
} catch {
	console.log("torena-hub DESIGN.md not present; skipped");
}
