import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    server: {
      // Transpile workspace packages imported as ESM .ts source.
      deps: { inline: [/@naruto5e\//] },
    },
  },
});
