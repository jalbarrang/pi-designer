/**
 * The direction seed: what a round deals, how the assignment breaks the model's ranking rut, and the
 * text that hands it over. Ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two things matter here and neither is the drawing itself. First, the assignment exists so the
 * model's top-ranked candidate is not what every run ships: the dice decide which grounded direction
 * gets built, and the model may add at most one card of its own. Second, the mechanism has to be
 * legible: every block says what to do, in the order to do it, with the assignment restated at the
 * end for a reader whose context was truncated.
 *
 * Resolving the catalog and the roll service are host concerns. A caller passes `_resolvedData` — a
 * local catalog, a roll response, or null for a degraded round — so this module reads no project
 * files and opens no sockets, and a prepared session renders synchronously.
 */
import crypto from "node:crypto";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { approvedPoolRevision } from "./concept-catalog.ts";
import {
	COMPOSITION_GRAINS,
	COMPOSITION_PLATFORMS,
	runSyncSelection,
	selectApprovedChallengers as selectApprovedChallengersCore,
	selectApprovedCompositions as selectApprovedCompositionsCore,
} from "./roll-selection.ts";
import type { CompositionInput } from "./roll-selection.ts";

/** One catalog challenger, as the renderer reads it. */
interface SeedChallenger {
	readonly id: string;
	readonly form: string;
	readonly spark: string;
	readonly webLeverage: string;
	readonly system: readonly string[];
	readonly cardBoard?: string;
	readonly cardHero?: string;
}

/** One catalog composition, as the renderer reads it. */
interface SeedComposition {
	readonly id: string;
	readonly form: string;
	readonly spark: string;
	readonly webLeverage: string;
	readonly grammar: readonly string[];
}

/** A deal as a host resolves it: a local catalog, a roll response, or null when degraded. */
interface ResolvedRoll {
	readonly source: string;
	readonly poolRevision?: string | null;
	readonly approvedCount?: number | null;
	readonly catalogCount?: number | null;
	readonly challengers: readonly SeedChallenger[];
	readonly compositions?: readonly SeedComposition[];
	/** What the roll service emitted while these were called stagings. */
	readonly stagings?: readonly SeedComposition[];
	/** The single-pick shape from before the service dealt three. */
	readonly staging?: SeedComposition;
	readonly compositionMatch?: {
		readonly grain?: string | null;
		readonly atGrain?: number | null;
		readonly grainAvailable?: number | null;
	} | null;
}

const CARD_BASE = "https://impeccable.style/worlds/cards";

function renderChallenger(concept: SeedChallenger, index: number): string {
  const system = concept.system.map(rule => `       - ${rule}`).join('\n');
  const board = concept.cardBoard || `${CARD_BASE}/${concept.id}.webp`;
  const hero = concept.cardHero || `${CARD_BASE}/${concept.id}-hero.webp`;
  return `  ${index + 1}. ${concept.form}
     SOURCE ID: ${concept.id}
     CREATIVE SPARK: ${concept.spark}
     SYSTEM GRAMMAR:
${system}
     WEB LEVERAGE: ${concept.webLeverage}
     QUALITY BAR: board ${board} · hero ${hero}`;
}

function renderComposition(composition: SeedComposition, index: number | null = null): string {
  const grammar = composition.grammar.map(rule => `       - ${rule}`).join('\n');
  return `  ${index == null ? '' : `${index + 1}. `}${composition.form}
     SOURCE ID: ${composition.id}
     SPARK: ${composition.spark}
     COMPOSITION GRAMMAR:
${grammar}
     WEB LEVERAGE: ${composition.webLeverage}`;
}

// Selection itself lives in lib/roll-selection.mjs so this script and the roll
// API run one algorithm rather than two that drifted. These wrappers add only
// what is local to the skill: resolving the catalog when no pool is passed, and
// driving the generator with Node's synchronous hash, which keeps a local render
// synchronous for prepared eval sessions and tests.
function driveSelection<T>(generator: Generator<string[], T, string[]>): T {
  return runSyncSelection(generator, (input) => crypto.createHash("sha256").update(input).digest("hex"));
}

/** A pool the caller supplies; the catalog itself is resolved by the host. */
interface DealOptions {
  readonly scope: "direction" | "surface";
  readonly key: string;
  readonly reroll?: number;
  readonly mode?: string | null;
  readonly grain?: string | null;
  readonly platform?: string | null;
  readonly sourceCompositions?: readonly CompositionInput[];
  readonly count?: number;
}

function dealCompositions({ scope, key, reroll = 0, mode = null, grain = null, platform = null, sourceCompositions = [], count = 3 }: DealOptions) {
  return driveSelection(selectApprovedCompositionsCore({ scope, key, reroll, mode, grain, platform, compositions: sourceCompositions, count }));
}

/** Array-returning form, which is what every caller wanted before the match report existed. */
function selectApprovedCompositions(options: DealOptions): CompositionInput[] {
  return dealCompositions(options).picks;
}

/** A single sample, for a smoke test. */
function selectApprovedComposition(options: DealOptions): CompositionInput | null {
  return selectApprovedCompositions({ ...options, count: 1 })[0] ?? null;
}

interface ChallengerOptions {
  readonly scope: "direction" | "surface";
  readonly key: string;
  readonly reroll?: number;
  readonly mode?: string | null;
  readonly sourceConcepts?: Parameters<typeof selectApprovedChallengersCore>[0]["concepts"];
}

function selectApprovedChallengers({ scope, key, reroll = 0, mode = null, sourceConcepts = [] }: ChallengerOptions) {
  const source = sourceConcepts;
  const { approved, picks } = driveSelection(selectApprovedChallengersCore({ scope, key, reroll, mode, concepts: source }));
  return { approved, picks, poolRevision: approvedPoolRevision(source as never), catalogCount: source.length };
}

const SEED_MODES: ReadonlySet<string> = new Set(["persuade", "operate", "read", "experience"]);

/** Everything a round needs. A caller passes the resolved data; nothing here reads a file. */
interface SeedOptions {
  readonly scope?: "direction" | "surface";
  readonly key?: string;
  readonly reroll?: number;
  readonly register?: "safer" | "bolder" | null;
  readonly mode?: string | null;
  readonly grain?: string | null;
  readonly platform?: string | null;
  readonly candidateCount?: number;
  readonly _resolvedData?: ResolvedRoll | null;
}

function renderConceptSeed({
  scope = 'surface',
  key = process.env.IMPECCABLE_CONCEPT_SEED || crypto.randomBytes(4).toString('hex'),
  reroll = 0,
  register = null,
  mode = null,
  grain = null,
  platform = null,
  candidateCount = 7,
  _resolvedData = undefined,
}: SeedOptions = {}) {
  if (scope !== 'surface' && scope !== 'direction') {
    throw new Error('concept-seed: --scope must be direction or surface');
  }
  if (!Number.isInteger(reroll) || reroll < 0) {
    throw new Error('concept-seed: --reroll must be a non-negative integer');
  }
  if (register !== null && register !== 'safer' && register !== 'bolder') {
    throw new Error('concept-seed: --register must be safer or bolder');
  }
  if (register !== null && reroll < 1) {
    throw new Error('concept-seed: --register steers a re-roll round; pass --reroll <n> with it');
  }
  if (register !== null && scope !== 'direction') {
    throw new Error('concept-seed: --register applies to direction rounds only');
  }
  if (mode !== null && !SEED_MODES.has(mode)) {
    throw new Error('concept-seed: --mode must be persuade, operate, read, or experience');
  }
  // Grain needs no mode: how much of the product is in play is independent of
  // which register of work it is.
  if (grain !== null && !COMPOSITION_GRAINS.includes(grain)) {
    throw new Error(`concept-seed: --grain must be one of ${COMPOSITION_GRAINS.join(', ')}`);
  }
  if (platform !== null && !COMPOSITION_PLATFORMS.includes(platform)) {
    throw new Error(`concept-seed: --platform must be one of ${COMPOSITION_PLATFORMS.join(', ')}`);
  }
  if (!Number.isInteger(candidateCount) || candidateCount < 5 || candidateCount > 7) {
    throw new Error('concept-seed: --candidate-count must be an integer from 5 to 7');
  }
  const unit = (salt: string) => {
    const h = crypto.createHash('sha256').update(`${scope}:${salt}:${key}`).digest();
    return h.readUInt32BE(0) / 0xffffffff;
  };
  const indexSalt = reroll === 0 ? 'index' : `index:reroll-${reroll}`;
  const buildIndex = 3 + Math.floor(unit(indexSalt) * (candidateCount - 2)); // 3..candidateCount
  // Surface scope deals a hand of three grounded structures: one card is not
  // a choice, and the full ranked list would hand selection back to the
  // model's taste. The dice pick all three; the primary index leads. The
  // no-lineup rule stays direction-only, where it was written for worlds.
  const dealtIndices = [buildIndex];
  for (let draw = 0; scope === 'surface' && dealtIndices.length < Math.min(3, candidateCount); draw += 1) {
    const idx = 1 + Math.floor(unit(`${indexSalt}:deal-${draw}`) * candidateCount);
    if (!dealtIndices.includes(idx)) dealtIndices.push(idx);
    if (draw > 64) { // hash repeats cannot stall the deal
      for (let fill = 1; dealtIndices.length < Math.min(3, candidateCount); fill += 1) {
        if (!dealtIndices.includes(fill)) dealtIndices.push(fill);
      }
    }
  }

  // Local catalog first (private repo, evals, tests), then the roll API,
  // then a degraded assignment-only seed. The assigned index is pure local
  // math, so even a fully offline run keeps the anti-argmax mechanism.
  let data = _resolvedData ?? null;
  // Resolving the catalog and the roll service is a host concern: a caller passes `_resolvedData`
  // (a local catalog, a roll response, or null for a degraded round) instead of this module reading
  // files or opening a socket.

  const promotedInstruction = scope === 'direction'
    ? `After ordering the grounded directions by resonance, build candidate
  ${buildIndex} of your own grounded list; the assignment never points at a
  challenger. The assignment is the roll, not a suggestion: your top-ranked
  direction is what every run would ship, so the script decides which grounded
  direction gets built. Each direction joins a durable visual system to a
  concrete expression for the requested first surface, decided as one. It must
  survive the current task plus navigation, quiet and dense content,
  interaction and state, and a substantially different future surface. In an
  attended run, present the assigned direction fully committed and offer
  re-roll. You may add ONE card for your top-ranked grounded candidate when
  it is not the assigned direction, kicker IMPECCABLE’S PICK, with an honest risk line
  naming its familiarity; one pick card, never a ranked lineup, and the pick
  never takes the lead position. When the assignment IS your top candidate,
  there is no pick card. Re-roll yourself only
  on named factual grounds, when the assignment cannot carry the product's
  truth or task; taste is never grounds.`
  : `After ordering the task's grounded structural candidates by resonance,
  deal candidates ${dealtIndices.join(', ')} of your own grounded list to the
  table; index ${buildIndex} leads, and the deal never points at a challenger.
  The deal is the roll, not a suggestion: the dice decide which structures
  reach the user, so the ranking rut stays broken while the user still gets a
  real choice, and the full ranked list stays yours. In an attended run,
  present the three dealt structures as full cards of equal salience, the
  lead carrying kicker THE ROLL, with steer and re-roll, and let the user
  lock one in; the world is already settled, so this choice is composition.
  Visualize every dealt card: with image generation available and a
  comp-led default (.impeccable/config.json buildPath; the page toggle
  handles the exception), declare a comp per card and generate after
  serving, lead first; otherwise author each card's wireframe field (see
  serve-question --schema) and the page draws the schematic. Carry the
  recorded default in the payload as buildPath with toggle: true. Locking a card
  approves its comp: a surface round that put three visualized structures on
  the table replaces the three-option comp round in visualize.md. Re-roll
  yourself only when every dealt structure fails audience identification or
  product clarity on named factual grounds.`;

  const challengerInstruction = scope === 'direction'
    ? `Fuse each challenger before judging it: the challenger supplies the form
  and its system grammar, the product supplies every fact, and clarity wins
  conflicts. Weigh the fused result against the assigned direction on exactly
  two axes, audience identification and product clarity. Losing to strong
  grounded material is a valid outcome; beating a thin or tool-monoculture
  list is the point. A fused challenger that wins both axes becomes the build.
  Close the weighing with a verdict per challenger, decided before any
  borrowing is considered: wins (beats the assigned direction on both axes),
  competitive (holds one axis), or declined (loses both). A declined
  challenger is not spent: name the one discipline of its system the assigned
  direction lacks, and raise the assigned direction to match before
  presenting it. A donation transfers ambition and system discipline, never
  the challenger's clothes; one world owns the page. Write each raise as its
  own named line on the presented direction, and carry every verdict, kept
  line, and raise into the decision page payload.`
  : `A challenger wins only when its fused result beats the grounded list on
  audience identification and product clarity. It may change task topology or
  interaction, but never the committed visual identity.`;

  const authorityInstruction = scope === 'direction'
    ? `PRODUCT.md and explicit incumbent brand commitments constrain every direction.
The seed never chooses exact colors, fonts, tokens, or a user preference, and
it never permits the world and first surface to be selected independently.`
  : `PRODUCT.md and DESIGN.md constrain every surface candidate's identity
vocabulary; they do not cancel task-level composition. The seed never
authorizes a new palette, type system, material world, or unfamiliar control
behavior.`;

  const richnessInstruction = `The CREATIVE SPARK is a complete visual system, not a theme or decorative
reference. Translate every supplied system rule into the product: palette and
material, type and composition, topology, controls and states, and adaptation.
Keep the source's visible character, scale, rhythm, and interaction instead of
reducing vivid grammar to generic nouns. When the source is already a credible
interface language, commit to it across navigation, content, controls, and
states. Otherwise keep a literal carrier only when it becomes functional.
Ambitious motion, spatial media, or interaction is welcome when it strengthens
the product without weakening semantics, performance, or fallback behavior.`;

  if (!data) {
    // A degraded roll can still serve the safer register, which needs no
    // catalog at all: the assignment machinery is suppressed entirely, the
    // same as the non-degraded safer round, because emitting both "the user
    // picks" and a mandatory numbered build order hands the model two
    // contradicting instructions and the mandatory one tends to win. The
    // bolder register is exactly the thing degradation took away, so it
    // falls back to a plain grounded round, disclosed.
    const degradedHeader = `${scope.toUpperCase()} CONCEPT SEED (key: ${key}; mode: ${mode ?? 'unscoped'}; source: degraded; rerun with --scope ${scope}${mode ? ` --mode ${mode}` : ''} --from ${key}${reroll > 0 ? ` --reroll ${reroll}` : ''}${register ? ` --register ${register}` : ''} --candidate-count ${candidateCount})`;
    if (register === 'safer') {
      return `${degradedHeader}
SAFER REGISTER (user-requested): the assigned index is suspended this
  round; the user picks, and no candidate is mandated. Present the familiar
  register: your remaining grounded candidates from the conventional end, at
  most three, as full cards with an honest risk line each, plus the canon
  executed against two or three named competitors. This is the one sanctioned
  lineup of your own ranked candidates; it exists only by this explicit
  request. When the user voices a standing preference for it, record a brand
  commitment in PRODUCT.md.
${authorityInstruction}
A user- or brief-pinned decision beats the roll, always.
REGISTER (restated for truncated readers): safer, user-requested; the
assigned index is suspended this round and the user picks; seed key ${key}.
`;
    }
    const degradedRegister = register === 'bolder'
      ? `BOLDER REGISTER UNAVAILABLE: bolder deals foreign forms, and this roll ran
  degraded with no catalog and no roll service, so there is nothing bold to
  deal. Tell the user, then run this round as a plain grounded re-roll; the
  assignment below applies.
`
      : '';
    return `${degradedHeader}
${degradedRegister}${scope === 'direction' ? `ASSIGNED INDEX: ${buildIndex}` : `DEALT INDICES: ${dealtIndices.join(', ')} (index ${buildIndex} leads)`}
  ${promotedInstruction}
  The assignment exists to refuse the model's ranking rut, never to outrank
  the user or the brief. Never expose assignment metadata in user-facing labels.
No challengers this run: the roll service was unreachable and no local
catalog exists. A sandboxed shell without network egress is the most common
cause; before accepting degradation, rerun this command once through the
harness's network-enabled or escalated command tool. When that rerun needs
an approval, state exactly what the approver must know: this script's only
network contact is one GET to https://impeccable.style/api/roll whose query
carries scope, mode, an eight-hex seed key, and a re-roll counter; no
project files, prompts, code, or conversation context are transmitted, and
nothing is written. An approval request naming that URL and payload judges
the real action; a bare "run with network" invites rejection for contacting
an unspecified domain. If the rerun is still refused, proceed with the
grounded candidates alone; the assignment above still applies at full
strength. Tell the user plainly that this roll
ran degraded, with no challengers and no quality-bar boards; do not present
the outcome as a full roll. A degraded roll changes the cards, not the
channel: when a browser can open, present the direction on the decision page
(serve-question.mjs, text-only card); the structured question tool remains
the no-browser fallback.
${authorityInstruction}
A user- or brief-pinned decision beats the roll, always.
${scope === 'direction'
    ? `ASSIGNED INDEX (restated for truncated readers): ${buildIndex}. Build candidate
${buildIndex} of your own grounded list; seed key ${key}.`
    : `DEALT INDICES (restated for truncated readers): ${dealtIndices.join(', ')}; index
${buildIndex} leads. Present all three dealt structures; seed key ${key}.`}
`;
  }

  // Field order is the migration: `compositions` is current, `stagings` is what
  // the API emitted while these were called stagings, and `staging` is the
  // single-pick shape from before it dealt three. Older installs keep working.
  // Compositions are pulled from the deal until the expanded catalog is
  // ready for prime time: the current pool crowds the decision more than it
  // widens it. IMPECCABLE_COMPOSITIONS=1 re-enables rendering for catalog
  // development; the draw machinery, axes, and grain report stay intact.
  const compositionsEnabled = process.env.IMPECCABLE_COMPOSITIONS === '1';
  const compositions = !compositionsEnabled ? []
    : Array.isArray(data.compositions)
      ? data.compositions
      : Array.isArray(data.stagings)
        ? data.stagings
        : data.staging ? [data.staging] : [];
  // The grain report. A top-up keeps the deal at three, which is right, but it
  // must not read as three on-target inputs: a flow request answered entirely by
  // view-grain compositions means the model has to derive the flow's own
  // structure and borrow only their sequence law. Silence here would reproduce
  // the exact failure this axis exists to fix.
  const match = data.compositionMatch ?? null;
  const grainNote = (() => {
    if (!match?.grain) return '';
    if (match.grainAvailable === 0) {
      return `\nNONE of these sit at the requested ${match.grain} grain, because the catalog holds no ${match.grain}-grain composition yet. Derive that structure yourself and borrow only their sequence and attention laws.`;
    }
    if (match.atGrain === 0) {
      return `\nNONE of these sit at the requested ${match.grain} grain, though ${match.grainAvailable} exist; these were topped up from the rest of the register. Treat their structure as borrowed.`;
    }
    if ((match.atGrain ?? 0) < compositions.length) {
      return `\n${match.atGrain} of ${compositions.length} sit at the requested ${match.grain} grain; the rest were topped up from the register and their structure is borrowed.`;
    }
    return '';
  })();
  const compositionBlock = compositions.length > 0
    ? `\n${scope === 'direction' ? 'FIRST-SURFACE COMPOSITION INPUTS (identity-free; test them with shortlisted worlds and keep world plus composition one decision):' : 'COMPOSITION CHALLENGERS (identity-free; dress them in the committed visual identity before judging):'}
${compositions.map((composition, index) => renderComposition(composition, index)).join('\n')}
Each one asks the same question of this build: what is the cleverest way to
present, organize, or make interactive the problem in front of you? They carry
structure only, never a palette, typeface, or material. Treat them as serious
rivals to your habitual layout, and keep only what makes this product clearer.${grainNote}\n`
    : '';
  const rerollBlock = reroll > 0
    ? `RE-ROLL ROUND ${reroll}${register ? ` (${register.toUpperCase()} REGISTER, user-requested)` : ''}: every candidate presented in earlier rounds, grounded
  and challenger alike, is eliminated and may not return reworded.${register ? '' : ` Derive
  genuinely new grounded candidates from unexplored angles before judging
  these fresh challengers.`}\n`
    : '';
  // A register swaps the round's presentation, never its deal: the assigned
  // index and challenger fetch stay identical so the chain reproduces, and
  // only the instructions change.
  const saferBlock = `SAFER REGISTER: the user asked for the familiar end of the spectrum, so this
  round's dealt hand is spent unseen, stays excluded from future rounds, and
  is not printed. The assigned index is suspended this round; the user picks. Present the familiar register: your remaining grounded
  candidates from the conventional end, at most three, as full cards with an
  honest risk line each, plus the canon executed against two or three named
  competitors. This is the one sanctioned lineup of your own ranked
  candidates; it exists only by this explicit request. When the user voices a
  standing preference for it, record a brand commitment in PRODUCT.md.`;
  const bolderBlock = `BOLDER REGISTER: the user asked for foreign forms at full commitment, so no
  grounded direction is presented this round and the assigned index is
  suspended. The hand is every dealt challenger below, each fused with the
  product and presented as a full card; the FIRST dealt challenger leads, an
  assignment by deal order, so the dice still choose. Verdicts and donations
  apply between the challengers, weighed against the leader. The pick card
  sits out; the canon stays, as always.`;
  // The one command that follows a resolved choice. It records the choice
  // (anonymous telemetry on API-dealt rolls; skipped under DO_NOT_TRACK /
  // IMPECCABLE_NO_TELEMETRY) and opens the build's phase machine, whose
  // first gate is the comp round on a comp-led build. Every run that skipped
  // the comp round did so by treating a separate "telemetry ping" as
  // bookkeeping: suppressed with >/dev/null, run after the page was written,
  // or never run. So there is no separate ping; the start command is the
  // ping, and it is not optional.
  const nextCommand = scope === 'direction'
    ? `AFTER THE CHOICE, run exactly one command and follow what it prints (do not suppress its output; do not write page code before it):
  build-phase.mjs start --direction ${key} --kind <assigned|pick|challenger|canon>${data.source === 'api' ? ' [--chosen <challenger-id>]' : ''}${register ? ` --register ${register}` : ''}
  It records the choice${data.source === 'api' ? ' (anonymous: card kind plus catalog id; skipped under DO_NOT_TRACK / IMPECCABLE_NO_TELEMETRY)' : ''} and opens the build phases: on a comp-led build the comp round is the first gate (three comps, one approved) and no page code is written before it closes; on a code-led build it prints the contract step. A build without this state file is a build the finish reviewer treats as having skipped the round.\n`
    : (data.source === 'api'
      ? `AFTER THE CHOICE, run once: concept-seed.mjs --kind <assigned|pick|challenger|canon> --from ${key} --scope ${scope}${mode ? ` --mode ${mode}` : ''} (records the choice; the locked card's comp is the approved comp, so then: build-phase.mjs start --comp <that comp>).\n`
      : `AFTER THE CHOICE: the locked card's comp is the approved comp; run build-phase.mjs start --comp <that comp> and follow what it prints.\n`);
  const telemetryBlock = nextCommand;
  const assignedBlock = register === null
    ? `${scope === 'direction' ? `ASSIGNED INDEX: ${buildIndex}` : `DEALT INDICES: ${dealtIndices.join(', ')} (index ${buildIndex} leads)`}
  ${promotedInstruction}
  The assignment exists to refuse the model's ranking rut, never to outrank
  the user or the brief. Never expose assignment metadata in user-facing labels.`
    : register === 'safer' ? saferBlock : bolderBlock;
  // A bolder round has no assigned grounded direction, so the generic
  // weighing instruction (which measures against the assignment) would
  // contradict the register; the bolder variant weighs against the leader.
  const bolderChallengerInstruction = `Fuse each challenger before judging it: the challenger supplies the form
  and its system grammar, the product supplies every fact, and clarity wins
  conflicts. Weigh every fused challenger against the fused LEADER, the first
  dealt, on exactly two axes, audience identification and product clarity;
  verdicts and donations apply between the challengers, and one that beats
  the leader on both axes presents as the hand's strongest alternate.`;
  const roundChallengerInstruction = register === 'bolder' ? bolderChallengerInstruction : challengerInstruction;
  const challengerSection = register === 'safer'
    ? ''
    : `CHALLENGERS:
${data.challengers.map(renderChallenger).join('\n')}
${compositionBlock}${roundChallengerInstruction}
When you can view images, open the QUALITY BAR board and hero for any
challenger you weigh seriously and for the world you build. They exist as a
craft bar, the finish level and commitment the build is expected to reach,
never as a mockup to copy; your surface serves this product, not that render.
`;
  const restated = register === null
    ? (scope === 'direction'
      ? `ASSIGNED INDEX (restated for truncated readers): ${buildIndex}. Build candidate
${buildIndex} of your own grounded list; seed key ${key}.`
      : `DEALT INDICES (restated for truncated readers): ${dealtIndices.join(', ')}; index
${buildIndex} leads. Present all three dealt structures; seed key ${key}.`)
    : `REGISTER (restated for truncated readers): ${register}, user-requested; the
assigned index is suspended this round; seed key ${key}.`;
  return `${scope.toUpperCase()} CONCEPT SEED (key: ${key}; mode: ${mode ?? 'unscoped'}; source: ${data.source}; approved pool: ${data.poolRevision}; ${data.approvedCount}/${data.catalogCount} human-approved; rerun with --scope ${scope}${mode ? ` --mode ${mode}` : ''} --from ${key}${reroll > 0 ? ` --reroll ${reroll}` : ''}${register ? ` --register ${register}` : ''} --candidate-count ${candidateCount} to reproduce this roll against this catalog revision)
${rerollBlock}${assignedBlock}
${challengerSection}${authorityInstruction}
${richnessInstruction}
${telemetryBlock}A user- or brief-pinned decision beats the roll, always.
${restated}
`;
}

/**
 * What the model must do next, once a direction (or surface structure) is
 * chosen. Read from the same config the boot directive reads:
 * `.impeccable/config.local.json` over `.impeccable/config.json`,
 * `buildPath` comp|code; with neither, comp-led whenever image generation
 * exists (an OpenAI key here; a harness-native image tool is invisible to
 * this script, so the text names it too), code-led otherwise.
 */

function nextStepAfterChoice({ key = null, scope = "direction", cwd = process.cwd(), env = process.env }: {
	readonly key?: string | null;
	readonly scope?: "direction" | "surface";
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
} = {}): string {
  let buildPath = null;
  for (const name of ['config.json', 'config.local.json']) {
    try {
      const raw = JSON.parse(readFileSync(resolve(cwd, '.impeccable', name), 'utf8'));
      if (raw?.buildPath === 'comp' || raw?.buildPath === 'code') buildPath = raw.buildPath;
    } catch { /* absent */ }
  }
  const imageGen = !!env.OPENAI_API_KEY;
  const seed = key ? ` --direction ${key}` : '';
  if (buildPath === 'code') {
    return `NEXT (code-led, from .impeccable config): write the direction contract, then build; no comp round. Load reference/new-work.md section 5 and 6.\n`;
  }
  const why = buildPath === 'comp' ? 'from .impeccable config' : imageGen ? 'default: image generation is available' : 'default: comp-led unless no image tool exists; if your harness truly has none and there is no OpenAI key, this is code-led and you say so in one line';
  if (scope === 'surface') {
    return `NEXT (comp-led, ${why}): the locked card's comp is the approved comp. Run: build-phase.mjs start --comp <that comp> and follow its NEXT lines. Do not write page code before build-phase.mjs advance has closed the spec, plates, and hero gates.\n`;
  }
  return `NEXT (comp-led, ${why}): the world is chosen; the composition is not. Run: build-phase.mjs start${seed} and follow its NEXT lines: it opens the comps phase (three comps under .impeccable/mocks/, one approved by the user through the decision page or structured question, sidecar "approved": true), then spec, plates, hero, sections, motion, responsive, review. Do not write page code before those gates close. Reference: reference/visualize.md for the comp round.\n`;
}

export {
	dealCompositions,
	nextStepAfterChoice,
	renderChallenger,
	renderComposition,
	renderConceptSeed,
	selectApprovedChallengers,
	selectApprovedComposition,
	selectApprovedCompositions,
	SEED_MODES,
};
export type { DealOptions, ChallengerOptions, ResolvedRoll, SeedChallenger, SeedComposition, SeedOptions };
