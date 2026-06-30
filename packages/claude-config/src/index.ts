/**
 * claude-config - Claude Code configuration resolver
 * 
 * Reads Claude Code settings.json and resolves authentication
 * Returns SDK-compatible configuration
 */

import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

// Use Anthropic SDK types only for typing
import type { ClientOptions, LogLevel, Logger, HeadersLike } from '@anthropic-ai/sdk';

export interface ClaudeConfig {
  // Authentication
  apiKey?: string;
  authToken?: string;
  apiKeyHelper?: {
    command: string;
    ttl?: number;
  };
  credentials?: any; // AccessTokenProvider
  config?: any; // AnthropicConfig
  profile?: string;
  webhookKey?: string;
  
  // API Configuration
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  
  // Request Configuration
  defaultHeaders?: HeadersLike;
  defaultQuery?: Record<string, string | undefined>;
  fetchOptions?: any; // MergedRequestInit
  
  // Logging
  logLevel?: LogLevel;
  logger?: Logger;
  
  // Model Configuration
  defaultModel?: string;
  advisorModel?: string;
  availableModels?: string[];
  enforceAvailableModels?: boolean;
  fallbackModel?: string[];
  modelOverrides?: Record<string, string>; // Maps internal ID to canonical models.dev ID
  
  // Environment variables to pass through
  env?: Record<string, string>;
}

export interface ResolvedConfig {
  sdk: () => ClientOptions;
  baseUrl: string;
  hasAuth: boolean;
  raw: ClaudeConfig;
}

/**
 * Resolve Claude Code configuration from settings.json
 */
export async function resolveConfig(projectDir?: string): Promise<ResolvedConfig> {
  const config = await readSettingsJson(projectDir);
  
  return {
    sdk: () => toSdkConfig(config),
    baseUrl: config.baseUrl || 'https://api.anthropic.com',
    hasAuth: !!(config.apiKey || config.authToken || config.apiKeyHelper || config.credentials || config.config),
    raw: config
  };
}

/**
 * Read Claude Code settings.json
 */
async function readSettingsJson(projectDir?: string): Promise<ClaudeConfig> {
  const configPaths = [
    projectDir ? join(projectDir, '.claude', 'settings.json') : null,
    join(homedir(), '.claude', 'settings.json'),
  ].filter(Boolean);

  let settings: any = {};

  for (const configPath of configPaths) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const fileSettings = JSON.parse(content);
      // Merge settings (later files override earlier ones)
      settings = { ...settings, ...fileSettings };
    } catch (error) {
      // Try next path
      continue;
    }
  }

  return parseSettings(settings);
}

/**
 * Parse Claude Code settings
 */
function parseSettings(settings: any): ClaudeConfig {
  const config: ClaudeConfig = {};

  // Extract from settings if present
  if (settings.apiKey) config.apiKey = settings.apiKey;
  if (settings.authToken) config.authToken = settings.authToken;
  if (settings.baseUrl) config.baseUrl = settings.baseUrl;
  if (settings.apiKeyHelper) config.apiKeyHelper = settings.apiKeyHelper;
  if (settings.credentials) config.credentials = settings.credentials;
  if (settings.config) config.config = settings.config;
  if (settings.profile) config.profile = settings.profile;
  if (settings.webhookKey) config.webhookKey = settings.webhookKey;
  if (settings.defaultModel) config.defaultModel = settings.defaultModel;
  if (settings.advisorModel) config.advisorModel = settings.advisorModel;
  if (settings.availableModels) config.availableModels = settings.availableModels;
  if (settings.enforceAvailableModels !== undefined) config.enforceAvailableModels = settings.enforceAvailableModels;
  if (settings.fallbackModel) config.fallbackModel = settings.fallbackModel;
  if (settings.modelOverrides) config.modelOverrides = settings.modelOverrides;
  if (settings.timeout) config.timeout = settings.timeout;
  if (settings.maxRetries) config.maxRetries = settings.maxRetries;
  if (settings.logLevel) config.logLevel = settings.logLevel;
  if (settings.defaultHeaders) config.defaultHeaders = settings.defaultHeaders;
  if (settings.defaultQuery) config.defaultQuery = settings.defaultQuery;
  if (settings.fetchOptions) config.fetchOptions = settings.fetchOptions;
  if (settings.env) config.env = settings.env;

  // Debug logging
  if (process.env.DEBUG_CLAUDE_CONFIG) {
    console.error('[claude-config] Parsed settings:', JSON.stringify(config, null, 2));
  }

  // Override with environment variables (highest priority)
  if (process.env.ANTHROPIC_API_KEY) config.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_AUTH_TOKEN) config.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY) config.webhookKey = process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY;
  if (process.env.ANTHROPIC_PROFILE) config.profile = process.env.ANTHROPIC_PROFILE;
  if (process.env.ANTHROPIC_LOG) config.logLevel = process.env.ANTHROPIC_LOG as LogLevel;
  if (process.env.ANTHROPIC_TIMEOUT) config.timeout = parseInt(process.env.ANTHROPIC_TIMEOUT, 10);
  if (process.env.ANTHROPIC_MAX_RETRIES) config.maxRetries = parseInt(process.env.ANTHROPIC_MAX_RETRIES, 10);

  // Apply env variables from settings.env to process.env (if not already set)
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!process.env[key] && value) {
        process.env[key] = String(value);
        if (process.env.DEBUG_CLAUDE_CONFIG) {
          console.error(`[claude-config] Set env var: ${key}=${value}`);
        }
      }
    }
  }

  // NOW read from process.env (which now includes settings.env values)
  if (process.env.ANTHROPIC_BASE_URL) config.baseUrl = process.env.ANTHROPIC_BASE_URL;

  return config;
}

/**
 * Convert Claude config to Anthropic SDK config
 */
function toSdkConfig(config: ClaudeConfig): ClientOptions {
  const sdkConfig: ClientOptions = {
    baseURL: config.baseUrl || 'https://api.anthropic.com',
  };

  // Resolve authentication (in order of precedence)
  if (config.credentials) {
    sdkConfig.credentials = config.credentials;
  } else if (config.config) {
    sdkConfig.config = config.config;
  } else if (config.profile) {
    sdkConfig.profile = config.profile;
  } else if (config.authToken) {
    sdkConfig.authToken = config.authToken;
  } else if (config.apiKeyHelper) {
    // API helper will be resolved dynamically
    sdkConfig.apiKey = async () => resolveApiKeyHelper(config.apiKeyHelper!);
  } else if (config.apiKey) {
    sdkConfig.apiKey = config.apiKey;
  }

  // Add webhook key if present
  if (config.webhookKey) {
    sdkConfig.webhookKey = config.webhookKey;
  }

  // Add timeout if present
  if (config.timeout) {
    sdkConfig.timeout = config.timeout;
  }

  // Add max retries if present
  if (config.maxRetries) {
    sdkConfig.maxRetries = config.maxRetries;
  }

  // Add default headers if present
  if (config.defaultHeaders) {
    sdkConfig.defaultHeaders = config.defaultHeaders;
  }

  // Add default query if present
  if (config.defaultQuery) {
    sdkConfig.defaultQuery = config.defaultQuery;
  }

  // Add fetch options if present
  if (config.fetchOptions) {
    sdkConfig.fetchOptions = config.fetchOptions;
  }

  // Add log level if present
  if (config.logLevel) {
    sdkConfig.logLevel = config.logLevel;
  }

  // Add logger if present
  if (config.logger) {
    sdkConfig.logger = config.logger;
  }

  return sdkConfig;
}

/**
 * Resolve API key by executing helper command
 */
async function resolveApiKeyHelper(helper: ClaudeConfig['apiKeyHelper']): Promise<string> {
  let command: string;
  
  // Handle both string and object formats
  if (typeof helper === 'string') {
    command = helper;
  } else if (helper?.command) {
    command = helper.command;
  } else {
    throw new Error('API helper command not specified');
  }

  return new Promise((resolve, reject) => {
    // Use shell: true to handle shell operators like ||
    const helperProcess = spawn(command, {
      stdio: 'pipe',
      env: process.env,
      shell: true
    });

    let output = '';
    let errorOutput = '';

    helperProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    helperProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    helperProcess.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`API helper failed with code ${code}: ${errorOutput}`));
      }
    });

    helperProcess.on('error', (error) => {
      reject(error);
    });
  });
}

export default {
  resolveConfig,
  resolveApiKeyHelper
};

// Also export individually for direct imports
export { resolveApiKeyHelper };
