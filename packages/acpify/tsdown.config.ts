import { defineConfig } from "tsdown";
import baseConfig from "../../tsdown.config.base.ts";

export default defineConfig({
  ...baseConfig,
  entry: {
    index: "./src/index.ts",
    "provider/barebone": "./src/provider/barebone.ts",
  },
});