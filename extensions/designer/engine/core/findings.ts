/**
 * Finding construction, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Rules never build a finding literal: `finding()` stamps the catalog's name,
 * description, and severity so a rule change reaches every report without
 * touching the check that emits it.
 */
import { getAntipattern } from "./registry/antipatterns.ts";
import type { Antipattern, Finding, Severity } from "../types.ts";

/** The catalog entry behind an id, or undefined when a check names a rule that does not exist. */
function getAP(id: string): Antipattern | undefined {
	return getAntipattern(id);
}

/**
 * Build a finding for rule `id`. A missing catalog entry is stamped as a
 * warning with no name rather than throwing: a typo in a check must not take
 * the whole scan down mid-file.
 */
function finding(id: string, filePath: string, snippet: string, line = 0): Finding {
	const ap = getAP(id);
	const severity: Severity = ap?.severity ?? "warning";
	const base: Finding = {
		antipattern: id,
		name: ap?.name ?? id,
		description: ap?.description ?? "",
		severity,
		category: ap?.category ?? null,
		file: filePath,
		line,
		snippet,
		...(ap?.advisory === true ? { advisory: true } : {}),
	};
	return base;
}

export { getAP, finding };
