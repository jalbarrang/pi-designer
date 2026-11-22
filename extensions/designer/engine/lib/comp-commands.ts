/**
 * The comp commands: `comp-spec`, `font-match` and `comp-diff`, in process.
 *
 * Three verbs that work on pixels and a spec file. Each was a script; here each is a function over the
 * project it is given, writing only where the verb's job is to write (the grid, the spec, the crop, the
 * diff artifacts) and saying where it wrote.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { autoRegions, loadSpec, measureRegions, platePrompt, printSpec, renderGrid, type CompSpec, type RegionInput } from "./comp-spec.ts";
import { encodePng, loadRaster } from "./png.ts";
import { crop } from "./raster.ts";
import { matchRegion } from "./font-match.ts";
import { loadFontIndex } from "./font-index.ts";
import { diffBuilds } from "./comp-diff.ts";

/** The catalog index this package ships, resolved from this module so any cwd finds it. */
const FONT_INDEX = fileURLToPath(new URL("../data/font-index.json", import.meta.url));

/** What one comp command produced. */
interface CompResult {
	readonly text: string;
	readonly failed?: boolean;
}

/** `--flag value` and `--flag` out of an argument list. */
function flagsOf(args: readonly string[]): { value: (name: string) => string | null; has: (name: string) => boolean } {
	return {
		value: (name: string) => {
			const index = args.indexOf(`--${name}`);
			return index === -1 ? null : (args[index + 1] ?? null);
		},
		has: (name: string) => args.includes(`--${name}`),
	};
}

const resolveIn = (cwd: string, value: string) => (path.isAbsolute(value) ? value : path.resolve(cwd, value));

/**
 * `comp-spec`: the grid, the measured spec, the auto regions, a reference crop, and a plate prompt.
 *
 * The spec is written to `.impeccable/build/spec.json`, which is where every later gate reads it.
 */
function runCompSpec({ args, cwd = process.cwd() }: { readonly args: readonly string[]; readonly cwd?: string }): CompResult {
	const flags = flagsOf(args);
	const buildDir = path.join(cwd, ".impeccable", "build");
	const specPath = path.join(buildDir, "spec.json");

	if (flags.has("print")) {
		const spec = loadSpec(specPath);
		return spec ? { text: printSpec(spec) } : { text: `no spec at ${specPath}: run comp-spec --comp <png> --regions <json>`, failed: true };
	}

	if (flags.value("plate-prompt")) {
		const spec = loadSpec(specPath);
		if (!spec) return { text: "no spec", failed: true };
		const region = spec.regions.find((entry) => entry.id === flags.value("plate-prompt"));
		return region ? { text: platePrompt(spec, region) } : { text: `no region ${flags.value("plate-prompt")}`, failed: true };
	}

	if (flags.value("crop")) {
		const spec = loadSpec(specPath);
		if (!spec) return { text: "no spec", failed: true };
		const region = spec.regions.find((entry) => entry.id === flags.value("crop"));
		if (!region) return { text: `no region ${flags.value("crop")}`, failed: true };

		const comp = loadRaster(resolveIn(cwd, spec.comp)).image;
		const cropDir = path.join(buildDir, "crops");
		fs.mkdirSync(cropDir, { recursive: true });
		const out = path.join(cropDir, `${region.id}.png`);
		fs.writeFileSync(out, encodePng(crop(comp, region.px.x, region.px.y, region.px.w, region.px.h)));
		return { text: out };
	}

	const compPath = flags.value("comp");
	if (!compPath) return { text: "usage: comp-spec --comp <png> (--grid | --regions <json> | --auto)", failed: true };

	let comp: ReturnType<typeof loadRaster>["image"];
	try {
		comp = loadRaster(resolveIn(cwd, compPath)).image;
	} catch (error) {
		return { text: `cannot read comp ${compPath}: ${(error as Error).message}`, failed: true };
	}

	if (flags.has("grid")) {
		fs.mkdirSync(buildDir, { recursive: true });
		const out = path.join(buildDir, "comp-grid.png");
		fs.writeFileSync(out, encodePng(renderGrid(comp)));
		return { text: out };
	}

	if (flags.has("auto")) {
		// A band proposal for a comp with no regions file yet, printed rather than written: the regions are
		// the user's reading of the comp, not the tool's.
		return { text: JSON.stringify(autoRegions(comp), null, 2) };
	}

	const regionsPath = flags.value("regions");
	if (!regionsPath) return { text: "usage: comp-spec --comp <png> (--grid | --regions <json> | --auto)", failed: true };

	let input: { regions?: readonly RegionInput[]; allowUncovered?: boolean };
	try {
		input = JSON.parse(fs.readFileSync(resolveIn(cwd, regionsPath), "utf8")) as { regions?: readonly RegionInput[]; allowUncovered?: boolean };
	} catch (error) {
		return { text: `cannot read ${regionsPath}: ${(error as Error).message}`, failed: true };
	}

	try {
		const spec = measureRegions(comp, input, resolveIn(cwd, compPath));
		fs.mkdirSync(buildDir, { recursive: true });
		fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
		return { text: printSpec(spec) };
	} catch (error) {
		// Every refusal here names the region and the fix, so it is shown rather than swallowed.
		return { text: (error as Error).message, failed: true };
	}
}

/**
 * `font-match`: measure a text region's type, or rank candidates for it.
 *
 * With no browser the ranking records the catalog's nearest face, which is a real choice rather than a
 * guess; the spec keeps it with the stamp that tells a measured choice from a hand-typed one.
 */
function runFontMatch({ args, cwd = process.cwd() }: { readonly args: readonly string[]; readonly cwd?: string }): CompResult {
	const flags = flagsOf(args);
	const id = flags.value("measure") ?? flags.value("rank");
	if (!id) return { text: "usage: font-match --measure <region-id> | --rank <region-id> [--candidates \"Family:700,...\"]", failed: true };

	const specPath = path.join(cwd, ".impeccable", "build", "spec.json");
	const spec = loadSpec(specPath);
	if (!spec) return { text: `no spec at ${specPath}: run comp-spec first`, failed: true };

	const region = spec.regions.find((entry) => entry.id === id);
	if (!region) return { text: `no region ${id}; ids: ${spec.regions.map((entry) => entry.id).join(", ")}`, failed: true };

	const comp = loadRaster(resolveIn(cwd, spec.comp)).image;
	const index = loadFontIndex(flags.value("index") ? resolveIn(cwd, flags.value("index") as string) : FONT_INDEX);
	const match = matchRegion({ crop: crop(comp, region.px.x, region.px.y, region.px.w, region.px.h), own: parseOwn(flags.value("candidates")), index });

	if (!match.fingerprint) return { text: `MEASURE ${id}: no separable lettering in the crop; size the region by its box instead`, failed: true };

	const lines = [`MEASURE ${id}: ${match.description}`];
	if (flags.has("rank")) {
		const top = match.candidates.slice(0, 5).map((candidate) => `${candidate.family} ${candidate.weight}`);
		lines.push(`USE ${top[0] ?? "(none)"}`, `NEXT ${top.slice(1).join(" | ") || "(none)"}`, `SOURCE ${match.source}${match.belowRankCap ? "  (cap height below the trustworthy floor: size by the box)" : ""}`);
	}
	return { text: lines.join("\n") };
}

/** The caller's own candidate names, as `Family:weight` strings. */
function parseOwn(value: string | null): string[] {
	return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/** `comp-diff`: score a build capture against its comp and write the artifacts. */
function runCompDiff({ args, cwd = process.cwd() }: { readonly args: readonly string[]; readonly cwd?: string }): CompResult {
	const flags = flagsOf(args);
	const compPath = flags.value("comp");
	const buildPath = flags.value("build");
	if (!compPath || !buildPath) return { text: "usage: comp-diff --comp <png> --build <png> [--spec <json>] [--align top|stretch|cover] [--label name]", failed: true };

	try {
		const comp = loadRaster(resolveIn(cwd, compPath)).image;
		const build = loadRaster(resolveIn(cwd, buildPath)).image;
		const specPath = flags.value("spec") ?? path.join(cwd, ".impeccable", "build", "spec.json");
		const spec = fs.existsSync(resolveIn(cwd, specPath)) ? loadSpec(resolveIn(cwd, specPath)) : null;

		const outDir = resolveIn(cwd, flags.value("out-dir") ?? path.join(".impeccable", "review", "diff", flags.value("label") ?? "diff"));
		const result = diffBuilds({
			comp,
			build,
			spec,
			align: flags.value("align") ?? "top",
			label: flags.value("label") ?? path.basename(buildPath, path.extname(buildPath)),
			outDir,
			meta: { comp: compPath, build: buildPath, spec: spec ? specPath : null, compSize: `${comp.width}x${comp.height}`, buildSize: `${build.width}x${build.height}` },
		});

		fs.mkdirSync(outDir, { recursive: true });
		fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(result.report, null, 2));
		return { text: flags.has("json") ? JSON.stringify(result.report, null, 2) : result.text };
	} catch (error) {
		return { text: (error as Error).message, failed: true };
	}
}

export { runCompDiff, runCompSpec, runFontMatch };
export type { CompResult };
