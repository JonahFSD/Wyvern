import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function generateSandboxProfile(
  worktreePath: string,
  allowedPaths: string[],
): string {
  const profilePath = join(worktreePath, '.wyvern-sandbox.sb');

  const allowRules = allowedPaths.map(p =>
    `(allow file-write* (subpath "${join(worktreePath, p)}"))`
  ).join('\n');

  const profile = `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow network*)

;; Read anywhere
(allow file-read*)

;; Write only to allowed paths within the worktree
${allowRules}

;; Allow tmp writes
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))

;; Allow writes to wyvern state directory
(allow file-write* (subpath "${join(worktreePath, '.wyvern')}"))`;

  writeFileSync(profilePath, profile);
  return profilePath;
}
