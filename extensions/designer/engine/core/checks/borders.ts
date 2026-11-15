/**
 * Border rules, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * The single most recognizable generated-UI tell: a thick chromatic border on
 * one edge of a card, chip, or container.
 */
import { isNeutralColor } from "../shared/color.ts";
import { BORDER_SAFE_TAGS } from "../shared/constants.ts";
import type { RuleHit } from "./rule-hit.ts";

/** The four edges a border width or color is reported for. */
export type BorderSide = "Top" | "Right" | "Bottom" | "Left";

export interface BorderCheckOptions {
	/** A `<span>` that paints its own visible background is a chip, not inline text, so it stays a stripe target. */
	readonly badgeLike?: boolean;
	/** A live status or alert region wears a colored single-edge border as a severity accent, not as the tell. */
	readonly statusContext?: boolean;
	/** A selected tab underline is exempt; adapters detect tablist/nav/tab ancestors and `aria-selected`. */
	readonly tabContext?: boolean;
}

const SIDES: readonly BorderSide[] = ["Top", "Right", "Bottom", "Left"];

/**
 * Report the stripe tell for one element's border widths and colors.
 *
 * Gates: the edge must be at least 1px and chromatic, and it must dominate its
 * opposite pair (at least twice the widest other edge, or the others at most
 * 1px). A thick accent on a rounded element reports the rounded variant, since
 * the two fight each other visually.
 */
function checkBorders(
	tag: string,
	widths: Readonly<Record<BorderSide, number>>,
	colors: Readonly<Record<BorderSide, string | null | undefined>>,
	radius: number,
	opts: BorderCheckOptions = {},
): RuleHit[] {
	const spanBadge = tag === "span" && !!opts.badgeLike;
	if (BORDER_SAFE_TAGS.has(tag) && !spanBadge) return [];
	if (opts.statusContext) return [];

	const findings: RuleHit[] = [];

	for (const side of SIDES) {
		const w = widths[side];
		if (w < 1 || isNeutralColor(colors[side])) continue;

		const otherSides = SIDES.filter((s) => s !== side);
		const maxOther = Math.max(...otherSides.map((s) => widths[s]));
		if (!(w >= 2 && (maxOther <= 1 || w >= maxOther * 2))) continue;

		const sn = side.toLowerCase();
		const isSide = side === "Left" || side === "Right";

		if (isSide) {
			if (spanBadge) continue;
			if (radius > 0) {
				findings.push({ id: "side-tab", snippet: `border-${sn}: ${w}px + border-radius: ${radius}px` });
			} else if (w >= 3) {
				findings.push({ id: "side-tab", snippet: `border-${sn}: ${w}px` });
			}
		} else if (radius > 0 && w >= 2) {
			findings.push({ id: "border-accent-on-rounded", snippet: `border-${sn}: ${w}px + border-radius: ${radius}px` });
		} else if (!opts.tabContext && w >= 3 && w <= 12) {
			// The horizontal variant: a thick chromatic band riding the top or
			// bottom edge of a card, badge, or container. Links, buttons, table
			// cells and <hr> never reach here (BORDER_SAFE_TAGS).
			findings.push({ id: "side-tab", snippet: `border-${sn}: ${w}px` });
		}
	}

	return findings;
}

export { checkBorders };
