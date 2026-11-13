import { describe, expect, test } from "bun:test";

import { compact, percent } from "../src/lib/utils/format.ts";

describe("format", () => {
	test("compacts thousands", () => {
		expect(compact(1200)).toBe("1.2k");
	});

	test("keeps small numbers", () => {
		expect(compact(12)).toBe("12");
	});

	test("formats percents", () => {
		expect(percent(0.042)).toBe("4.2%");
	});
});
