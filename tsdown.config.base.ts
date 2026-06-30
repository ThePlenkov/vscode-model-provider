import { defineConfig } from "tsdown";

export default defineConfig({
  format: "esm",
  // Inverse of `external`: list packages to NEVER bundle (they stay
  // external). Everything else — including workspace deps like
  // `@theplenkov/acpify` — gets bundled into the output so the
  // resulting `.vsix` is self-contained.
  deps: {
    neverBundle: ["vscode"],
  },
  dts: {
    sourcemap: true,
  },
  clean: true,
  sourcemap: true,
  minify: false,
  exports: {
    legacy: true,
  },
});