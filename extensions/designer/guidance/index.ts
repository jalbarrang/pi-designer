/**
 * The guidance corpus, as the extension serves it.
 *
 * Impeccable used to arrive as a vendored skill tree: `SKILL.md` plus `reference/*.md`, discovered by
 * pi, read by the model with its own tools, and resolved against a directory path. It is content this
 * package owns now, so it ships as data and comes out of the `design_check` tool instead — no skill
 * registration, no file to find, and no path for the agent to resolve.
 *
 * Keys are stable identities, not locations: `SKILL.md` is the router (its own module, since the text is
 * hand-maintained), `reference/<name>.md` a playbook or a deeper reference. `guidanceKey` accepts what a
 * model is likely to pass — a playbook name, a key, a bare file name, or an absolute path left over from
 * the old skill tree.
 */
import { GUIDANCE, PLAYBOOKS } from "./corpus.ts";
import { ROUTER } from "./router.ts";

/**
 * The router: setup, the command table, and the rules that apply to every playbook. It is its own
 * module because it is prose this package maintains, not imported text.
 */
export const ROUTER_KEY = "SKILL.md";

/** Playbook name to one-line description, from the corpus's routing table. */
export const PLAYBOOK_NAMES: readonly string[] = Object.keys(PLAYBOOKS);

/** Every guidance key, for diagnostics and tests. */
export const GUIDANCE_KEYS: readonly string[] = [ROUTER_KEY, ...Object.keys(GUIDANCE)];

export type GuidanceKind = "playbook" | "reference";

/**
 * The guidance key a name refers to, or null when the corpus has nothing under it.
 *
 * A playbook name (`audit`) and its key (`reference/audit.md`) are the same body, so callers do not
 * have to know which spelling the request came from.
 */
export function guidanceKey(name: string): string | null {
	const raw = name.trim().replaceAll("\\", "/");
	if (raw === "") return null;

	// A path from the retired skill tree still names a real body: keep the part below `reference/`.
	const marker = raw.lastIndexOf("reference/");
	const trimmed = (marker === -1 ? raw : raw.slice(marker)).replace(/^\.?\//, "") || raw;

	const candidates = [
		trimmed,
		`reference/${trimmed}`,
		trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`,
		`reference/${trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`}`,
		`reference/degraded/${trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`}`,
	];
	// `router` says what `SKILL.md` used to: the entry every playbook assumes. Both names work.
	if (trimmed === "router" || trimmed === "router.md") return ROUTER_KEY;
	for (const candidate of candidates) if (candidate === ROUTER_KEY || candidate in GUIDANCE) return candidate;
	return null;
}

/** Whether a key is a playbook body, as opposed to the router or a deeper reference. */
export function guidanceKind(key: string): GuidanceKind {
	const bare = key.replace(/^reference\//, "").replace(/\.md$/, "");
	return GENUINE_PLAYBOOKS.has(bare) ? "playbook" : "reference";
}

/**
 * Playbooks with a body of their own. `extra` verbs (`doctor`) are commands that read a reference
 * rather than route to a playbook, so a key under `reference/` is not automatically a playbook.
 */
const GENUINE_PLAYBOOKS: ReadonlySet<string> = new Set(PLAYBOOK_NAMES);

/** One guidance body, or null when the name resolves to nothing. */
export function readGuidance(name: string): { key: string; text: string; kind: GuidanceKind } | null {
	const key = guidanceKey(name);
	if (!key) return null;
	if (key === ROUTER_KEY) return { key, text: ROUTER, kind: "reference" };
	const text = GUIDANCE[key];
	return text === undefined ? null : { key, text, kind: guidanceKind(key) };
}

/** The router, which every playbook assumes has been read. */
export function router(): string {
	return ROUTER;
}

/**
 * What `/designer <playbook>` delivers: the router, then the playbook body.
 *
 * One message instead of a path the model has to look up, and the same text the model would have
 * spent two reads on. Unknown playbooks return null, so the command can say so.
 */
export function routePlaybook(name: string): { key: string; text: string } | null {
	const found = readGuidance(name);
	if (!found || found.kind !== "playbook") return null;
	return { key: found.key, text: `${router()}\n\n---\n\n${found.text}` };
}
