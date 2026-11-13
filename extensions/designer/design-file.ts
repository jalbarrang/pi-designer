/**
 * Locates the project's DESIGN.md.
 *
 * Discovery walks from the working directory up to the repository root (the
 * first directory containing `.git`) and stops there, so a monorepo package can
 * carry its own design file without inheriting one from above the repo. The
 * closest file wins.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Checked in order; the first match in a directory wins. */
const DESIGN_FILENAMES = ["DESIGN.md", "DESIGN.MD", "design.md"];

/** Absolute path of the DESIGN.md in effect for `cwd`, or null when there is none. */
export function findDesignFile(cwd: string): string | null {
	let dir = path.resolve(cwd);

	while (true) {
		for (const name of DESIGN_FILENAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}

		// A `.git` entry marks the repo root: do not search above it.
		if (fs.existsSync(path.join(dir, ".git"))) return null;

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
