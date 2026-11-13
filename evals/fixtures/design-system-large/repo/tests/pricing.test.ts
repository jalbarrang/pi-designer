import { describe, expect, test } from "bun:test";

import { money } from "../src/lib/utils/currency.ts";

describe("money", () => {
	test("formats whole dollars", () => {
		expect(money(48)).toBe("$48");
	});

	test("respects the currency", () => {
		expect(money(48, "EUR")).toContain("€");
	});
});
