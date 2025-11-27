import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
		exclude: ["node_modules", "dist", ".idea", ".git", ".cache"],
		testTimeout: 20_000,
	},
});

