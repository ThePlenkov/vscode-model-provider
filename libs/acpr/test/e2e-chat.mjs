#!/usr/bin/env node

/**
 * E2E test for claude-acp adapter
 * Tests the full conversation flow: initialize -> session/new -> session/prompt
 */

import { spawn } from 'child_process';

const ADAPTER_PATH = './dist/adapters/claude-acp.mjs';

async function sendRequest(adapter, request) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify(request) + '\n';
    adapter.stdin.write(input);
    
    let output = '';
    adapter.stdout.on('data', (data) => {
      output += data.toString();
      try {
        const response = JSON.parse(output.trim());
        resolve(response);
      } catch {
        // Not complete yet
      }
    });
    
    adapter.stderr.on('data', (data) => {
      // Ignore stderr logs
    });
    
    adapter.on('error', reject);
  });
}

async function testE2E() {
  console.log('Starting E2E test for claude-acp adapter...\n');
  
  const adapter = spawn('node', [ADAPTER_PATH], {
    stdio: 'pipe'
  });
  
  let stderr = '';
  let notifications = [];
  
  adapter.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  
  // Track notifications
  adapter.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          if (msg.method) {
            notifications.push(msg);
          }
        } catch {
          // Not JSON yet
        }
      }
    }
  });
  
  try {
    // Step 1: Initialize
    console.log('Step 1: Initialize');
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 }
    };
    
    const initResponse = await sendRequest(adapter, initRequest);
    console.log('✓ Initialize successful');
    console.log('  Models:', initResponse.result.models.length);
    console.log('  First model:', initResponse.result.models[0].name);
    
    // Step 2: Create session
    console.log('\nStep 2: Create session');
    const sessionRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] }
    };
    
    const sessionResponse = await sendRequest(adapter, sessionRequest);
    console.log('✓ Session created');
    console.log('  Full response:', JSON.stringify(sessionResponse, null, 2));
    
    const sessionId = sessionResponse.result?.sessionId || sessionResponse.sessionId;
    
    // Step 3: Send a prompt
    console.log('\nStep 3: Send prompt');
    const promptRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'Hello, can you say "E2E test successful"?' }
        ]
      }
    };
    
    const promptResponse = await sendRequest(adapter, promptRequest);
    console.log('✓ Prompt sent');
    console.log('  Full response:', JSON.stringify(promptResponse, null, 2));
    
    // Wait a bit for notifications
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('  Notifications received:', notifications.length);
    if (notifications.length > 0) {
      console.log('  First notification:', JSON.stringify(notifications[0], null, 2));
    }
    
    console.log('  Response:', promptResponse.result?.stopReason || 'No stop reason');
    
    // Step 4: Close session
    console.log('\nStep 4: Close session');
    const closeRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'session/close',
      params: { sessionId }
    };
    
    await sendRequest(adapter, closeRequest);
    console.log('✓ Session closed');
    
    console.log('\n✅ E2E test PASSED');
    
  } catch (error) {
    console.error('\n❌ E2E test FAILED:', error);
    console.error('Stderr:', stderr);
    process.exit(1);
  } finally {
    adapter.kill();
  }
}

testE2E();
