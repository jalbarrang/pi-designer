/**
 * The surface-brief command: `path`, `list`, `read` and `write`, as a dispatcher a host calls instead
 * of a CLI. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The library underneath is `surface-briefs.ts`; this layer only decides what each subcommand means and
 * what a caller should print or report. Returning a result rather than writing to stdout keeps the
 * exit codes a decision the caller makes, which is what lets pi route a "not found" into a question
 * instead of a session that ends.
 */
import fs from "node:fs";
import path from "node:path";
import { listSurfaceBriefs, resolveSurfaceBrief, surfaceBriefPathForTarget, writeSurfaceBrief, type SurfaceBrief } from "./surface-briefs.ts";

/** A brief as a report prints it: the path relative to the project, and what it names. */
interface BriefSummary {
	readonly slug: string | null;
	readonly path: string;
	readonly primaryTarget: string | null;
	readonly relatedTargets: readonly string[];
}

function summary(brief: SurfaceBrief, projectRoot: string): BriefSummary {
	return {
		slug: brief.slug,
		path: (brief.path ? path.relative(projectRoot, brief.path) : "").split(path.sep).join("/"),
		primaryTarget: brief.primaryTarget,
		relatedTargets: brief.relatedTargets,
	};
}

/** What a subcommand produced: text to print, or a report the caller renders. */
interface BriefResult {
	/** The brief's own text, when the command printed one. */
	readonly text?: string;
	/** A path the caller reports, when the command produced one. */
	readonly path?: string;
	/** Briefs to render, when the command listed or matched some. */
	readonly list?: readonly BriefSummary[];
	/** The candidates to offer when a read matched several briefs or none. */
	readonly candidates?: readonly BriefSummary[];
	/** True when a read found nothing to print. */
	readonly notFound?: boolean;
}

/**
 * Run one surface-brief subcommand.
 *
 * `write` needs a target and a body; `read` with no exact match returns its candidates rather than
 * failing, because a near miss is a question to ask, not an error to die on.
 */
function runSurfaceBriefCommand({
	command,
	cwd = process.cwd(),
	target = null,
	body = null,
	relatedTargets = [],
}: {
	readonly command: string;
	readonly cwd?: string;
	readonly target?: string | null;
	readonly body?: string | null;
	readonly relatedTargets?: readonly string[];
}): BriefResult {
	const projectRoot = cwd;

	if (command === "path") {
		const filePath = surfaceBriefPathForTarget(target, { projectRoot });
		if (!filePath) throw new Error("surface brief path requires a concrete target");
		return { path: path.relative(cwd, filePath) || filePath };
	}

	if (command === "list") {
		return { list: listSurfaceBriefs(projectRoot).map((brief) => summary(brief, projectRoot)) };
	}

	if (command === "read") {
		const result = resolveSurfaceBrief(projectRoot, target || null);
		if (result.brief) return { text: result.brief.text };
		return { notFound: true, candidates: result.candidates.map((brief) => summary(brief, projectRoot)) };
	}

	if (command === "write") {
		if (!target || body == null) throw new Error("usage: surface-brief write <primary-target> <body>");
		const filePath = writeSurfaceBrief({ projectRoot, primaryTarget: target, relatedTargets, body });
		return { path: path.relative(cwd, filePath) || filePath };
	}

	throw new Error("usage: surface-brief <path|list|read|write> [target] [body] [related-target ...]");
}

/** The body of a brief read from a file, so a command can pass a path instead of text. */
function readBodyFile(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

/** The exit code a result implies: 2 for a read that found nothing, 0 otherwise. */
function exitCodeFor(result: BriefResult): number {
	return result.notFound ? 2 : 0;
}

export { exitCodeFor, readBodyFile, runSurfaceBriefCommand, summary };
export type { BriefResult, BriefSummary };
