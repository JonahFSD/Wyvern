import type { WyvernConfig } from './types.js';

export const DEFAULT_VERIFY_COMMANDS = ['npm run build', 'npm run lint'];

export function getVerifyCommands(config: Pick<WyvernConfig, 'verifyCommands'>): string[] {
  const commands = config.verifyCommands
    .map(command => command.trim())
    .filter(command => command.length > 0);

  return commands.length > 0 ? commands : [...DEFAULT_VERIFY_COMMANDS];
}

export function formatVerifyCommandSequence(commands: string[]): string {
  return commands.join(' && ');
}
