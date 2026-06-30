#!/usr/bin/env node

/**
 * acpr - ACP Router CLI
 * 
 * Generic CLI tool for ACP protocol translation and routing
 * 
 * Usage:
 *   acpr proxy [agent]    # Run generic proxy for an agent
 *   acpr mcp [agent]       # Run MCP server for an agent
 *   acpr http [agent]      # Run HTTP server for an agent
 *   acpr-claude            # Claude-specific adapter
 *   acpr-gemini            # Gemini-specific adapter
 */

import { spawn } from 'child_process';

interface CLIOptions {
  command: string;
  args: string[];
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('acpr - ACP Router CLI');
    console.error('');
    console.error('Usage:');
    console.error('  acpr proxy [agent]    # Run generic proxy for an agent');
    console.error('  acpr mcp [agent]       # Run MCP server for an agent');
    console.error('  acpr http [agent]      # Run HTTP server for an agent');
    console.error('  acpr-claude            # Claude-specific adapter');
    console.error('  acpr-gemini            # Gemini-specific adapter');
    console.error('');
    console.error('Examples:');
    console.error('  acpr proxy claude      # Proxy Claude Code CLI');
    console.error('  acpr-claude            # Use Claude adapter');
    process.exit(1);
  }
  
  const command = args[0];
  
  switch (command) {
    case 'proxy':
      await handleProxy(args.slice(1));
      break;
    case 'mcp':
      await handleMcp(args.slice(1));
      break;
    case 'http':
      await handleHttp(args.slice(1));
      break;
    default:
      // Try to find an adapter
      await handleAdapter(args);
      break;
  }
}

async function handleProxy(args: string[]) {
  if (args.length === 0) {
    console.error('Usage: acpr proxy <agent-command> [args...]');
    console.error('Example: acpr proxy claude -p "hello"');
    process.exit(1);
  }
  
  const agentCommand = args[0];
  const agentArgs = args.slice(1);
  
  console.error(`acpr: Starting proxy for agent: ${agentCommand}`);
  
  // For now, just forward to the agent
  // In the future, this will use the TypeScript SDK to proxy ACP messages
  const agent = spawn(agentCommand, agentArgs, {
    stdio: 'inherit'
  });
  
  await new Promise((resolve, reject) => {
    agent.on('close', resolve);
    agent.on('error', reject);
  });
}

async function handleMcp(args: string[]) {
  console.error('acpr: MCP server mode not yet implemented');
  console.error('Coming soon!');
  process.exit(1);
}

async function handleHttp(args: string[]) {
  console.error('acpr: HTTP server mode not yet implemented');
  console.error('Coming soon!');
  process.exit(1);
}

async function handleAdapter(args: string[]) {
  const adapterName = args[0];
  
  // Check if it's a bundled adapter (acpr-claude, acpr-gemini, etc.)
  // These would be separate executables
  if (adapterName.startsWith('acpr-')) {
    console.error(`acpr: Unknown adapter: ${adapterName}`);
    console.error('Available adapters: claude, gemini');
    process.exit(1);
  }
  
  // Try to load adapter dynamically
  try {
    const adapterModule = await import(`./adapters/${adapterName}.js`);
    if (adapterModule.run) {
      await adapterModule.run(args.slice(1));
    } else {
      console.error(`Adapter ${adapterName} does not export a run function`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Failed to load adapter: ${adapterName}`);
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('acpr: Fatal error', error);
  process.exit(1);
});
