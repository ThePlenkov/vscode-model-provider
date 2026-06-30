#!/usr/bin/env node
/**
 * Self-install script for vscode-model-provider.
 *
 * Run automatically via `postinstall`, or manually via:
 *   node scripts/self-install.js
 *
 * What it does:
 *   1. Verifies `code` and `vsce` are on PATH
 *   2. Compiles TypeScript (tsc)
 *   3. Packages the extension (.vsix)
 *   4. Installs the .vsix into VS Code
 */

"use strict";

const { execSync: exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Package root — works whether we're in node_modules/ or in the repo root
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const VSIX_OUT = path.join(ROOT, "out", "vscode-model-provider.vsix");

// ANSI colours
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function log(...args) {
  console.log("[vscode-model-provider]", ...args);
}

function run(cmd, opts = {}) {
  log(dim(`$ ${cmd}`));
  try {
    return exec(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
  } catch (err) {
    console.error(red(`✗ Command failed: ${cmd}`));
    if (err.message) console.error(dim(err.message));
    process.exit(1);
  }
}

function commandExists(cmd) {
  try {
    exec(`${process.platform === "win32" ? "where" : "command"} ${cmd}`, {
      stdio: "ignore",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Step 0: Are we in a CI / headless environment? Skip. ──────────────────
const CI = process.env.CI === "true" || process.env.npm_config_ignore_scripts === "true";
if (CI) {
  log(yellow("Skipping self-install (CI / --ignore-scripts detected)."));
  log(dim("To install manually: npm run install:vsix"));
  process.exit(0);
}

// ─── Step 1: Check prerequisites ────────────────────────────────────────────
log(bold("ACP Model Provider — self-install"));

if (!commandExists("code")) {
  console.error(
    red("✗ 'code' command not found in PATH.")
  );
  console.error(
    `  ${dim("VS Code CLI is required. Install it from:")}`
  );
  console.error(
    `  ${dim("https://code.visualstudio.com/docs/editor/command-line#_installing")}
  `);
  console.error(
    `  Then re-run: ${bold("npm install -g vscode-model-provider")}
  `);
  process.exit(1);
}

if (!commandExists("vsce")) {
  log(yellow("'vsce' not found — installing temporarily via npx…"));
  // We'll use `npx vsce package` below
}

// ─── Step 2: Compile TypeScript ───────────────────────────────────────────────
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

if (fs.existsSync(OUT_DIR)) {
  log(`Compiling TypeScript → ${dim("out/")}…`);
  run("npx tsc --noEmit --project .");
  // Use tsc directly to compile (no separate lint step needed)
  run("npx tsc --project .");
  log(green("✓ TypeScript compiled"));
} else {
  log(yellow("out/ not found — running tsc…"));
  run("npx tsc --project .");
}

// ─── Step 3: Package .vsix ───────────────────────────────────────────────────
log(`Packaging extension…`);
const vsceCmd = commandExists("vsce") ? "vsce" : "npx vsce";
const packageCmd = `${vsceCmd} package --no-dependencies`;
run(packageCmd);

// Verify the .vsix was created
const vsixFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith(".vsix"));
if (vsixFiles.length === 0) {
  console.error(red("✗ .vsix file not found after packaging."));
  process.exit(1);
}
const vsixPath = path.join(ROOT, vsixFiles[0]);
log(green(`✓ Packaged: ${vsixFiles[0]}`));

// ─── Step 4: Install into VS Code ───────────────────────────────────────────
// Detect if we should install globally or per-user
const isVSIX = false; // set to true if publishing to marketplace
const installCmd = `code --install-extension "${vsixPath}" ${isVSIX ? "--force" : ""}`;

log(`Installing into VS Code…`);
try {
  exec(installCmd, { stdio: "inherit" });
  log(green(`✓ Installed successfully!`));
  log(``);
  log(bold("Restart VS Code to activate the extension."));
  log(dim("Then open Copilot Chat → model picker → ACP agents"));
} catch (err) {
  // `code --install-extension` returns non-zero if already installed without --force
  if (err.status === 1 && err.message && err.message.includes("already")) {
    log(yellow("Extension is already installed — skipping."));
    log(dim("To reinstall: code --install-extension --force \"" + vsixPath + "\""));
  } else {
    console.error(red("✗ Failed to install extension into VS Code."));
    console.error(dim(err.message));
    process.exit(1);
  }
}
