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
 * - Impeccable guidance. The text began as a snapshot of upstream's Pi build
 *   (github.com/pbakaus/impeccable) and is edited here from that commit on;
 *   `guidance/UPSTREAM.json` records where it started. It ships as data
 *   (`guidance/corpus.ts`, `guidance/router.ts`), not as a skill tree: the model
 *   reads it through the tool, so there is no file to discover and no path to
 *   resolve. `scripts/import-guidance.mjs` is the importer that produced it.
 *
 * Audits are manual, like running a linter. No tool hooks are registered: nothing
 * scans an edit, blocks a write, or pushes findings into a turn. Design review
 * happens when it is asked for — `/designer <playbook>` delivers the guidance, and
 * `/designer detect <paths>` runs the detector here, in process.
 *
 * The engine is reachable from both sides of the conversation: the command notifies
 * the human, and the `design_check` tool returns the same text to the model, so an
 * audit reads real findings instead of guessing what a design linter would say.
 *
 * Ownership rules:
 * - The design file is advertised, never inlined, the way skills load, so its
 *   contents cost nothing until the agent reads them.
 * - The prompt section tag is fixed (`design_context`). Pi diffs prompt sections
 *   by name, so a tag that varied per project would churn the cache.
 * - Spec problems go to the human, once per session, never into the prompt: a
 *   broken design file is not the agent's task to fix.
 * - Design review is routed by a fixed `design_workflow` section. The guidance's own
 *   description was not enough: with only a skill entry, 1 of 3 audit runs loaded it
 *   and the other two improvised a review from the design file and screenshots.
 *
 * Commands:
 * - `/designer` — status: which DESIGN.md is in play and whether it conforms
 * - `/designer validate [path]` — full spec report
 * - `/designer <playbook> [target]` — deliver a playbook, router and body in one message
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findDesignFile } from "./design-file.ts";
import { analyzeDesign, type DesignAnalysis, type Finding, findingKey, formatFindings, summarize } from "./spec.ts";
import type { DesignScope } from "./engine/types.ts";
import { runScan } from "./engine/lib/scan-command.ts";
import { runDoctor } from "./engine/doctor.ts";
import { ENGINE_VERBS, renderContext } from "./engine/lib/engine-verbs.ts";
import { GUIDANCE_KEYS, PLAYBOOK_NAMES, readGuidance, routePlaybook } from "./guidance/index.ts";

/** Fixed tag: pi diffs prompt sections by name, so it must not vary per project. */
const SECTION_NAME = "design_context";
/**
 * Its own section, not a line in `design_context`: audits are requested in
 * projects without a DESIGN.md too, and the guidance being carried is independent
 * of the design file existing.
 */
const WORKFLOW_SECTION_NAME = "design_workflow";

/** The model's half of the engine surface: the reports the command shows the human. */
const TOOL_NAME = "design_check";

/**
 * The guidance is content this package owns, served by the tool. A skill's description only earned a
 * load when the task matched it, and audits did not match often enough (1 of 3 runs), so the routing
 * is stated outright and names the tool instead of a file.
 */
const WORKFLOW_SECTION =
	`When the user asks for a design review, critique, audit, or polish, or asks whether a chart or table is the right representation, call ${TOOL_NAME} with action "guide" and name "router" before answering, then run the playbook it routes you to. It carries the rule catalog and the review procedure; do not improvise a review from the design file alone.`;
/** Custom type for the routed playbook, so it reads as extension traffic and never as a typed prompt. */
const PLAYBOOK_MESSAGE_TYPE = "designer-playbook";
/** Designer's own verbs, which are not Impeccable playbooks. */
const OWN_VERBS = ["status", "validate", "detect", "doctor", "context", "palette", "concept-seed", "critique-storage", "surface-brief", "build-phase", "comp-spec", "font-match", "comp-diff"] as const;

interface Resolved {
	path: string;
	analysis: DesignAnalysis;
}

/**
 * Findings each file had when this session first read it. `validate` marks those `[pre-existing]`,
 * so a report does not present the file's old warnings as work from the current turn.
 */
const sessionBaseline = new Map<string, ReadonlySet<string>>();

function rememberBaseline(filePath: string, findings: readonly Finding[]): ReadonlySet<string> {
	const known = sessionBaseline.get(filePath);
	if (known) return known;
	const baseline = new Set(findings.map(findingKey));
	sessionBaseline.set(filePath, baseline);
	return baseline;
}

function analyzeFile(filePath: string): Resolved {
	const analysis = analyzeDesign(fs.readFileSync(filePath, "utf8"));
	rememberBaseline(filePath, analysis.findings);
	return { path: filePath, analysis };
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
		`Check it with the ${TOOL_NAME} tool (action "validate") before claiming the file conforms to the spec; do not assume it does.`,
	);
	if (summary) lines.push(`Summary: ${summary}`);
	return lines.join("\n");
}


/** The spec report for a file: what the command notifies and what the tool returns. */
function specReport(cwd: string, requested: string): string | null {
	const target = requested ? path.resolve(cwd, requested) : findDesignFile(cwd);
	if (!target || !fs.existsSync(target)) return null;

	const resolved = analyzeFile(target);
	const baseline = sessionBaseline.get(target) ?? new Set<string>();
	const findings = resolved.analysis.findings;
	const report = formatFindings(findings, baseline);
	const preExisting = findings.filter((finding) => baseline.has(findingKey(finding))).length;
	const preExistingLabel = preExisting > 0 ? ` (${preExisting} pre-existing)` : "";
	const legend = preExisting > 0 ? "\npre-existing: present when this session first read the file; not a change made during this session." : "";
	const header = `${resolved.path}\n${summarize(findings)}${preExistingLabel}${legend}`;
	return report.length > 0 ? `${header}\n${report.join("\n")}` : `${header}\nconforms to the design.md spec`;
}

/** What one `design_check` call answers, as text the model reads. */
interface CheckParams {
	readonly action: "detect" | "validate" | "context" | "guide";
	readonly targets?: readonly string[];
	readonly scopes?: readonly DesignScope[];
	readonly target?: string;
	/** guide: a playbook name, a guidance key, or a leftover path into the retired skill tree. */
	readonly name?: string;
}

/**
 * One `design_check` call.
 *
 * `context` says which design records the project has, so setup does not guess. `detect` scans files
 * and returns the findings, so an audit reports what the detector saw rather than what a linter might
 * plausibly say. `validate` returns the spec report, so the model can check the design file instead of
 * asserting it conforms. `guide` returns Impeccable's guidance, which is the package's own text rather
 * than a file the model has to find. The scans default to the working directory.
 */
async function runDesignCheck(params: CheckParams, cwd: string): Promise<string> {
	if (params.action === "guide") {
		const found = readGuidance(params.name ?? "router");
		if (found) return found.text;
		const known = [...PLAYBOOK_NAMES].sort().join(", ");
		return `No guidance under "${params.name ?? ""}". Playbooks: ${known}. Keys look like "router" or "reference/new-work.md".`;
	}

	if (params.action === "context") return renderContext(cwd);

	if (params.action === "validate") {
		return specReport(cwd, params.target ?? "") ?? "No DESIGN.md between the working directory and the repo root.";
	}

	const run = await runScan({ targets: params.targets ?? [], cwd, scopes: params.scopes ?? [] });
	const lines = [run.text, ...run.warnings.map((warning) => `warning: ${warning}`)];
	if (run.degraded) lines.push("The HTML parser is not installed, so markup was scanned as text.");
	if (run.notice) lines.push(run.notice);
	return lines.filter(Boolean).join("\n");
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
	const playbooks = PLAYBOOK_NAMES;

	pi.on("before_agent_start", async (event, ctx) => {
		event.systemPromptOptions.sections[WORKFLOW_SECTION_NAME] = WORKFLOW_SECTION;

		const resolved = resolveDesign(ctx.cwd);

		if (!resolved) {
			delete event.systemPromptOptions.sections[SECTION_NAME];
			return;
		}

		event.systemPromptOptions.sections[SECTION_NAME] = buildSection(resolved);
		notifySpecErrors(resolved, ctx, notified);
	});

	const reportSpec = (ctx: ExtensionCommandContext, requested: string) => {
		const report = specReport(ctx.cwd, requested);
		if (report) {
			ctx.ui.notify(report, "info");
			return;
		}
		ctx.ui.notify(
			requested
				? `designer: no DESIGN.md at ${path.resolve(ctx.cwd, requested)}`
				: "designer: no DESIGN.md found between the working directory and the repo root.",
			"warning",
		);
	};

	// The model's way into the engine. The command reports to the human; this returns the same text to
	// the agent, so an audit reads findings instead of asking the user to run a command and paste back.
	pi.registerTool({
		name: TOOL_NAME,
		label: "Design check",
		description:
			"Read this package's design guidance, run the project's design detector over files, check its DESIGN.md against the design.md spec, or report which design records the project has.",
		promptSnippet: `${TOOL_NAME} — design guidance and playbooks, the design detector, DESIGN.md validation, project design records`,
		promptGuidelines: [
			`Use ${TOOL_NAME} with action "guide" to load Impeccable's guidance: name "router" for the entry guidance and command table, or a playbook name such as "critique" or "polish". Guidance text names other guidance as keys like \`reference/new-work.md\`; read one with the same action and that name. There is no file to find.`,
			`Use ${TOOL_NAME} with action "context" once per session, before design work, instead of assuming which design records exist.`,
			`Use ${TOOL_NAME} with action "detect" when asked what a design linter reports, or before a design audit: it returns real findings from HTML and CSS rather than a description of what a linter might say.`,
			`Use ${TOOL_NAME} with action "validate" before claiming DESIGN.md conforms to the spec.`,
		],
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("context"), Type.Literal("detect"), Type.Literal("guide"), Type.Literal("validate")],
				{
					description:
						"guide: design guidance and playbooks. context: which design records this project has. detect: scan files for design anti-patterns. validate: check a DESIGN.md against the spec.",
				},
			),
			name: Type.Optional(
				Type.String({
					description:
						'guide: "router" for the entry guidance, a playbook name like "critique", or a key from the guidance like "reference/new-work.md".',
				}),
			),
			targets: Type.Optional(
				Type.Array(Type.String(), {
					description: "detect: files or directories, relative to the project. Defaults to the working directory.",
				}),
			),
			scopes: Type.Optional(
				Type.Array(Type.Union([Type.Literal("type"), Type.Literal("layout")]), {
					description: "detect: narrow to the type rules, the layout rules, or both.",
				}),
			),
			target: Type.Optional(
				Type.String({ description: "validate: path to a DESIGN.md. Defaults to this project's file." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// The engine is TypeScript in this package, so a tool call is a function call: no binary to
			// find, no child to wait on, and no report to parse back out of stdout.
			//
			// Guidance is returned whole, not truncated the way a search result would be: the text is the
			// deliverable, and there is no file behind it for a pointer to name.
			const text = await runDesignCheck(params, ctx.cwd);
			return { content: [{ type: "text", text }], details: { action: params.action, name: params.name } };
		},
	});

	pi.registerCommand("designer", {
		description: "Own this project's DESIGN.md, or run an Impeccable design playbook",
		getArgumentCompletions(prefix) {
			const matches = [...OWN_VERBS, ...playbooks].filter((name) => name.startsWith(prefix));
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

			const routed = routePlaybook(subcommand);
			if (routed) {
				// A custom message, not a user message: the order reaches the model the same way, but the
				// transcript shows extension traffic rather than a prompt the user never typed. The text is
				// the router plus the playbook body, so there is no path to resolve and nothing to read first.
				await pi.sendMessage(
					{
						customType: PLAYBOOK_MESSAGE_TYPE,
						content: `Use Impeccable for this request, following this guidance.\n\n${routed.text}\n\nRequest: ${[subcommand, requested].filter(Boolean).join(" ")}`,
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
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
					`impeccable: ${playbooks.length} playbooks, ${GUIDANCE_KEYS.length} guidance keys`,
				].join("\n"),
				"info",
			);
		},
	});
}
