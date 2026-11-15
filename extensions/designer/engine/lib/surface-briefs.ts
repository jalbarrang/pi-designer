/**
 * Surface briefs: the per-surface strategy record (`.impeccable/surfaces/<slug>.md`) that
 * sits between the product record and the design system. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * A brief is keyed by its target: a project-relative path, or a `route:` for a URL-shaped
 * surface. Resolution reports *why* it failed (`ambiguous`, `ambiguous-target`,
 * `not-found`), because "no brief" and "three briefs, take your pick" need different
 * answers from the agent.
 */
import fs from "node:fs";
import path from "node:path";
import { slugFromTarget } from "./target-slug.ts";

const SURFACE_BRIEF_VERSION = 1;

/** Where briefs live for a project. */
function getSurfaceBriefDir(projectRoot: string): string {
	return path.join(projectRoot, ".impeccable", "surfaces");
}

/** A `route:` key for a URL-shaped surface, or null when the route is not a plain path. */
function normalizeRouteTarget(route: string): string | null {
	if (!route.startsWith("/") || route.includes("..")) return null;
	const normalized = route.split(/[?#]/, 1)[0].replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
	return `route:${normalized}`;
}

/** The canonical key for a surface target: a URL without query or hash, a route, or a project-relative path. */
function normalizeSurfaceTarget(target: string | null | undefined, { projectRoot = process.cwd() }: { readonly projectRoot?: string } = {}): string | null {
	if (!target || typeof target !== "string" || !target.trim()) return null;
	const trimmed = target.trim();

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			url.hash = "";
			url.search = "";
			return url.toString().replace(/\/$/, "") || url.origin;
		} catch {
			return null;
		}
	}

	if (/^route:/i.test(trimmed)) return normalizeRouteTarget(trimmed.slice(trimmed.indexOf(":") + 1).trim());
	if (trimmed === "/") return normalizeRouteTarget(trimmed);

	// A leading `/` is ambiguous: it can be an OS-absolute path or a route. It is a route
	// when it neither points into the project nor exists on disk.
	if (trimmed.startsWith("/")) {
		const absolute = path.resolve(trimmed);
		const relativeToProject = path.relative(projectRoot, absolute);
		const isProjectFile = relativeToProject && !relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject);
		if (!isProjectFile && !fs.existsSync(absolute)) return normalizeRouteTarget(trimmed);
	}

	const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectRoot, trimmed);
	const rel = path.relative(projectRoot, abs);
	if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

/** The brief file a target maps to, by slug. */
function surfaceBriefPathForTarget(target: string | null | undefined, { projectRoot = process.cwd() }: { readonly projectRoot?: string } = {}): string | null {
	const normalized = normalizeSurfaceTarget(target, { projectRoot });
	if (!normalized) return null;
	const slugInput = normalized.startsWith("route:") ? `route${normalized.slice("route:".length)}` : normalized;
	const slug = slugFromTarget(slugInput, { cwd: projectRoot });
	return slug ? path.join(getSurfaceBriefDir(projectRoot), `${slug}.md`) : null;
}

/** A parsed brief: its frontmatter, body, and the targets it claims. */
export interface SurfaceBrief {
	readonly path: string | null;
	readonly text: string;
	readonly body: string;
	readonly meta: Record<string, unknown>;
	readonly slug: string | null;
	readonly primaryTarget: string | null;
	readonly relatedTargets: string[];
	readonly targets: string[];
}

/**
 * Parse a brief's frontmatter. Values that read as JSON (arrays, objects, quoted strings,
 * booleans, numbers) are parsed; anything else stays a plain string with its quotes
 * stripped, so a hand-written brief still loads.
 */
function parseSurfaceBrief(text: string | null | undefined, filePath: string | null = null): SurfaceBrief {
	const source = String(text || "");
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	const meta: Record<string, unknown> = {};

	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const key = line.slice(0, colon).trim();
			const raw = line.slice(colon + 1).trim();
			if (!key) continue;

			if (/^(?:\[|\{|\")/.test(raw) || /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(raw)) {
				try {
					meta[key] = JSON.parse(raw);
					continue;
				} catch {
					// Not JSON after all: keep it as a string.
				}
			}
			meta[key] = raw.replace(/^['"]|['"]$/g, "");
		}
	}

	const primaryTarget = typeof meta.primary_target === "string" ? meta.primary_target : null;
	const relatedTargets = Array.isArray(meta.related_targets) ? meta.related_targets.filter((value): value is string => typeof value === "string") : [];

	return {
		path: filePath,
		text: source,
		body: match ? source.slice(match[0].length).trim() : source.trim(),
		meta,
		slug: typeof meta.slug === "string" ? meta.slug : filePath ? path.basename(filePath, ".md") : null,
		primaryTarget,
		relatedTargets,
		targets: [primaryTarget, ...relatedTargets].filter((target): target is string => !!target),
	};
}

/** Every brief in the project, sorted by filename. An unreadable or malformed one is skipped. */
function listSurfaceBriefs(projectRoot: string = process.cwd()): SurfaceBrief[] {
	const dir = getSurfaceBriefDir(projectRoot);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return [];
	}

	return names.flatMap((name) => {
		const filePath = path.join(dir, name);
		try {
			return [parseSurfaceBrief(fs.readFileSync(filePath, "utf-8"), filePath)];
		} catch {
			return [];
		}
	});
}

/** Why a brief resolved, or why it did not. */
export type SurfaceBriefReason = "only-brief" | "ambiguous" | "none" | "invalid-target" | "slug" | "mapping" | "ambiguous-target" | "not-found";

/** The brief for a surface, plus the candidates behind the answer. */
export interface SurfaceBriefResolution {
	readonly brief: SurfaceBrief | null;
	readonly candidates: readonly SurfaceBrief[];
	readonly reason: SurfaceBriefReason;
}

/**
 * Resolve the brief for a target, or the single brief when no target is named. The reason
 * distinguishes "there is exactly one" from "several, and the agent must ask".
 */
function resolveSurfaceBrief(projectRoot: string = process.cwd(), target: string | null = null): SurfaceBriefResolution {
	const briefs = listSurfaceBriefs(projectRoot);

	if (!target) {
		return {
			brief: briefs.length === 1 ? briefs[0] : null,
			candidates: briefs,
			reason: briefs.length === 1 ? "only-brief" : briefs.length > 1 ? "ambiguous" : "none",
		};
	}

	const normalized = normalizeSurfaceTarget(target, { projectRoot });
	if (!normalized) return { brief: null, candidates: briefs, reason: "invalid-target" };

	// The slug path wins when the brief also claims this target, so a renamed file cannot
	// hijack a target it never declared.
	const exactPath = surfaceBriefPathForTarget(normalized, { projectRoot });
	const exact = briefs.find((brief) => brief.path === exactPath && (!brief.targets.length || brief.targets.includes(normalized)));
	if (exact) return { brief: exact, candidates: briefs, reason: "slug" };

	const mapped = briefs.filter((brief) => brief.targets.includes(normalized));
	return {
		brief: mapped.length === 1 ? mapped[0] : null,
		candidates: mapped.length > 1 ? mapped : briefs,
		reason: mapped.length === 1 ? "mapping" : mapped.length > 1 ? "ambiguous-target" : "not-found",
	};
}

/** Write a brief for a target, replacing any brief at the same slug. */
function writeSurfaceBrief({
	projectRoot = process.cwd(),
	primaryTarget,
	relatedTargets = [],
	body,
}: {
	readonly projectRoot?: string;
	readonly primaryTarget: string;
	readonly relatedTargets?: readonly string[];
	readonly body?: string;
}): string {
	const normalizedPrimary = normalizeSurfaceTarget(primaryTarget, { projectRoot });
	if (!normalizedPrimary) throw new Error("surface brief requires a concrete project-relative primary target or URL");

	const normalizedRelated = [
		...new Set(
			relatedTargets
				.map((target) => normalizeSurfaceTarget(target, { projectRoot }))
				.filter((target): target is string => !!target && target !== normalizedPrimary),
		),
	];

	const slug = slugFromTarget(normalizedPrimary, { cwd: projectRoot });
	const filePath = surfaceBriefPathForTarget(normalizedPrimary, { projectRoot });
	if (!filePath) throw new Error("surface brief requires a concrete project-relative primary target or URL");

	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const frontmatter = [
		"---",
		`version: ${SURFACE_BRIEF_VERSION}`,
		`slug: ${JSON.stringify(slug)}`,
		`primary_target: ${JSON.stringify(normalizedPrimary)}`,
		`related_targets: ${JSON.stringify(normalizedRelated)}`,
		"---",
	].join("\n");
	fs.writeFileSync(filePath, `${frontmatter}\n\n${String(body || "").trim()}\n`, "utf-8");
	return filePath;
}

export {
	getSurfaceBriefDir,
	listSurfaceBriefs,
	normalizeRouteTarget,
	normalizeSurfaceTarget,
	parseSurfaceBrief,
	resolveSurfaceBrief,
	SURFACE_BRIEF_VERSION,
	surfaceBriefPathForTarget,
	writeSurfaceBrief,
};
