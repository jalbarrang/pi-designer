/**
 * The build phase machine, as a command.
 *
 * `build-phase.ts` is the ported machine; this is the eight subcommands the playbooks call, reading and
 * writing the state file under the project the command was given rather than the process directory. A
 * refusal keeps the state unchanged and returns the reasons, so a caller shows them and stops.
 */
import fs from "node:fs";
import path from "node:path";
import {
	advance,
	finish,
	gateHero,
	HERO_REPRO,
	loadState,
	newState,
	nextInstruction,
	renderStatus,
	saveState,
	STATE_PATH,
	writeScaffold,
} from "./build-phase.ts";
import { loadSpec } from "./comp-spec.ts";
import { loadRaster } from "./png.ts";

/** What one build-phase command produced. */
interface PhaseResult {
	readonly text: string;
	readonly failed?: boolean;
	/** True when the command closed a phase. */
	readonly advanced?: boolean;
}

/** `--flag value` and `--flag` out of an argument list. */
function readFlags(args: readonly string[]): { value: (name: string) => string | null; has: (name: string) => boolean } {
	return {
		value: (name: string) => {
			const index = args.indexOf(`--${name}`);
			return index === -1 ? null : (args[index + 1] ?? null);
		},
		has: (name: string) => args.includes(`--${name}`),
	};
}

/**
 * Run one build-phase subcommand in a project.
 *
 * A command that needs state refuses without it and names the `start` call, because the alternative —
 * silently creating state — hides the fact that the round was never opened.
 */
function runBuildPhase({ args, cwd = process.cwd() }: { readonly args: readonly string[]; readonly cwd?: string }): PhaseResult {
	const [command] = args;
	const flags = readFlags(args);
	const statePath = path.join(cwd, STATE_PATH);

	if (command === "start") {
		const comp = flags.value("comp");
		const direction = flags.value("direction");
		if (!comp && !direction) return { text: "usage: build-phase start --comp <png> | --direction <seed key>", failed: true };
		if (comp && !fs.existsSync(path.resolve(cwd, comp))) return { text: `comp ${comp} does not exist`, failed: true };

		const existing = loadState(statePath);
		if (existing && !flags.has("reset")) {
			// Starting over a live state would erase the attempt history a gate reads, so it is refused
			// rather than assumed.
			return { text: `state exists (phase ${existing.phase}); pass --reset to start over\n${renderStatus(existing)}`, failed: true };
		}

		let breakpoint = flags.value("breakpoint");
		if (!breakpoint && comp) {
			try {
				const image = loadRaster(path.resolve(cwd, comp)).image;
				breakpoint = `${image.width}x${image.height}`;
			} catch {
				// A non-PNG comp leaves the breakpoint unset.
			}
		}

		const state = newState({ comp: comp ? path.resolve(cwd, comp) : null, breakpoint, artifact: flags.value("artifact"), direction });
		saveState(state, statePath);
		// The roll's pending marker is cleared by starting: the build has begun.
		fs.rmSync(path.join(cwd, ".impeccable", "build", "pending.json"), { force: true });
		return { text: renderStatus(state) };
	}

	if (command === "scaffold") {
		const spec = loadSpec(path.join(cwd, ".impeccable", "build", "spec.json"));
		if (!spec) return { text: "no spec: run comp-spec first", failed: true };
		const state = loadState(statePath);
		if (!state) return { text: "no state: run build-phase start first", failed: true };

		const out = writeScaffold(spec, state, { dir: path.join(cwd, ".impeccable", "build", "scaffold") });
		return { text: `SCAFFOLD ${out.dir}\n  ${out.css}   one custom property set per region\n  ${out.html}  a reference page: every region at its box` };
	}

	const state = loadState(statePath);
	if (!state) return { text: "no state: run build-phase start --comp <approved comp>", failed: true };

	if (command === "status") {
		return { text: flags.has("json") ? JSON.stringify(state, null, 2) : renderStatus(state) };
	}

	if (command === "note") {
		const text = args.slice(1).filter((value) => !value.startsWith("--")).join(" ");
		state.phases[state.phase].notes.push({ at: new Date().toISOString(), text });
		saveState(state, statePath);
		return { text: `noted on ${state.phase}` };
	}

	if (command === "record") {
		if (args[1] !== "hero") return { text: "usage: build-phase record hero [--build <png>]", failed: true };
		const buildPath = path.resolve(cwd, flags.value("build") ?? HERO_REPRO);
		const gate = gateHero(state, {
			buildPath,
			artifact: flags.value("artifact"),
			specPath: path.join(cwd, ".impeccable", "build", "spec.json"),
			outDir: path.join(cwd, ".impeccable", "review", "diff", "hero"),
			cwd,
		});
		// A record is a look, not an attempt: the plates-only capture is expected to fail on text regions,
		// and counting it would muddy the tally a gate reads.
		state.phases.hero.records = (state.phases.hero.records ?? 0) + 1;
		state.phases.hero.gate = { ...gate, at: new Date().toISOString() } as Record<string, unknown>;
		saveState(state, statePath);

		const plateRows = Object.entries(gate.regionVerdicts ?? {}).filter(([id]) => {
			const spec = loadSpec(path.join(cwd, ".impeccable", "build", "spec.json"));
			const region = spec?.regions.find((entry) => entry.id === id);
			return region?.medium === "raster";
		});
		const lines = [
			...(plateRows.length > 0 ? [`PLATES ${plateRows.map(([id, verdict]) => `${id}:${verdict}`).join(" ")}`] : []),
			`${gate.ok ? "PASS" : "FAIL"} ${gate.summary ?? ""} (record: nothing advanced)`,
			...(gate.reasons ?? []).map((reason) => `  - ${reason}`),
			...(gate.advisories ?? []).map((advisory) => `  ${advisory}`),
			...(gate.worst ? [`  worst: ${gate.worst.join("; ")}`] : []),
			...(gate.sideBySide ? [`  open ${gate.sideBySide}`] : []),
		];
		return { text: lines.join("\n"), failed: !gate.ok };
	}

	if (command === "advance") {
		// Every gate resolves its own paths against the process by default, so the project's paths are
		// passed in: a command run from a parent directory must still read that project's mocks and spec.
		const gateOpts: Record<string, unknown> = {
			cwd,
			mocksDir: path.join(cwd, ".impeccable", "mocks"),
			specPath: path.join(cwd, ".impeccable", "build", "spec.json"),
			outDir: path.join(cwd, ".impeccable", "review", "diff", state.phase),
		};
		const build = flags.value("build");
		if (build) gateOpts.buildPath = path.resolve(cwd, build);
		if (flags.value("artifact")) gateOpts.artifact = path.resolve(cwd, flags.value("artifact") as string);

		const result = advance(state, { force: flags.has("force"), reason: flags.value("reason"), gateOpts });
		saveState(state, statePath);

		if (!result.ok) {
			const lines = [`GATE ${result.phase ? result.phase.toUpperCase() : ""} FAILED (state unchanged)`];
			for (const crop of result.gate?.worstCrops ?? []) {
				lines.push(`  ${crop.file}   ${crop.id}: ${crop.verdict} ${(crop.score.overall * 100).toFixed(0)}%`);
			}
			for (const reason of result.reasons ?? []) lines.push(`  - ${reason}`);
			for (const advisory of result.gate?.advisories ?? []) lines.push(`  ${advisory}`);
			return { text: lines.join("\n"), failed: true };
		}

		return {
			text: [`ADVANCED ${result.phase} -> ${result.next}${result.forced ? " (FORCED; recorded)" : ""}${result.gate?.summary ? `  ${result.gate.summary}` : ""}`, ...(result.gate?.advisories ?? []).map((advisory) => `  ${advisory}`), `NEXT ${nextInstruction(state)}`].join("\n"),
			advanced: true,
		};
	}

	if (command === "finish") {
		const disposition = flags.value("disposition");
		if (!disposition) return { text: "usage: build-phase finish --disposition ship|fix|rebuild|recapture", failed: true };
		const result = finish(state, disposition);
		if (!result.ok) return { text: result.error ?? "finish refused", failed: true };
		saveState(result.state, statePath);
		return { text: renderStatus(result.state) };
	}

	return { text: "usage: build-phase <start|status|advance|record|scaffold|note|finish> ...", failed: true };
}

export { runBuildPhase };
export type { PhaseResult };
