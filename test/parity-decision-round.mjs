/**
 * Parity check: the decision round against the reference.
 *
 * The payload schema is the contract a caller builds against, and it is exactly comparable: the
 * reference prints it with `--schema`, so the port has to print the same bytes. The rest is behavior
 * with no oracle in the reference (its server and page are script-internal), so it is asserted against
 * what the code documents: the deck order, the media resolution, and the directives an answer emits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const port = await import("../extensions/designer/engine/lib/decision-round.ts");

let failures = 0;
let comparisons = 0;

function check(name, actual, expected) {
	comparisons++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`FAIL ${name}\n     got:  ${a}\n     want: ${e}`);
}

const referenceFile = path.resolve("reference/impeccable-js/scripts/serve-question.mjs");

// ─── the schema, byte for byte ──────────────────────────────────────
const referenceSchema = execFileSync("node", [referenceFile, "--schema"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
check("renderSchema is the reference's own output", port.renderSchema(), referenceSchema);

// ─── the schema's own shape ─────────────────────────────────────────
const example = port.SCHEMA_EXAMPLE;
check("the example is a round", Array.isArray(example.options) && example.options.length > 0, true);
check("the example carries every field a round can use", ["title", "question", "options", "reroll", "buildPath", "canon", "canonCard", "steer"].every((k) => k in example), true);
check("the example shows a declined card", example.options.some((o) => o.verdict === "declined"), true);
check("the example shows a competitive card", example.options.some((o) => o.verdict === "competitive"), true);
check("the example carries the pick kicker", example.options.some((o) => String(o.kicker || "").includes("PICK")), true);
check("notes describe the reserved ids", port.SCHEMA_NOTES.includes('"reroll" and "canon" are reserved'), true);

// ─── loading a round ────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-designer-round-"));
try {
	writeFile("hero.png");
	writeFile("board.png");
	// A comp slot may point at a file that does not exist yet: it registers anyway.
	const payload = {
		title: "Choose",
		options: [
			{ id: "assigned", label: "Assigned", kicker: "THE ROLL", hero: "hero.png", board: "board.png", comp: "future-comp.png" },
			{ id: "declined-1", label: "Declined", verdict: "declined", hero: "https://example.com/hero.webp" },
			{ id: "competitive-1", label: "Competitive", verdict: "competitive", sketch: "legacy-sketch.png" },
			{ id: "missing-hero", label: "No media", hero: "not-there.png" },
			{ id: "remote", label: "Remote", hero: "https://example.com/x.webp", board: "https://example.com/y.webp" },
		],
		canonCard: { label: "The category standard", thesis: "What this category ships.", comp: "canon.png" },
		buildPath: { value: "comp", toggle: true },
	};

	const model = port.loadRoundModel(JSON.stringify(payload), { cwd: dir });
	check("options load", model.options.length, 6);
	check("declined cards move to the end", model.options[model.options.length - 1].id, "declined-1");
	check("the canon card is inserted with its reserved id", model.options.some((o) => o.id === "canon" && o.isCanon === true), true);
	// Four contenders survive (assigned, competitive, missing-hero, remote), so the canon card follows them
	// and the declined card closes the deck.
	check("the canon card sits after the contenders", model.options.findIndex((o) => o.id === "canon"), 4);
	check("a local hero becomes a local reference", model.options[0].heroSrc, "/img/0");
	check("a remote hero passes through", model.options.find((o) => o.id === "remote").heroSrc, "https://example.com/x.webp");
	check("a missing hero resolves to null", model.options.find((o) => o.id === "missing-hero").heroSrc, null);
	check("a comp that does not exist yet still registers", model.options[0].compSrc, "/img/2");
	check("the legacy sketch key is an alias", model.options.find((o) => o.id === "competitive-1").compSrc, "/img/3");
	check("local files are collected in order", model.localImages.map((f) => path.basename(f)), ["hero.png", "board.png", "future-comp.png", "legacy-sketch.png", "canon.png"]);
	check("the build path is read", model.buildPath, { value: "comp", toggle: true });

	// A payload with no options is refused.
	check("an empty round is refused", (() => {
		try {
			port.loadRoundModel(JSON.stringify({ options: [] }), { cwd: dir });
			return "loaded";
		} catch (error) {
			return String(error.message);
		}
	})(), "payload needs an options array");

	check("a round with no buildPath reads null", port.loadRoundModel(JSON.stringify({ options: [{ id: "a" }] }), { cwd: dir }).buildPath, null);
	check("an unknown buildPath value reads null", port.loadRoundModel(JSON.stringify({ options: [{ id: "a" }], buildPath: { value: "hybrid" } }), { cwd: dir }).buildPath, null);

	function writeFile(name) {
		fs.writeFileSync(path.join(dir, name), "x");
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ─── the answer directives ──────────────────────────────────────────
const answerCases = {
	plain: { optionId: "assigned", label: "Assigned" },
	withMedia: { optionId: "assigned", hero: "hero.png", board: "board.png" },
	withComp: { optionId: "assigned", comp: ".impeccable/mocks/decision/one.webp" },
	canon: { optionId: "canon" },
	rerollSafer: { optionId: "reroll", register: "safer" },
	rerollNoRegister: { optionId: "reroll" },
	followup: { optionId: "assigned", followup: true },
	followupReroll: { optionId: "reroll", register: "bolder", followup: true },
	compPath: { optionId: "assigned", buildPath: "comp" },
	codePath: { optionId: "assigned", buildPath: "code" },
	compFlipped: { optionId: "assigned", buildPath: "comp", buildPathFlipped: true },
};

for (const [name, answer] of Object.entries(answerCases)) {
	const lines = port.renderAnswer(JSON.stringify(answer));
	check(`renderAnswer(${name}) starts with the ANSWER line`, lines[0].startsWith("ANSWER: "), true);
	check(`renderAnswer(${name}) is JSON round-trippable`, lines[0], `ANSWER: ${JSON.stringify(answer)}`);
}

const has = (name, needle) => port.renderAnswer(JSON.stringify(answerCases[name])).some((line) => line.includes(needle));
check("media directive", has("withMedia", "CHOSEN CARD:"), true);
check("comp directive", has("withComp", "CHOSEN COMP:"), true);
check("canon directive", has("canon", "CANON CHOSEN:"), true);
check("register directive", has("rerollSafer", "REGISTER: the user steered the next hand to the safer register"), true);
check("register directive names the flag", has("rerollSafer", "--register safer"), true);
check("no register directive without a register", has("rerollNoRegister", "REGISTER:"), false);
check("followup directive", has("followup", "FOLLOWUP OPEN:"), true);
check("no followup directive on a re-roll", has("followupReroll", "FOLLOWUP OPEN:"), false);
check("comp build path directive", has("compPath", "BUILD PATH: comp (the round's recorded default)"), true);
check("code build path directive", has("codePath", "Code-led: no comp is owed"), true);
check("a flipped build path says so", has("compFlipped", "flipped on the page"), true);
check("the plain answer carries only its ANSWER line", port.renderAnswer(JSON.stringify(answerCases.plain)).length, 1);
check("a non-JSON answer still prints its line", port.renderAnswer("not json"), ["ANSWER: not json"]);

// ─── the loopback guards ────────────────────────────────────────────
for (const [host, portNumber] of [
	["127.0.0.1:4000", 4000],
	["localhost:4000", 4000],
	["127.0.0.1:4001", 4000],
	["evil.example:4000", 4000],
	["127.0.0.1", 80],
	["localhost", 80],
	["127.0.0.1:80", 80],
	[undefined, 4000],
]) {
	check(`allowedHost(${JSON.stringify(host)}, ${portNumber})`, port.allowedHost(host, portNumber), (host === `127.0.0.1:${portNumber}` || host === `localhost:${portNumber}`) || (portNumber === 80 && (host === "127.0.0.1" || host === "localhost")));
}

for (const [origin, portNumber] of [
	["http://127.0.0.1:4000", 4000],
	["http://localhost:4000", 4000],
	["http://evil.example", 4000],
	["http://127.0.0.1:4001", 4000],
	["http://127.0.0.1", 80],
	[undefined, 4000],
]) {
	check(`allowedOrigin(${JSON.stringify(origin)}, ${portNumber})`, port.allowedOrigin(origin, portNumber), (origin === `http://127.0.0.1:${portNumber}` || origin === `http://localhost:${portNumber}`) || (portNumber === 80 && (origin === "http://127.0.0.1" || origin === "http://localhost")));
}

if (failures > 0) {
	console.log(`\n${failures} of ${comparisons} decision-round comparisons failed`);
	process.exit(1);
}
console.log(`decision-round parity: ${comparisons} comparisons match the reference`);
