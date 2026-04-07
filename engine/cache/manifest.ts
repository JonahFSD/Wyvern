import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

export interface ManifestInputs {
  promptContent: string;
  relevantFileHashes: string;
  model: string;
  configHash: string;
  dependencyOutputHashes: Record<string, string>;
}

export function computeManifestHash(inputs: ManifestInputs): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function getRelevantFileHashes(projectRoot: string, touchesFiles: string[]): string {
  if (touchesFiles.length === 0) {
    return crypto.createHash('sha256').update('no-files').digest('hex');
  }

  const paths = touchesFiles.sort().join(' ');
  try {
    const output = execSync(`git ls-tree HEAD -- ${paths}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    return crypto.createHash('sha256').update(output).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(`new:${paths}`).digest('hex');
  }
}

export function computeConfigHash(config: Record<string, unknown>): string {
  const relevant = {
    verifyCommands: config.verifyCommands,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(relevant, Object.keys(relevant).sort()))
    .digest('hex');
}
