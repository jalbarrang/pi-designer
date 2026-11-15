/**
 * Designer — the extension that owns the project's `DESIGN.md` and carries the
 * Impeccable design guidance.
 *
 * Two parts, one front door:
 * - DESIGN.md ownership. The file is Google's format
 *   (github.com/google-labs-code/design.md): YAML frontmatter carrying design
 *   tokens, then prose sections in a fixed order. Designer advertises it to the
 *   agent and checks it against that spec, so the design system stays the single
 *   source of truth for UI work.
 * - Impeccable guidance. `skill/` began as a snapshot of upstream's Pi build
 *   (github.com/pbakaus/impeccable) and is edited here from that commit on;
 *   `skill/UPSTREAM.json` records where it started. `bun scripts/sync-upstream.mjs`
 *   is the importer that produced it, not a maintenance loop.
 *
 * Audits are manual, like running a linter. No tool hooks are registered: nothing
 * scans an edit, blocks a write, or pushes findings into a turn. Design review
 * happens when it is asked for — `/designer <playbook>` routes to Impeccable, and
 * `/designer detect <paths>` runs the detector here, in process.
 *
 * Ownership rules:
 * - The design file is advertised, never inlined, the way skills load, so its
 *   contents cost nothing until the agent reads them.
 * - The prompt section tag is fixed (`design_context`). Pi diffs prompt sections
 *   by name, so a tag that varied per project would churn the cache.
 * - Spec problems go to the human, once per session, never into the prompt: a
 *   broken design file is not the agent's task to fix.
 * - Design review is routed by a fixed `design_workflow` section. The skill's own
 *   description is not enough: with it alone, 1 of 3 audit runs loaded the skill
 *   and the other two improvised a review from the design file and screenshots.
 *
 * Commands:
 * - `/designer` — status: which DESIGN.md is in play and whether it conforms
 * - `/designer validate [path]` — full spec report
 * - `/designer <playbook> [target]` — route to an Impeccable playbook
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findDesignFile } from "./design-file.ts";
import { analyzeDesign, type DesignAnalysis, formatFindings, summarize } from "./spec.ts";
import { runScan } from "./engine/lib/scan-command.ts";
import { runDoctor } from "./engine/doctor.ts";
import { ENGINE_VERBS } from "./engine/lib/engine-verbs.ts";

/** Fixed tag: pi diffs prompt sections by name, so it must not vary per project. */
const SECTION_NAME = "design_context";
/**
 * Its own section, not a line in `design_context`: audits are requested in
 * projects without a DESIGN.md too, and the skill being vendored is independent
 * of the design file existing.
 */
const WORKFLOW_SECTION_NAME = "design_workflow";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(HERE, "skill");
const SKILL_FILE = path.join(SKILL_DIR, "SKILL.md");
/**
 * A skill's description only earns a load when the task matches it, and audits
 * did not match often enough (1 of 3 runs). This states the routing outright and
 * names the file, so the agent does not have to infer it from the skill list.
 */
const WORKFLOW_SECTION =
	`When the user asks for a design review, critique, audit, or polish, read ${SKILL_FILE} and follow its playbook before answering. It carries the rule catalog and the review procedure; do not improvise a review from the design file alone.`;
const COMMAND_METADATA = path.join(SKILL_DIR, "scripts", "command-metadata.json");
/** Designer's own verbs, which are not Impeccable playbooks. */
const OWN_VERBS = ["status", "validate", "detect", "doctor", "context", "palette", "concept-seed", "critique-storage", "surface-brief", "build-phase", "comp-spec", "font-match", "comp-diff"] as const;
/**
 * Skill verbs the vendored command metadata does not list, for completion only: both are owned
 * above, so the routing table does not need them. `hooks` is deliberately absent everywhere — it
 * installs detector hooks into other harnesses' manifests (`.claude/`, `.cursor/`, a committed
 * `.github/`) and pi is not one of them.
 */
const EXTRA_VERBS: ReadonlyMap<string, string> = new Map([
	["doctor", "Report and repair drift in this project's Impeccable artifacts"],
]);

interface Resolved {
	path: string;
	analysis: DesignAnalysis;
}

function analyzeFile(filePath: string): Resolved {
	return { path: filePath, analysis: analyzeDesign(fs.readFileSync(filePath, "utf8")) };
}

/** The project's design file and its analysis, or null when there is none. */
function resolveDesign(cwd: string): Resolved | null {
	const filePath = findDesignFile(cwd);
	return filePath ? analyzeFile(filePath) : null;
}

/** The prompt block the agent sees: where the file is, when to read it, and why. */
function buildSection(resolved: Resolved): string {
	const { name, summary } = resolved.analysis.meta;
	const lines = [`This project documents its design in ${resolved.path}`];
	if (name) lines.push(`Design system: ${name}`);
	lines.push(
		"Read it with the read tool before deciding on UI, layout, styling, component structure, or architecture, and follow the conventions it defines.",
	);
	lines.push(
		"Validity is checked by /designer validate, which the user runs: do not claim the file conforms to the spec.",
	);
	if (summary) lines.push(`Summary: ${summary}`);
	return lines.join("\n");
}

/** Impeccable playbook names from the vendored command metadata, for completion and routing. */
function loadPlaybooks(): Map<string, string> {
	const playbooks = new Map<string, string>(EXTRA_VERBS);
	if (!fs.existsSync(COMMAND_METADATA)) return playbooks;

	try {
		const metadata: unknown = JSON.parse(fs.readFileSync(COMMAND_METADATA, "utf8"));
		if (typeof metadata !== "object" || metadata === null) return playbooks;

		for (const [name, entry] of Object.entries(metadata)) {
			const description =
				typeof entry === "object" && entry !== null && typeof (entry as { description?: unknown }).description === "string"
					? (entry as { description: string }).description
					: undefined;
			playbooks.set(name, description ? oneLine(description) : name);
		}
	} catch {
		// A malformed metadata file only costs completions; routing stays by name.
	}
	return playbooks;
}

/** Keep a metadata description to a short, single-line completion label. */
function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 90 ? `${collapsed.slice(0, 89)}…` : collapsed;
}

/** Report spec errors to the human once per file, in UI modes only. */
function notifySpecErrors(resolved: Resolved, ctx: ExtensionContext, notified: Set<string>): void {
	const errors = resolved.analysis.findings.filter((finding) => finding.severity === "error");
	if (errors.length === 0 || notified.has(resolved.path)) return;
	notified.add(resolved.path);

	if (!ctx.hasUI) return;
	const detail = errors
		.slice(0, 3)
		.map((finding) => `${finding.line ? `line ${finding.line}: ` : ""}${finding.message}`)
		.join("\n");
	const more = errors.length > 3 ? `\n(+${errors.length - 3} more)` : "";
	ctx.ui.notify(`designer: ${path.basename(resolved.path)} has spec errors\n${detail}${more}\nRun /designer validate`, "warning");
}

export default function designer(pi: ExtensionAPI) {
	/** Files already reported this runtime, so the warning is not repeated every turn. */
	const notified = new Set<string>();
	const playbooks = loadPlaybooks();
	const hasSkill = fs.existsSync(SKILL_FILE);

	// Keep the vendored guidance discoverable for ordinary frontend requests.
	if (hasSkill) pi.on("resources_discover", () => ({ skillPaths: [SKILL_FILE] }));

	pi.on("before_agent_start", async (event, ctx) => {
		if (hasSkill) event.systemPromptOptions.sections[WORKFLOW_SECTION_NAME] = WORKFLOW_SECTION;
		else delete event.systemPromptOptions.sections[WORKFLOW_SECTION_NAME];

		const resolved = resolveDesign(ctx.cwd);

		if (!resolved) {
			delete event.systemPromptOptions.sections[SECTION_NAME];
			return;
		}

		event.systemPromptOptions.sections[SECTION_NAME] = buildSection(resolved);
		notifySpecErrors(resolved, ctx, notified);
	});

	const reportSpec = (ctx: ExtensionCommandContext, requested: string) => {
		const target = requested ? path.resolve(ctx.cwd, requested) : findDesignFile(ctx.cwd);
		if (!target) {
			ctx.ui.notify("designer: no DESIGN.md found between the working directory and the repo root.", "warning");
			return;
		}
		if (!fs.existsSync(target)) {
			ctx.ui.notify(`designer: no DESIGN.md at ${target}`, "warning");
			return;
		}

		const resolved = analyzeFile(target);
		const report = formatFindings(resolved.analysis.findings);
		const header = `${resolved.path}\n${summarize(resolved.analysis.findings)}`;
		ctx.ui.notify(
			report.length > 0 ? `${header}\n${report.join("\n")}` : `${header}\nconforms to the design.md spec`,
			"info",
		);
	};

	pi.registerCommand("designer", {
		description: "Own this project's DESIGN.md, or run an Impeccable design playbook",
		getArgumentCompletions(prefix) {
			const matches = [...OWN_VERBS, ...playbooks.keys()].filter((name) => name.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = tokens[0] ?? "status";
			const requested = tokens.slice(1).join(" ");

			if (subcommand === "validate") {
				reportSpec(ctx, requested);
				return;
			}

			if (subcommand === "detect") {
				// The detector runs here, in this process: the engine is TypeScript in this package, so the
				// command has no binary to find, no child to wait on, and no report to parse back out of stdout.
				const tokens = requested.split(/\s+/).filter(Boolean);
				const flags = new Set(tokens.filter((token) => token.startsWith("--")));
				const targets = tokens.filter((token) => !token.startsWith("--"));
				const scopes = [flags.has("--scope=type") || flags.has("--type") ? "type" : null, flags.has("--scope=layout") || flags.has("--layout") ? "layout" : null].filter((scope): scope is "type" | "layout" => scope !== null);

				const run = await runScan({ targets, cwd: ctx.cwd, json: flags.has("--json"), scopes });
				for (const warning of run.warnings) ctx.ui.notify(`designer detect: ${warning}`, "warning");
				if (run.degraded) {
					ctx.ui.notify(
						"designer detect: the HTML parser is not installed, so markup was scanned as text. Install htmlparser2, css-select, css-tree and domutils for the full pass.",
						"warning",
					);
				}
				ctx.ui.notify(run.text, run.findings > 0 ? "warning" : "info");
				if (run.notice) ctx.ui.notify(run.notice, "warning");
				return;
			}

			if (subcommand === "doctor") {
				// The deep pass runs here too, for the same reason as the detector: the report is this
				// package's own code, so there is nothing to shell out to and nothing to parse back.
				// `--fix` applies only the migrations that carry no decision, and says what it moved.
				const tokens = requested.split(/\s+/).filter(Boolean);
				try {
					const text = runDoctor({ cwd: ctx.cwd, args: tokens, json: tokens.includes("--json") });
					// A report is not a failure: findings are what the user reads, so the notification stays
					// informational unless the pass itself refused.
					ctx.ui.notify(text, "info");
				} catch (error) {
					ctx.ui.notify(`designer doctor: ${(error as Error).message}`, "warning");
				}
				return;
			}

			// The rest of the engine's verbs, by table: each one is a ported module, called here with no
			// process boundary between the command and the logic.
			const engineVerb = ENGINE_VERBS.get(subcommand);
			if (engineVerb) {
				const run = await engineVerb(requested.split(/\s+/).filter(Boolean), ctx.cwd);
				ctx.ui.notify(run.text, run.failed ? "warning" : "info");
				return;
			}

			if (playbooks.has(subcommand)) {
				if (!hasSkill) {
					ctx.ui.notify(
						`designer: the Impeccable skill is missing from ${HERE}. Reinstall the package; the skill ships with it.`,
						"warning",
					);
					return;
				}

				pi.sendUserMessage(
					`Use Impeccable for this request. Read ${JSON.stringify(SKILL_FILE)} and follow its routing and setup instructions. Resolve relative reference and script paths from ${JSON.stringify(SKILL_DIR)}.\n\nArguments: ${[subcommand, requested].filter(Boolean).join(" ")}`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			if (subcommand !== "status") {
				ctx.ui.notify(
					`designer: unknown subcommand "${subcommand}". Try /designer, /designer validate [path], or an Impeccable playbook such as /designer polish <target>`,
					"warning",
				);
				return;
			}

			const resolved = resolveDesign(ctx.cwd);
			if (!resolved) {
				ctx.ui.notify("designer: no DESIGN.md found between the working directory and the repo root.", "warning");
				return;
			}

			const { meta, findings, sections, references } = resolved.analysis;
			ctx.ui.notify(
				[
					`file: ${resolved.path}`,
					`name: ${meta.name ?? "(none)"}`,
					`sections: ${sections.length ? sections.join(", ") : "(none)"}`,
					`references: ${references}`,
					`spec: ${summarize(findings)}`,
					hasSkill ? `impeccable: ${path.relative(HERE, SKILL_DIR)} (${playbooks.size} playbooks)` : "impeccable: not vendored",
				].join("\n"),
				"info",
			);
		},
	});
}
