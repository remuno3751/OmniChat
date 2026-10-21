import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Shared Node-only git helpers (docs/design/VSCODE-BRIDGE.md §1.6); reused, not copied.
      { find: "@gitops", replacement: fileURLToPath(new URL("../bridge/src/gitops.ts", import.meta.url)) },
      // Pure modules shared with the OmniChat app (markdownParse, highlight); no React imported.
      { find: "@app", replacement: fileURLToPath(new URL("../app/src", import.meta.url)) },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
