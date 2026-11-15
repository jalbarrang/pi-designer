/**
 * Motion rules, ported from Impeccable's engine
 * (github.com/pbakaus/impeccable, Apache-2.0; see NOTICE).
 *
 * Two tells: bounce/elastic easing on a UI motion, and transitions on layout
 * properties, which reflow the page on every frame.
 */
import { SAFE_TAGS } from "../shared/constants.ts";
import type { RuleHit } from "./rule-hit.ts";

const LAYOUT_TRANSITION_PROPS: ReadonlySet<string> = new Set([
	"width", "height", "padding", "margin",
	"max-height", "max-width", "min-height", "min-width",
	"padding-top", "padding-right", "padding-bottom", "padding-left",
	"margin-top", "margin-right", "margin-bottom", "margin-left",
]);

export interface MotionOptions {
	readonly tag: string;
	readonly transitionProperty?: string | null;
	readonly animationName?: string | null;
	readonly timingFunctions?: string | null;
	readonly classList?: string | null;
}

/** Bounce/elastic easing and layout-property transitions for one element. */
function checkMotion(opts: MotionOptions): RuleHit[] {
	const { tag, transitionProperty, animationName, timingFunctions, classList } = opts;
	if (SAFE_TAGS.has(tag)) return [];
	const findings: RuleHit[] = [];

	if (animationName && animationName !== "none" && /bounce|elastic|wobble|jiggle|spring/i.test(animationName)) {
		findings.push({ id: "bounce-easing", snippet: `animation: ${animationName}` });
	}
	if (classList && /\banimate-bounce\b/.test(classList)) {
		findings.push({ id: "bounce-easing", snippet: "animate-bounce (Tailwind)" });
	}

	// Overshoot cubic-bezier: a control-point y outside [0, 1] overshoots.
	if (timingFunctions) {
		const bezierRe = /cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/g;
		for (let m = bezierRe.exec(timingFunctions); m !== null; m = bezierRe.exec(timingFunctions)) {
			const y1 = parseFloat(m[2]);
			const y2 = parseFloat(m[4]);
			if (y1 < -0.1 || y1 > 1.1 || y2 < -0.1 || y2 > 1.1) {
				findings.push({ id: "bounce-easing", snippet: `cubic-bezier(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})` });
				break;
			}
		}
	}

	if (transitionProperty && transitionProperty !== "all" && transitionProperty !== "none") {
		const props = transitionProperty.split(",").map((p) => p.trim().toLowerCase());
		const layoutFound = props.filter((p) => LAYOUT_TRANSITION_PROPS.has(p));
		if (layoutFound.length > 0) {
			findings.push({ id: "layout-transition", snippet: `transition: ${layoutFound.join(", ")}` });
		}
	}

	return findings;
}

export { checkMotion, LAYOUT_TRANSITION_PROPS };
