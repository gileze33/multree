import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/cli.ts"],
    format: "esm",
    target: "node20.6",
    platform: "node",
    outDir: "dist",
    clean: true,
    shims: true,
    dts: false,
    sourcemap: false,
});
