/**
 * The detector's command: what a host runs when the user asks for a scan, plus the comp-round notice the
 * reference prints after it. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The reference's `detect.mjs` is 30 lines: locate the bundled detector, run its CLI, then — so a
 * passing scan is not mistaken for a finished build — say when a comp round is still open. The scan
 * itself is `detect/scan.ts`, already in process; what is left is the notice and the report, so this is
 * that remainder and nothing more.
 */
import { compRoundOpen } from "./build-phase.ts";
import { scanTargets } from "../detect/scan.ts";
import type { ScanResult, ScanTargetsOptions } from "../detect/scan.ts";

/** The notice a scan prints when a comp round is open, or null when none is. */
function compRoundNotice(cwd: string = process.cwd()): string | null {
	const open = compRoundOpen(cwd);
	if (!open) return null;
	// stderr upstream, so `--json` stays parseable; the caller decides where it goes.
	return `COMP_ROUND_OPEN: ${open.reason}. A detector pass is not a finish: run build-phase status and follow its NEXT line before treating this page as built.`;
}

/** A scan for a host that asked the detector for one, with the notice that qualifies it. */
async function runDetect({
	targets,
	cwd = process.cwd(),
	options = {},
}: {
	readonly targets: readonly string[];
	readonly cwd?: string;
	readonly options?: ScanTargetsOptions;
}): Promise<{ report: ScanResult; notice: string | null }> {
	const report = await scanTargets(targets, { ...options, cwd });
	return { report, notice: compRoundNotice(cwd) };
}

export { compRoundNotice, runDetect };
