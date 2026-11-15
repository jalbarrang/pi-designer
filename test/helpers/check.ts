/**
 * The test harness: one vitest case per comparison, so a miss names the exact input that broke it
 * and never hides the comparisons that come after it.
 */
import { expect, test } from "vitest";

/** Compare a computed value against what it should be for the same input. */
export function check(name: string, actual: unknown, expected: unknown): void {
	test(name, () => {
		expect(actual).toEqual(expected);
	});
}

/** Assert a plain condition, with an optional detail line shown on failure. */
export function checkOk(name: string, ok: boolean, detail = ""): void {
	test(name, () => {
		expect(ok, detail).toBe(true);
	});
}
