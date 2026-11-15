/**
 * The decision round: the payload contract, the card ordering, the answer directives, and the
 * loopback guards. Ported from Impeccable's engine (github.com/pbakaus/impeccable, Apache-2.0; see
 * NOTICE).
 *
 * What is deliberately absent: the HTTP server and the rendered page (1,100 lines of HTML). pi asks
 * its questions through its own prompt, so a second browser surface would be a competing one. What
 * stays is the part a caller needs: the payload schema as the contract, the ordering that makes a
 * deck read as a gradient of standing rather than payload order, and the directives an answer
 * produces.
 */
import path from "node:path";
import fs from "node:fs";

/** One card in a round, as the payload declares it and the reader resolves it. */
interface RoundOption {
	readonly id?: string;
	readonly label?: string;
	readonly kicker?: string;
	readonly lineage?: string;
	readonly thesis?: string;
	readonly palette?: readonly string[];
	readonly materials?: readonly string[];
	readonly viewport?: string;
	readonly risk?: string;
	readonly case?: string;
	readonly kept?: string;
	readonly raised?: readonly string[];
	readonly verdict?: "wins" | "competitive" | "declined" | string;
	readonly hero?: string;
	readonly board?: string;
	readonly comp?: string;
	readonly sketch?: string;
	readonly wireframe?: { readonly cols?: number; readonly rows?: number; readonly regions?: readonly Record<string, unknown>[] };
	readonly isCanon?: boolean;
}

/** A whole round payload. */
interface RoundPayload {
	readonly title?: string;
	readonly question?: string;
	readonly options: readonly RoundOption[];
	readonly canon?: boolean;
	readonly canonCard?: RoundOption;
	readonly reroll?: boolean | { readonly registers?: readonly string[] };
	readonly steer?: boolean;
	readonly followup?: boolean;
	readonly buildPath?: { readonly value?: string; readonly toggle?: boolean };
}

/** A card with its media resolved: a URL passes through, a path becomes a local reference. */
interface DecoratedOption extends RoundOption {
	readonly heroSrc: string | null;
	readonly boardSrc: string | null;
	readonly compSrc: string | null;
}

/** A loaded round: the deck in the order it renders, and the recorded build path. */
interface RoundModel {
	readonly payload: RoundPayload;
	readonly options: DecoratedOption[];
	/** The local files the round refers to, in the order they were registered. */
	readonly localImages: string[];
	readonly buildPath: { readonly value: string; readonly toggle: boolean } | null;
}

/**
 * Load a round.
 *
 * Comps stream in after the page is served, so a comp slot registers whether or not the file exists
 * yet; hero and board slots only register a file that is there. The verdict routes rendering: full
 * cards first, then the canon card, then the declined ones dead last in their own payload order, so a
 * payload that interleaves them still renders the weighing's shape.
 */
function loadRoundModel(json: string, { cwd = process.cwd() }: { readonly cwd?: string } = {}): RoundModel {
	const parsed = JSON.parse(json) as RoundPayload;
	if (!parsed || !Array.isArray(parsed.options) || parsed.options.length === 0) {
		throw new Error("payload needs an options array");
	}

	const localImages: string[] = [];

	const imageSrc = (value: string | undefined): string | null => {
		if (!value) return null;
		if (/^https?:\/\//.test(value)) return value;
		const abs = path.resolve(cwd, value);
		if (!fs.existsSync(abs)) return null;
		localImages.push(abs);
		return `/img/${localImages.length - 1}`;
	};

	const compSrc = (value: string | undefined): string | null => {
		if (!value) return null;
		if (/^https?:\/\//.test(value)) return value;
		localImages.push(path.resolve(cwd, value));
		return `/img/${localImages.length - 1}`;
	};

	const decorate = (option: RoundOption): DecoratedOption => ({
		...option,
		heroSrc: imageSrc(option.hero),
		boardSrc: imageSrc(option.board),
		compSrc: compSrc(option.comp ?? option.sketch),
	});

	let options = parsed.options.map(decorate);
	// The deck reads as a gradient of standing: contenders, the familiar door, then the demoted row.
	const declined = options.filter((o) => o.verdict === "declined");
	options = options.filter((o) => o.verdict !== "declined");
	// The standing exit as a full card: same anatomy, reserved id, rendered subordinate by the page.
	if (parsed.canonCard && typeof parsed.canonCard === "object") {
		options = [...options, { ...decorate(parsed.canonCard), id: "canon", isCanon: true }];
	}
	options = [...options, ...declined];

	const buildPath =
		parsed.buildPath && (parsed.buildPath.value === "comp" || parsed.buildPath.value === "code")
			? { value: parsed.buildPath.value, toggle: parsed.buildPath.toggle === true }
			: null;

	return { payload: parsed, options, localImages, buildPath };
}

/**
 * The lines an answer produces: the ANSWER line itself, then whatever the chosen card implies.
 *
 * The card viewing happens at the moment of choice, in the working turn, because a build that never
 * reopens the chosen world's board and hero calibrates on nothing.
 */
function renderAnswer(raw: string): string[] {
	const lines = [`ANSWER: ${raw}`];
	let answer: Record<string, unknown>;
	try {
		answer = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return lines;
	}

	if (answer.hero || answer.board) {
		lines.push(
			"CHOSEN CARD: open the chosen world's board and hero images now, before any code. When your harness only reads files, or runs sandboxed, download them INTO the workspace and open the relative path; a sandboxed viewer rejects absolute paths outside it. They set the craft bar the build must reach.",
		);
	}
	if (answer.comp) {
		lines.push(
			"CHOSEN COMP: the decision comp at that path is compositional option one. On a comp-led build the comp round adds two variations beside it; on a code-led build it returns at the finish review as the critique reference. Never regenerate it from scratch.",
		);
	}
	if (answer.optionId === "canon") {
		lines.push(
			"CANON CHOSEN: the user picked the category standard on purpose. Ask once for two or three products this should sit alongside; their craft level becomes the quality bar. Execute the canon at full commitment, conventions embraced without irony or smuggled quirk.",
		);
	}
	if (answer.optionId === "reroll" && answer.register) {
		lines.push(
			`REGISTER: the user steered the next hand to the ${String(answer.register)} register. Re-run concept-seed with the same key, the next --reroll round, and --register ${String(answer.register)}, then follow what it prints; the register is the user's steering, never yours to pre-select.`,
		);
	}
	if (answer.followup && answer.optionId !== "reroll") {
		lines.push(
			"FOLLOWUP OPEN: the table stays open and the page is showing a loading hand. Deliver the next round now with --update --key <key> --payload <file>, then collect it with --wait; never leave the page waiting on a round you have not sent.",
		);
	}
	if (answer.buildPath === "comp" || answer.buildPath === "code") {
		// The page never writes the flip itself, but that is narrower than it sounds: a flip on a project
		// with no recorded default is the one moment the preference is ever asked for.
		const origin = answer.buildPathFlipped
			? "flipped on the page, so it binds this session only, and the page never writes it back; the sole exception is new-work's one-time offer, on a project that had no recorded default at all, which asks after the round closes and writes the answer to .impeccable/config.json"
			: "the round's recorded default";
		lines.push(
			`BUILD PATH: ${String(answer.buildPath)} (${origin}). ${
				answer.buildPath === "comp"
					? "Comp-led: the chosen card's comp is law; generate it before building when it does not exist yet, and the finish review audits the build against it."
					: "Code-led: no comp is owed; a comp that already rendered rides at the finish review as the critique reference, and the ambition lives in the direction contract."
			}`,
		);
	}

	return lines;
}

/** Loopback only: the request's Host must be the port this server is on. */
function allowedHost(host: string | undefined, port: number): boolean {
	if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
	return port === 80 && (host === "127.0.0.1" || host === "localhost");
}

/** Loopback only: a cross-origin POST is refused. */
function allowedOrigin(origin: string | undefined, port: number): boolean {
	if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
	return port === 80 && (origin === "http://127.0.0.1" || origin === "http://localhost");
}

/** The canonical payload a caller builds against. */
const SCHEMA_EXAMPLE = {
    title: 'Choose the visual world',
    question: 'The roll assigned Fillmore Handbill. Keep it, take an alternate, or re-roll.',
    options: [
      { id: 'assigned', label: 'Fillmore Handbill', kicker: 'THE ROLL', lineage: '1966-71 Fillmore psychedelic handbills', thesis: 'The gig poster that treats every release like a one-night stand.', palette: ['#e8452c', '#f5d64c', '#1b2a52', '#f3ead8'], materials: ['letterpress', 'split-fountain ink'], viewport: 'A full-bleed dated bill with the product name in warped display type.', risk: 'Reads nostalgic when the type is set timidly.', raised: [{ from: 'challenger-microfiche', raise: 'The bill now owns its whole viewport as one continuous printed sheet.' }], comp: '.impeccable/mocks/decision/assigned.webp', hero: 'https://impeccable.style/worlds/cards/posters-covers-sleeves-fillmore-handbill-hero.webp', board: 'https://impeccable.style/worlds/cards/posters-covers-sleeves-fillmore-handbill.webp' },
      { id: 'model-pick', label: 'The Broadside Ballad', kicker: 'IMPECCABLE’S PICK', lineage: 'street-sold ballad sheets', thesis: 'Every release printed as the day’s ballad sheet.', palette: ['#1f1c18', '#efe5d0', '#a33327'], materials: ['woodcut', 'rag paper'], viewport: 'One tall sheet, the newest release as today’s ballad.', risk: 'Also the direction most runs in this category land on.', comp: '.impeccable/mocks/decision/model-pick.webp' },
      { id: 'challenger-teletext', label: 'Teletext Service', verdict: 'competitive', lineage: 'broadcast teletext magazines', thesis: 'The catalog as a broadcast index: pages, not sections.', palette: ['#0000c0', '#ffff00', '#00c000', '#ffffff'], materials: ['block mosaic', 'phosphor glow'], viewport: 'P100 index page, releases as numbered rows.', case: 'Fuses cleanly: releases map to numbered pages; loses narrowly on clarity.', risk: 'Reads retro-novelty when the grid is not strict.', comp: '.impeccable/mocks/decision/challenger-teletext.webp', hero: 'https://impeccable.style/worlds/cards/broadcast-programming-teletext-service-hero.webp' },
      { id: 'challenger-microfiche', label: 'Microfiche Reader', verdict: 'declined', lineage: 'library microfiche stations', palette: ['#101418', '#9fb4c0'], materials: ['film grain', 'backlit glass'], case: 'Fuses poorly: listeners do not identify with archival retrieval.', kept: 'Total environmental commitment.', hero: 'https://impeccable.style/worlds/cards/archives-microfiche-reader-hero.webp' },
    ],
    reroll: { registers: ['safer', 'bolder'] },
    buildPath: { value: 'comp', toggle: true },
    canon: true,
    canonCard: { label: 'The category standard', thesis: 'What this category ships, executed impeccably.', palette: ['#ffffff', '#111827', '#2563eb'], materials: ['clean grid', 'product photography'], viewport: 'The arrangement a visitor expects, at full craft.', risk: 'Indistinguishable from the competition by design.', comp: '.impeccable/mocks/decision/canon.webp' },
    steer: true,
  };

/** What the payload's fields mean, and the conventions a card deck follows. */
const SCHEMA_NOTES = "Option ids return verbatim in ANSWER; \"reroll\" and \"canon\" are reserved. hero/board/comp accept URLs or local paths; comp slots may point at files that do not exist yet (serve first, generate after; the page polls until they land, so never block serving on generation). hero on a challenger is the inspiration it draws from and renders picture-in-picture beside the comp, never as the promise of the build. verdict routes rendering: \"wins\" and \"competitive\" challengers keep full cards, \"declined\" ones render demoted after them (narrow, quiet, art as a labeled thumb, \"Adopt anyway\"), with their kept line on the front; the page reorders declined cards to the end on its own. raised on the assigned card renders each donation as a named raise line. Salience parity: when the assigned card declares no comp (no image generation this round), catalog art on every card demotes to a labeled thumb, so what looks important is the verdict’s call, never rendering luck. canonCard renders the standing exit as a subordinate card with the same anatomy; without it, canon stays a quiet footer action. Include canon only for visual-direction rounds; never present it as your own recommendation. The pick card is a kicker convention, not a field: kicker \"IMPECCABLE’S PICK\" on your top-ranked grounded candidate, one at most, never in the lead slot. Every card gets the full anatomy, challengers, canon, and declined included: thesis, palette, materials, viewport, risk; the seed already hands you each challenger’s system rules, so a card with no palette chips is an authoring gap, not a data gap. Keep thesis and each fact to one short sentence: the card front shows thesis, identity, and a two-line risk, while first viewport and the case read on the card back behind the Details chip, so long facts cost the reader a flip, not the page its scanability. A card with no imagery at all has no back; its full read renders on the front, so a text-only round loses nothing. A card may instead declare \"wireframe\" ({\"cols\":12,\"rows\":10,\"regions\":[{\"label\":\"nav rail\",\"x\":0,\"y\":0,\"w\":3,\"h\":10,\"accent\":true}]}): the page draws it as a layout schematic in the media slot; surface-scope rounds use it on code-led builds, it never counts toward salience, and the card keeps its full read on the front. The comp slot carries the card’s full-fidelity direction comp (the legacy key \"sketch\" is accepted as an alias). Comp aspect follows the surface: portrait at device viewport for native or mobile-first surfaces, landscape otherwise; the page adapts its cards to either. reroll accepts true or { \"registers\": [\"safer\", \"bolder\"] }: the register buttons steer the next hand along the familiar-to-bold axis, the answer carries \"register\", and you re-run concept-seed with --register <value> for the next round; offer the registers on direction rounds, and never pre-select one. buildPath rides the payload as { \"value\": \"comp\"|\"code\", \"toggle\": true }: the value is the recorded default (.impeccable/config.json buildPath, or .impeccable/config.local.json where one machine differs) and the toggle renders a footer switch whose flip binds that session only; the ANSWER then carries buildPath plus buildPathFlipped. On a code-led round each card still declares its comp path as a flip reserve: wireframes render, and a flip to comp makes --wait return once with BUILD PATH FLIPPED so you generate the comps into the declared slots while the round stays open; a flip back to code is free, and a comp that already landed stays as the critique reference. The toggle may only be offered when image generation exists: a harness with no image tool and no API key never sets toggle: true, so the choice never renders where comps cannot be made, and code-led simply rides as the untoggleable value. followup: true keeps the table open after a pick for a second round via --update; send the next payload immediately, the page is waiting on it.";

/** The whole `--schema` response: the example, then the notes. */
function renderSchema(): string {
	return `${JSON.stringify(SCHEMA_EXAMPLE, null, 2)}\n\n${SCHEMA_NOTES}\n`;
}

export { allowedHost, allowedOrigin, loadRoundModel, renderAnswer, renderSchema, SCHEMA_EXAMPLE, SCHEMA_NOTES };
export type { DecoratedOption, RoundModel, RoundOption, RoundPayload };
