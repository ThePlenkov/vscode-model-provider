import { defineConfig } from 'tsdown';

export default defineConfig({
  format: 'esm',
  deps: {
    neverBundle: ['vscode', '@agentclientprotocol/sdk']
  },
  dts: {
    sourcemap: true
  },
  clean: true,
  sourcemap: true,
  minify: false,
  exports: {
    legacy: true
  },
});
