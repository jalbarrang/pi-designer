/**
 * `--target` parsing, shared by every command that can be pointed at a path. Ported from
 * Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Strict mode exists for commands that must not silently scan the wrong thing: a bare
 * `--target` there is an error rather than something to ignore.
 */

/** A bad `--target` argument, carrying the code a CLI reports. */
class TargetArgError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "TargetArgError";
		this.code = code;
	}
}

/** The path a `--target`/`-t` argument names, or null when none was given. */
function parseTargetPath(args: readonly unknown[] = [], { strict = false }: { readonly strict?: boolean } = {}): string | null {
	let targetPath: string | null = null;

	for (let i = 0; i < args.length; i++) {
		const arg = String(args[i]);

		if (arg === "--target" || arg === "-t") {
			const next = args[i + 1];
			if (next && !String(next).startsWith("-")) {
				targetPath = String(next);
				i++;
				continue;
			}
			if (strict) throw new TargetArgError("--target requires a path value.", "TARGET_VALUE_MISSING");
			continue;
		}

		if (arg.startsWith("--target=")) {
			const value = arg.slice("--target=".length);
			if (value) {
				targetPath = value;
				continue;
			}
			if (strict) throw new TargetArgError("--target requires a path value.", "TARGET_VALUE_MISSING");
		}
	}

	return targetPath;
}

/** The target options object a loader takes: `{ targetPath }`, or empty. */
function parseTargetOptions(args: readonly unknown[] = [], options: { readonly strict?: boolean } = {}): { targetPath?: string } {
	const targetPath = parseTargetPath(args, options);
	return targetPath ? { targetPath } : {};
}

export { parseTargetOptions, parseTargetPath, TargetArgError };
