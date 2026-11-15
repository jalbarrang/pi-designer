/**
 * The engine verbs pi owns: each one a function from arguments and a working directory to text.
 *
 * The point of the table is that adding a verb is one row, and that the command handler stays a
 * dispatcher rather than a chain of ifs that grows with the engine. Everything here calls the ported
 * module directly — no binary, no child process, no report to parse back out of stdout.
 */
import path from "node:path";
import { loadContext } from "../context.ts";
import { fmtOklch, hueWord, parsePaletteArgs, pickSeed, renderSeed, SEEDS } from "./palette.ts";
import { renderConceptSeed, type ResolvedRoll } from "./concept-seed.ts";
import { runBuildPhase } from "./build-phase-command.ts";
import { runCompDiff, runCompSpec, runFontMatch } from "./comp-commands.ts";
import { runCritiqueStore } from "./critique-store-command.ts";
import { exitCodeFor, readBodyFile, runSurfaceBriefCommand, type BriefResult } from "./surface-brief-command.ts";

/** What one verb produced: text to show, and whether it is a failure. */
interface VerbRun {
	readonly text: string;
	readonly failed?: boolean;
}

/** A verb's implementation: its arguments as typed, and the project directory. */
type VerbHandler = (args: readonly string[], cwd: string) => Promise<VerbRun> | VerbRun;

/**
 * What the project's context is, as one readable block.
 *
 * The skill calls this once per session to learn which artifacts exist and whether the project has
 * visual implementation, so the block is those facts in the order a reader needs them.
 */
function renderContext(cwd: string): string {
	const ctx = loadContext(cwd);
	const lines = [
		`PROJECT ${ctx.projectRoot}${ctx.isMonorepo ? ` (monorepo, repo root ${ctx.repoRoot})` : ""}`,
		`PRODUCT ${ctx.hasProduct ? (ctx.productPath ?? "present") : "absent"}`,
		`DESIGN ${ctx.hasDesign ? (ctx.designPath ?? "present") : "absent"}`,
		`VISUAL ${ctx.hasVisualImplementation ? "yes" : "no"}${ctx.platform ? `  platform ${ctx.platform}` : ""}`,
	];
	if (ctx.hasSurfaceBrief) lines.push(`SURFACE BRIEF ${ctx.surfaceBriefPath ?? "present"}`);
	else if (ctx.surfaceBriefCandidates.length > 1) {
		// Several briefs and no target: the agent has to ask which surface, so the report names them.
		lines.push(`SURFACE BRIEFS ${ctx.surfaceBriefCandidates.map((brief) => brief.path).join(", ")} (name a target)`);
	} else lines.push("SURFACE BRIEF absent");
	return lines.join("\n");
}

/** The palette verb: a seed drawn by key or id, and the composition guidance that goes with it. */
function runPalette(args: readonly string[]): VerbRun {
	const parsed = parsePaletteArgs(args);
	try {
		return { text: renderSeed(pickSeed(SEEDS, parsed)) };
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}

/**
 * The direction or surface round, rendered.
 *
 * Resolving the catalog and reaching the roll service are the host's job, so this passes a local
 * catalog when one is configured and lets the module render the degraded round when there is none.
 */
function runConceptSeed(args: readonly string[]): VerbRun {
	const value = (flag: string) => {
		const index = args.indexOf(`--${flag}`);
		return index === -1 ? null : (args[index + 1] ?? null);
	};
	const scope = value("scope") ?? "surface";
	const key = value("from") ?? undefined;
	const reroll = value("reroll") ? Number(value("reroll")) : 0;
	const register = value("register");
	const mode = value("mode");
	const grain = value("grain");
	const platform = value("platform");
	const candidateCount = value("candidate-count") ? Number(value("candidate-count")) : 7;

	try {
		const data: ResolvedRoll | null = null;
		return {
			text: renderConceptSeed({
				// Passed through unsanitized: the module refuses an unknown scope, and coercing it here would
				// turn a typo into a silent surface round.
				scope: scope as "direction" | "surface",
				...(key ? { key } : {}),
				reroll,
				register: register === "safer" || register === "bolder" ? register : null,
				mode,
				grain,
				platform,
				candidateCount,
				_resolvedData: data,
			}),
		};
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}


/** The surface-brief verb: `path`, `list`, `read` and `write`, with the write's body read from a file. */
function runSurfaceBrief(args: readonly string[], cwd: string): VerbRun {
	const [command = "list", target = null, bodyArg = null, ...related] = args;
	try {
		const result: BriefResult = runSurfaceBriefCommand({
			command,
			cwd,
			target,
			body: command === "write" && bodyArg ? readBodyFile(path.isAbsolute(bodyArg) ? bodyArg : path.resolve(cwd, bodyArg)) : null,
			relatedTargets: related,
		});

		if (result.text != null) return { text: result.text };
		if (result.path != null) return { text: result.path };
		if (result.list) {
			const rows = result.list.map((brief) => `${brief.path}  ${brief.primaryTarget ?? brief.slug ?? ""}`);
			return { text: rows.join("\n") || "no surface briefs" };
		}
		if (result.notFound) {
			// A near miss is a question, so the candidates are the answer rather than an error.
			const rows = (result.candidates ?? []).map((brief) => `${brief.path}  ${brief.primaryTarget ?? brief.slug ?? ""}`);
			return { text: `no surface brief matches that target${rows.length > 0 ? `\ncandidates:\n${rows.join("\n")}` : ""}`, failed: exitCodeFor(result) !== 0 };
		}
		return { text: "no surface briefs" };
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}
/** The verbs pi can run itself, by name. */
const ENGINE_VERBS: ReadonlyMap<string, VerbHandler> = new Map<string, VerbHandler>([
	["context", (_args, cwd) => ({ text: renderContext(cwd) })],
	["palette", (args) => runPalette(args)],
	["concept-seed", (args) => runConceptSeed(args)],
	["critique-storage", (args, cwd) => runCritiqueStore({ args, cwd })],
	["surface-brief", (args, cwd) => runSurfaceBrief(args, cwd)],
	["build-phase", (args, cwd) => runBuildPhase({ args, cwd })],
	["comp-spec", (args, cwd) => runCompSpec({ args, cwd })],
	["font-match", (args, cwd) => runFontMatch({ args, cwd })],
	["comp-diff", (args, cwd) => runCompDiff({ args, cwd })],
]);

export { ENGINE_VERBS, renderContext, runConceptSeed, runPalette, runSurfaceBrief };
export type { VerbHandler, VerbRun };
