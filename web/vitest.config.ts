import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in plain node. "@/" means this folder, the same as in tsconfig.json.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  test: { include: ["lib/**/*.test.ts"], environment: "node" },
});
