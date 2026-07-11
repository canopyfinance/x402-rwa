import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    viem: "src/viem.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
