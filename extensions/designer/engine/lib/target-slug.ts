/**
 * One clone-stable slug per target, used to key stored critiques. Ported from Impeccable's
 * engine (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A slug has to survive a checkout moving, so a path becomes a name relative to the working
 * directory and falls back to the basename when it escapes it. A URL becomes its host and
 * path, because a stored critique should match the page, not the machine.
 */
import path from "node:path";

const SLUG_MAX = 50;

/** A lowercase, hyphen-separated form of the value, capped to the last 50 characters. */
function kebab(value: unknown): string | null {
	const slug = String(value || "")
		.toLowerCase()
		.replace(/[/\\.]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!slug) return null;
	// The tail is what identifies a deep path, so the cap keeps the end rather than the start.
	return slug.length <= SLUG_MAX ? slug : slug.slice(slug.length - SLUG_MAX).replace(/^-/, "");
}

/** The slug for a path or URL, or null when there is nothing to name. */
function slugFromTarget(resolved: string | null | undefined, { cwd = process.cwd() }: { readonly cwd?: string } = {}): string | null {
	if (!resolved || typeof resolved !== "string") return null;
	const trimmed = resolved.trim();
	if (!trimmed) return null;

	if (/^https?:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		return kebab(`${url.hostname}${url.pathname}`);
	}

	const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
	let rel = path.relative(cwd, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) rel = path.basename(abs);
	if (!rel || rel === ".") return null;
	return kebab(rel);
}

export { kebab, slugFromTarget, SLUG_MAX };
