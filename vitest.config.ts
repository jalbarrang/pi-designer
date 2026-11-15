import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Tests live in `test/` and mirror the module tree they cover. The fixtures under
		// `evals/` carry `.test.ts` files of their own, which are inputs, not tests.
		include: ["test/**/*.test.ts"],
	},
});
