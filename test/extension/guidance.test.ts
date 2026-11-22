/**
 * The guidance corpus: what the engine carries now that the skill tree is gone.
 *
 * The invariant these tests protect is the one a file tree used to give for free: every cross-reference
 * inside the guidance resolves. A dead `reference/…` key is the equivalent of a broken link, except
 * nothing on disk points it out, so it is checked here.
 */

import { checkOk } from "../helpers/check.ts";
import { GUIDANCE } from "../../extensions/designer/guidance/corpus.ts";
import {
	GUIDANCE_KEYS,
	PLAYBOOK_NAMES,
	ROUTER_KEY,
	guidanceKey,
	readGuidance,
	routePlaybook,
} from "../../extensions/designer/guidance/index.ts";

// --- every playbook has a body -------------------------------------------------

const missing = PLAYBOOK_NAMES.filter((name) => guidanceKey(name) === null);
checkOk(`corpus: every playbook resolves to a body (${PLAYBOOK_NAMES.length} playbooks)`, missing.length === 0, missing.join(", "));

const routed = PLAYBOOK_NAMES.filter((name) => routePlaybook(name) === null);
checkOk("corpus: every playbook routes", routed.length === 0, routed.join(", "));

// --- key resolution accepts what a model is likely to pass --------------------

for (const name of ["audit", "reference/audit.md", "./reference/audit.md", "/old/checkout/extensions/designer/skill/reference/audit.md"]) {
	checkOk(`keys: resolves ${name}`, guidanceKey(name) === "reference/audit.md", String(guidanceKey(name)));
}
checkOk("keys: bare file name resolves", guidanceKey("new-work") === "reference/new-work.md", String(guidanceKey("new-work")));
checkOk(
	"keys: degraded subagent prompt resolves",
	guidanceKey("degraded/finish-reviewer.md") === "reference/degraded/finish-reviewer.md",
	String(guidanceKey("degraded/finish-reviewer.md")),
);
checkOk("keys: the router resolves", guidanceKey("SKILL.md") === ROUTER_KEY, String(guidanceKey("SKILL.md")));
checkOk("keys: the router answers to its plain name", guidanceKey("router") === ROUTER_KEY, String(guidanceKey("router")));
checkOk("keys: an unknown name resolves to nothing", guidanceKey("nonsense") === null, String(guidanceKey("nonsense")));
checkOk("keys: an empty name resolves to nothing", guidanceKey("   ") === null, String(guidanceKey("   ")));

// --- every cross-reference inside the guidance resolves -----------------------

/**
 * The `reference/…` keys a body points at.
 *
 * Markdown links count too, because a link left in the text is a dead file path. Absolute URLs and
 * `<placeholder>` forms are not keys.
 */
function keysIn(text: string): string[] {
	const isKey = (candidate: string) => !candidate.includes("<") && !/^[a-z][a-z0-9+.-]*:/i.test(candidate);
	const mentioned = [...text.matchAll(/`(reference\/[^`\s]+\.md)`/g)].map((match) => match[1] as string);
	const linked = [...text.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1] as string);
	return [...mentioned, ...linked].filter(isKey);
}

const known = new Set(GUIDANCE_KEYS);
const dead: string[] = [];
for (const [key, body] of Object.entries(GUIDANCE)) {
	for (const referenced of keysIn(body)) {
		if (!known.has(referenced)) dead.push(`${key} -> ${referenced}`);
	}
}
checkOk(`corpus: ${dead.length === 0 ? "every" : "not every"} cross-reference resolves`, dead.length === 0, dead.slice(0, 8).join("\n"));

// --- the router is served, and clicking a key is a tool call ------------------

const router = readGuidance(ROUTER_KEY);
checkOk("router: served under its own key", !!router && router.text.includes("Core principles"), router?.key);
checkOk("router: explains the key convention", !!router?.text.includes("is a key, not a path"), router?.text.slice(0, 200));
checkOk("router: names the tool that reads guidance", !!router?.text.includes("design_check"), "");

// --- nothing points at the deleted tree --------------------------------------

const staleTree = Object.entries(GUIDANCE).filter(([, body]) => /]\(reference\//.test(body));
checkOk("corpus: no markdown links into the retired tree", staleTree.length === 0, staleTree.map(([key]) => key).join(", "));

// --- the data-encoding playbook and the audit report shapes ------------------

const routerText = readGuidance(ROUTER_KEY)!.text;
checkOk("router: names encode in the command table", routerText.includes("encode [target]"), "");
checkOk("router: routes unnamed data-encoding questions", routerText.includes("Data-encoding question"), "");

const encode = readGuidance("encode");
checkOk("encode: served as a playbook", encode?.kind === "playbook", encode?.key);
checkOk("encode: covers chart vs table", !!encode?.text.includes("Chart or table"), encode?.text.slice(0, 160));
checkOk("encode: says bars start at zero", !!encode?.text.includes("Bars and columns start at zero"), "");
checkOk("encode: explains minPointSize", !!encode?.text.includes("minPointSize"), "");

const audit = readGuidance("audit");
checkOk("audit: defines a brief report", !!audit?.text.includes("`--brief`"), audit?.text.slice(0, 300));
checkOk(
	"audit: hands the command to the user instead of running it",
	!!audit?.text.includes("you cannot invoke it") && !audit.text.includes("You can ask me to run these"),
	audit?.text.slice(-600),
);

const auditNative = readGuidance("audit.native");
checkOk("audit native: mirrors the brief report", !!auditNative?.text.includes("`--brief`"), auditNative?.text.slice(0, 300));
checkOk(
	"audit native: hands the command to the user instead of running it",
	!!auditNative?.text.includes("you cannot invoke it") && !auditNative.text.includes("You can ask me to run these"),
	auditNative?.text.slice(-600),
);

for (const [name, body] of [
	["audit", audit],
	["audit native", auditNative],
] as const) {
	const text = body?.text ?? "";
	checkOk(
		`${name}: a11y and responsive are opt-in`,
		text.includes("opt-in") && text.includes("`--a11y`") && text.includes("`--responsive`") && text.includes("`--all`"),
		text.slice(0, 400),
	);
	checkOk(`${name}: the default total is out of 12`, text.includes("**??/12**"), text.slice(0, 200));
}
