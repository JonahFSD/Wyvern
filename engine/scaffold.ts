import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export async function scaffoldTask(
  agentsDir: string,
  taskName: string,
  numPrompts: number,
  options?: { baseTemplate?: string },
): Promise<string> {
  const taskDir = join(agentsDir, taskName);

  try {
    await access(taskDir);
    throw new Error(`Task directory already exists: ${taskDir}`);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }

  await mkdir(taskDir, { recursive: true });

  // PLAN.md
  const planLines = [`# PLAN — ${taskName}`, '', '## Gate 1', ''];
  for (let i = 1; i <= numPrompts; i++) {
    const num = String(i).padStart(2, '0');
    planLines.push(`- [ ] Task ${num} — (describe)`);
  }
  planLines.push('');
  await writeFile(join(taskDir, 'PLAN.md'), planLines.join('\n'), 'utf-8');

  // context.md
  await writeFile(
    join(taskDir, 'context.md'),
    [
      '# Context — Inter-Task Notes',
      '',
      '<!-- Agents: read this at startup, append notes before finishing. -->',
      '<!-- This file carries knowledge between process kills. -->',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Load base template if specified
  let baseDirective = '';
  if (options?.baseTemplate) {
    const basePath = join(agentsDir, 'reusable', options.baseTemplate);
    try {
      await access(basePath);
      baseDirective = `{{base:${options.baseTemplate}}}\n\n`;
    } catch {
      // Base template doesn't exist; skip
    }
  }

  // Prompt templates
  const promptTemplate = `${baseDirective}### Context

<!-- What exists, what this builds on, relevant file paths. -->

### Goal

<!-- One sentence. What "done" looks like. -->

### Files to Modify

<!-- Explicit list. Agent should not touch anything else. -->

### Specific Changes

<!-- Precise instructions, code snippets if needed.
     File paths, line numbers, exact function names.
     If the agent has to make judgment calls, this prompt is too vague. -->

### DO NOT

<!-- Constraints and guardrails. What NOT to change, refactor, or violate. -->

### Verify

<!-- Build commands and manual checks.
     Agent runs these before marking complete. -->
`;

  for (let i = 1; i <= numPrompts; i++) {
    const num = String(i).padStart(2, '0');
    await writeFile(join(taskDir, `prompt-${num}.md`), promptTemplate, 'utf-8');
  }

  return taskDir;
}

export function formatScaffoldResult(taskDir: string, taskName: string, numPrompts: number): string {
  return [
    `Created ${taskDir}`,
    '',
    'Contents:',
    '  PLAN.md',
    '  context.md',
    ...Array.from({ length: numPrompts }, (_, i) =>
      `  prompt-${String(i + 1).padStart(2, '0')}.md`
    ),
    '',
    'Next steps:',
    `  1. Fill in prompts with specific instructions`,
    `  2. Update PLAN.md with task descriptions`,
    `  3. Run: npm run wyvern -- run ${taskDir}`,
  ].join('\n');
}
