import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WyvernConfig } from './types.js';
import { DEFAULT_VERIFY_COMMANDS } from './verification.js';

const CONFIG_PATHS = [
  'wyvern.config.json',
  join('cmdctrl', 'wyvern.config.json'),
];

export const DEFAULT_CONFIG: WyvernConfig = {
  pollInterval: 5,
  killDelay: 3,
  watchdogTimeout: 900,
  maxPromptLines: { min: 8, max: 80 },
  defaultModel: 'opus',
  verifyCommands: [...DEFAULT_VERIFY_COMMANDS],
  enableSnapshots: true,
  enableCostTracking: true,
  enableOutputCapture: true,
  parallelTasksPerGate: 4,
  mcpPort: 3001,
  budgetLimitUsd: undefined,
  modelConfig: {
    opus: { maxPromptLines: { min: 8, max: 80 } },
    sonnet: { maxPromptLines: { min: 8, max: 120 } },
    haiku: { maxPromptLines: { min: 4, max: 60 } },
  },
};

export async function loadConfig(projectRoot: string): Promise<WyvernConfig> {
  for (const relativePath of CONFIG_PATHS) {
    const configPath = join(projectRoot, relativePath);
    try {
      const raw = await readFile(configPath, 'utf-8');
      const userConfig = JSON.parse(raw) as Partial<WyvernConfig>;
      return mergeConfig(DEFAULT_CONFIG, userConfig);
    } catch {
      continue;
    }
  }

  return {
    ...DEFAULT_CONFIG,
    verifyCommands: [...DEFAULT_CONFIG.verifyCommands],
  };
}

function mergeConfig(defaults: WyvernConfig, overrides: Partial<WyvernConfig>): WyvernConfig {
  const merged: WyvernConfig = {
    ...defaults,
    verifyCommands: [...defaults.verifyCommands],
    modelConfig: {
      opus: { maxPromptLines: { ...defaults.modelConfig.opus.maxPromptLines } },
      sonnet: { maxPromptLines: { ...defaults.modelConfig.sonnet.maxPromptLines } },
      haiku: { maxPromptLines: { ...defaults.modelConfig.haiku.maxPromptLines } },
    },
  };

  for (const key of Object.keys(overrides) as Array<keyof WyvernConfig>) {
    const val = overrides[key];
    if (val === undefined) continue;

    if (key === 'maxPromptLines' && typeof val === 'object' && val !== null) {
      merged.maxPromptLines = { ...defaults.maxPromptLines, ...val as { min: number; max: number } };
    } else if (key === 'modelConfig' && typeof val === 'object' && val !== null) {
      const modelConfig = val as Partial<WyvernConfig['modelConfig']>;
      for (const model of Object.keys(defaults.modelConfig) as Array<keyof WyvernConfig['modelConfig']>) {
        const override = modelConfig[model];
        if (!override) continue;
        merged.modelConfig[model] = {
          maxPromptLines: {
            ...defaults.modelConfig[model].maxPromptLines,
            ...override.maxPromptLines,
          },
        };
      }
    } else if (key === 'verifyCommands' && Array.isArray(val)) {
      merged.verifyCommands = val
        .map(command => String(command).trim())
        .filter(command => command.length > 0);
    } else {
      (merged as unknown as Record<string, unknown>)[key] = val;
    }
  }

  return merged;
}
