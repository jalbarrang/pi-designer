/**
 * Detector profiling: where a scan spends its time and which rules produced what.
 * Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * The profile is opt-in all the way down. With no profile, every wrapper is a plain
 * call, so the measured path and the normal path cannot drift apart.
 */

/** A monotonic clock reading. `performance.now` where it exists, wall clock otherwise. */
function profileNow(): number {
	return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/** One recorded event: what ran, for how long, and what it produced. */
export interface ProfileEvent {
	readonly engine: string;
	readonly phase: string;
	readonly ruleId: string;
	readonly target: string;
	readonly ms: number;
	readonly findings: number;
	readonly detail?: string;
	readonly findingIds?: readonly string[];
}

/** What a caller may pass as a profile: a sink function, an event array, or a recorder. */
export type DetectorProfile =
	| { readonly events: ProfileEvent[] }
	| ProfileEvent[]
	| ((event: ProfileEvent) => void)
	| { record(event: ProfileEvent): void }
	| null
	| undefined;

/** Where a measured step reports. */
export interface ProfileMeta {
	readonly engine?: string;
	readonly phase?: string;
	readonly ruleId?: string;
	readonly target?: string;
	readonly detail?: string;
}

/** A fresh, empty profile. */
function createDetectorProfile(): { events: ProfileEvent[] } {
	return { events: [] };
}

function recordProfileEvent(profile: DetectorProfile, event: ProfileMeta & { readonly ms?: number; readonly findings?: number; readonly findingIds?: readonly string[] }): void {
	if (!profile) return;
	const normalized: ProfileEvent = {
		engine: event.engine || "unknown",
		phase: event.phase || "unknown",
		ruleId: event.ruleId || "unknown",
		target: event.target || "",
		ms: Number.isFinite(event.ms) ? (event.ms as number) : 0,
		findings: Number.isFinite(event.findings) ? (event.findings as number) : 0,
		...(event.detail ? { detail: event.detail } : {}),
		...(Array.isArray(event.findingIds) && event.findingIds.length > 0 ? { findingIds: event.findingIds } : {}),
	};

	if (typeof profile === "function") profile(normalized);
	else if (!Array.isArray(profile) && "record" in profile && typeof profile.record === "function") profile.record(normalized);
	else if (!Array.isArray(profile) && "events" in profile && Array.isArray(profile.events)) profile.events.push(normalized);
	else if (Array.isArray(profile)) profile.push(normalized);
}

/** The distinct rule ids in a finding list, for the profile's per-event summary. */
function extractFindingIds(findings: unknown): string[] {
	if (!Array.isArray(findings) || findings.length === 0) return [];
	return [
		...new Set(
			findings
				.map((f: { id?: string; type?: string; antipattern?: string }) => f?.id || f?.type || f?.antipattern)
				.filter((id): id is string => !!id),
		),
	];
}

/** Time a step that produces findings, recording the count and distinct rules. */
function profileFindings<T>(profile: DetectorProfile, meta: ProfileMeta, callback: () => T): T {
	if (!profile) return callback();
	const started = profileNow();
	const findings = callback();
	recordProfileEvent(profile, {
		...meta,
		ms: profileNow() - started,
		findings: Array.isArray(findings) ? findings.length : 0,
		findingIds: extractFindingIds(findings),
	});
	return findings;
}

/** Time a step that produces something other than findings. */
function profileStep<T>(profile: DetectorProfile, meta: ProfileMeta, callback: () => T): T {
	if (!profile) return callback();
	const started = profileNow();
	try {
		return callback();
	} finally {
		recordProfileEvent(profile, { ...meta, ms: profileNow() - started, findings: 0 });
	}
}

/** The async twin of {@link profileFindings}. */
async function profileFindingsAsync<T>(profile: DetectorProfile, meta: ProfileMeta, callback: () => Promise<T>): Promise<T> {
	if (!profile) return callback();
	const started = profileNow();
	const findings = await callback();
	recordProfileEvent(profile, {
		...meta,
		ms: profileNow() - started,
		findings: Array.isArray(findings) ? findings.length : 0,
		findingIds: extractFindingIds(findings),
	});
	return findings;
}

/** The async twin of {@link profileStep}. */
async function profileStepAsync<T>(profile: DetectorProfile, meta: ProfileMeta, callback: () => Promise<T>): Promise<T> {
	if (!profile) return callback();
	const started = profileNow();
	try {
		return await callback();
	} finally {
		recordProfileEvent(profile, { ...meta, ms: profileNow() - started, findings: 0 });
	}
}

/** The value at a percentile of an ascending list, 0 for an empty one. */
function percentile(sortedValues: readonly number[], pct: number): number {
	if (sortedValues.length === 0) return 0;
	const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1));
	return sortedValues[idx];
}

/** One line of the summary: a group of events with its timing distribution. */
export interface ProfileSummary {
	readonly engine: string;
	readonly phase: string;
	readonly ruleId: string;
	readonly target: string;
	readonly calls: number;
	readonly totalMs: number;
	readonly avgMs: number;
	readonly p50: number;
	readonly p95: number;
	readonly findings: number;
}

/** The event list a profile holds, when it is one of the container shapes. */
function profileEvents(profile: DetectorProfile): readonly ProfileEvent[] {
	if (!profile) return [];
	if (Array.isArray(profile)) return profile;
	if (typeof profile !== "function" && "events" in profile && Array.isArray(profile.events)) return profile.events as readonly ProfileEvent[];
	return [];
}

/**
 * Group a profile by engine, phase, rule, and target, and summarize each group with
 * total, average, median, and p95 time. Sorted by total time, because the first line is
 * the one worth reading.
 */
function summarizeDetectorProfile(profile: DetectorProfile): ProfileSummary[] {
	const events = profileEvents(profile);

	interface Group {
		engine: string;
		phase: string;
		ruleId: string;
		target: string;
		calls: number;
		totalMs: number;
		findings: number;
		samples: number[];
	}

	const groups = new Map<string, Group>();
	for (const event of events) {
		const key = [event.engine || "unknown", event.phase || "unknown", event.ruleId || "unknown", event.target || ""].join("\u0000");
		let group = groups.get(key);
		if (!group) {
			group = {
				engine: event.engine || "unknown",
				phase: event.phase || "unknown",
				ruleId: event.ruleId || "unknown",
				target: event.target || "",
				calls: 0,
				totalMs: 0,
				findings: 0,
				samples: [],
			};
			groups.set(key, group);
		}
		const ms = Number.isFinite(event.ms) ? event.ms : 0;
		group.calls += 1;
		group.totalMs += ms;
		group.findings += Number.isFinite(event.findings) ? event.findings : 0;
		group.samples.push(ms);
	}

	return [...groups.values()]
		.map((group) => {
			const samples = group.samples.sort((a, b) => a - b);
			return {
				engine: group.engine,
				phase: group.phase,
				ruleId: group.ruleId,
				target: group.target,
				calls: group.calls,
				totalMs: Number(group.totalMs.toFixed(3)),
				avgMs: Number((group.totalMs / group.calls).toFixed(3)),
				p50: Number(percentile(samples, 50).toFixed(3)),
				p95: Number(percentile(samples, 95).toFixed(3)),
				findings: group.findings,
			};
		})
		.sort((a, b) => b.totalMs - a.totalMs);
}

export {
	createDetectorProfile,
	extractFindingIds,
	percentile,
	profileFindings,
	profileFindingsAsync,
	profileNow,
	profileStep,
	profileStepAsync,
	recordProfileEvent,
	summarizeDetectorProfile,
};
