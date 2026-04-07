/**
 * wyvern.ts — The brain of the swarm. Reads a structured spec file,
 * identifies domains, generates foundations, and produces a full
 * SwarmPlan with typed tasks, dependency chains, and cost estimates.
 *
 * Wyvern doesn't call Claude or any LLM. It's a deterministic parser
 * that transforms a structured spec (YAML frontmatter + Markdown)
 * into a SwarmPlan. The intelligence lives in the spec format and
 * the conventions docs, not in this code.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  SwarmPlan, SwarmTask, Domain, Foundation, ParsedSpec,
  SpecSection, Entity, EntityField, PageSpec,
} from './types.js';
import { MODEL_COSTS, ESTIMATED_TOKENS_PER_TASK } from './types.js';
import type { ModelTier } from '../engine/types.js';
import { validateGraph, findCriticalPath, computeStats } from './dependency-graph.js';

// ─── Spec Parsing ───────────────────────────────────────────────

/**
 * Parse a structured spec file into a SwarmPlan.
 *
 * Spec format:
 * ```
 * ---
 * project: my-app
 * domains:
 *   - name: frontend
 *     paths: [src/app/, src/components/]
 *     lead_model: sonnet
 *   - name: backend
 *     paths: [server/, src/types/]
 *     lead_model: sonnet
 * ---
 *
 * # Foundations
 * ## globals.css @haiku
 * Update design tokens...
 *
 * # Entities
 * ## User
 * - email: string (required)
 * - name: string (required)
 * ...
 *
 * # Tasks
 * ## T01 — Define database schema @sonnet [backend] [tier:1] [blocked_by:] [files:server/schema.ts] [exports:schema] [est:10]
 * Full task description here...
 * ```
 */
export async function parseSpec(specPath: string): Promise<ParsedSpec> {
  const raw = await readFile(resolve(specPath), 'utf-8');
  const { frontmatter, body } = splitFrontmatter(raw);

  return {
    project: typeof frontmatter.project === 'string' ? frontmatter.project : 'unnamed',
    sections: parseSections(body),
    entities: parseEntities(body),
    integrations: parseIntegrations(body),
    pages: parsePages(body),
  };
}

/** Split YAML frontmatter from markdown body. */
function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const fm = parseSimpleYaml(match[1]);
  return { frontmatter: fm, body: match[2] };
}

/**
 * Minimal YAML parser — handles the flat key-value and simple list
 * structures we need. No external deps.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentList: Record<string, unknown>[] = [];
  let inList = false;
  let listItem: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (kvMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (inList && currentKey) {
        if (Object.keys(listItem).length > 0) currentList.push(listItem);
        result[currentKey] = currentList;
        inList = false;
        currentList = [];
        listItem = {};
      }
      result[kvMatch[1]] = kvMatch[2];
      continue;
    }

    // Top-level key with no inline value (start of list or object)
    const keyOnlyMatch = trimmed.match(/^(\w+):$/);
    if (keyOnlyMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (inList && currentKey) {
        if (Object.keys(listItem).length > 0) currentList.push(listItem);
        result[currentKey] = currentList;
      }
      currentKey = keyOnlyMatch[1];
      currentList = [];
      listItem = {};
      inList = true;
      continue;
    }

    // List item start
    if (inList && trimmed.startsWith('- ')) {
      if (Object.keys(listItem).length > 0) {
        currentList.push(listItem);
        listItem = {};
      }
      const itemContent = trimmed.slice(2).trim();
      const itemKv = itemContent.match(/^(\w+):\s*(.+)$/);
      if (itemKv) {
        listItem[itemKv[1]] = parseYamlValue(itemKv[2]);
      } else {
        listItem['_value'] = itemContent;
      }
      continue;
    }

    // Nested key in list item
    if (inList && (line.startsWith('    ') || line.startsWith('\t\t'))) {
      const nestedKv = trimmed.match(/^(\w+):\s*(.+)$/);
      if (nestedKv) {
        listItem[nestedKv[1]] = parseYamlValue(nestedKv[2]);
      }
    }
  }

  // Flush remaining list
  if (inList && currentKey) {
    if (Object.keys(listItem).length > 0) currentList.push(listItem);
    result[currentKey] = currentList;
  }

  return result;
}

function parseYamlValue(val: string): unknown {
  // Array: [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    return val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  // Number
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  // Boolean
  if (val === 'true') return true;
  if (val === 'false') return false;
  return val;
}

/** Parse markdown into a section tree. */
function parseSections(body: string): SpecSection[] {
  const lines = body.split('\n');
  const rootSections: SpecSection[] = [];
  const stack: { section: SpecSection; level: number }[] = [];

  let contentBuffer: string[] = [];

  function flushContent(): void {
    if (stack.length > 0 && contentBuffer.length > 0) {
      stack[stack.length - 1].section.content = contentBuffer.join('\n').trim();
      contentBuffer = [];
    }
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushContent();
      const level = headingMatch[1].length;
      const section: SpecSection = {
        title: headingMatch[2].trim(),
        level,
        content: '',
        subsections: [],
      };

      // Pop stack to find parent
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        rootSections.push(section);
      } else {
        stack[stack.length - 1].section.subsections.push(section);
      }

      stack.push({ section, level });
    } else {
      contentBuffer.push(line);
    }
  }

  flushContent();
  return rootSections;
}

/** Extract entity definitions from the spec body. */
function parseEntities(body: string): Entity[] {
  const entities: Entity[] = [];
  const entitySection = extractSection(body, 'Entities') ?? extractSection(body, 'Data Model');
  if (!entitySection) return entities;

  const entityBlocks = entitySection.split(/^##\s+/m).filter(Boolean);
  for (const block of entityBlocks) {
    const lines = block.split('\n');
    const name = lines[0].trim();
    if (!name) continue;

    const fields: EntityField[] = [];
    const relationships: Entity['relationships'] = [];

    for (const line of lines.slice(1)) {
      const fieldMatch = line.match(/^-\s+(\w+):\s*(\w+)(?:\s*\(([^)]*)\))?(?:\s*—\s*(.+))?$/);
      if (fieldMatch) {
        const required = fieldMatch[3]?.includes('required') ?? false;
        fields.push({
          name: fieldMatch[1],
          type: fieldMatch[2],
          required,
          description: fieldMatch[4]?.trim(),
        });
      }

      const relMatch = line.match(/^-\s+→\s+(\w+)\s+(one-to-one|one-to-many|many-to-many)\s+via\s+(\w+)/);
      if (relMatch) {
        relationships.push({
          target: relMatch[1],
          type: relMatch[2] as 'one-to-one' | 'one-to-many' | 'many-to-many',
          field: relMatch[3],
        });
      }
    }

    if (fields.length > 0) {
      entities.push({ name, fields, relationships });
    }
  }

  return entities;
}

/** Extract integration names from the spec. */
function parseIntegrations(body: string): string[] {
  const section = extractSection(body, 'Integrations') ?? extractSection(body, 'Third-Party');
  if (!section) return [];

  const integrations: string[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^[-*]\s+\*?\*?(\w[\w\s]*\w)\*?\*?/);
    if (match) integrations.push(match[1].trim());
  }
  return integrations;
}

/** Extract page definitions from the spec. */
function parsePages(body: string): PageSpec[] {
  const section = extractSection(body, 'Pages') ?? extractSection(body, 'Routes');
  if (!section) return [];

  const pages: PageSpec[] = [];
  const blocks = section.split(/^##\s+/m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const headerMatch = lines[0].match(/^(.+?)\s+\[(.+?)\]\s*(?:\[(.+?)\])?/);
    if (!headerMatch) continue;

    const dataNeeds: string[] = [];
    for (const line of lines.slice(1)) {
      const needMatch = line.match(/^-\s+needs:\s*(.+)/);
      if (needMatch) {
        dataNeeds.push(...needMatch[1].split(',').map(s => s.trim()));
      }
    }

    pages.push({
      route: headerMatch[2],
      name: headerMatch[1].trim(),
      description: lines.slice(1).join('\n').trim(),
      domain: headerMatch[3] ?? 'frontend',
      dataNeeds,
    });
  }

  return pages;
}

/** Extract a named section from markdown by its heading. */
function extractSection(body: string, heading: string): string | null {
  const regex = new RegExp(`^#\\s+${heading}\\b.*$`, 'mi');
  const match = body.match(regex);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const nextHeading = body.slice(start).match(/^#\s+/m);
  const end = nextHeading?.index !== undefined ? start + nextHeading.index : body.length;
  return body.slice(start, end).trim();
}

// ─── Task Parsing ───────────────────────────────────────────────

/**
 * Parse explicit task definitions from the spec body.
 *
 * Task format:
 * ## T01 — Description @model [domain] [tier:N] [blocked_by:T00,T01] [files:path1,path2] [exports:name1] [est:10]
 * Detailed description...
 */
export function parseTasks(body: string): SwarmTask[] {
  const tasks: SwarmTask[] = [];
  const taskSection = extractSection(body, 'Tasks');
  if (!taskSection) return tasks;

  const blocks = taskSection.split(/^##\s+/m).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];

    const idMatch = header.match(/^(T\d+)\s*[—–-]\s*/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const afterId = header.slice(idMatch[0].length);

    const modelMatch = afterId.match(/@(opus|sonnet|haiku)/i);
    const domainMatch = afterId.match(/\[(\w+)\]/);
    const tierMatch = afterId.match(/\[tier:(\d+)\]/);
    const blockedMatch = afterId.match(/\[blocked_by:([\w,]*)\]/);
    const filesMatch = afterId.match(/\[files:([^\]]+)\]/);
    const exportsMatch = afterId.match(/\[exports:([^\]]+)\]/);
    const estMatch = afterId.match(/\[est:(\d+)\]/);

    // Description is everything before the first bracket
    const descMatch = afterId.match(/^([^[@\[]+)/);
    const description = descMatch ? descMatch[1].trim() : afterId.trim();

    tasks.push({
      id,
      description,
      domain: domainMatch ? domainMatch[1] : 'shared',
      tier: tierMatch ? parseInt(tierMatch[1], 10) : 0,
      model: (modelMatch ? modelMatch[1].toLowerCase() : 'sonnet') as ModelTier,
      blockedBy: blockedMatch && blockedMatch[1]
        ? blockedMatch[1].split(',').filter(Boolean)
        : [],
      touchesFiles: filesMatch
        ? filesMatch[1].split(',').map(s => s.trim())
        : [],
      exports: exportsMatch
        ? exportsMatch[1].split(',').map(s => s.trim())
        : [],
      estimatedMinutes: estMatch ? parseInt(estMatch[1], 10) : 5,
    });
  }

  return tasks;
}

/** Parse foundation definitions from the spec. */
function parseFoundations(body: string): Foundation[] {
  const foundations: Foundation[] = [];
  const section = extractSection(body, 'Foundations');
  if (!section) return foundations;

  const blocks = section.split(/^##\s+/m).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    const modelMatch = header.match(/@(opus|sonnet|haiku)/i);
    const fileMatch = header.match(/`([^`]+)`/) ?? header.match(/^(\S+)/);

    foundations.push({
      file: fileMatch ? fileMatch[1] : header.trim(),
      description: lines.slice(1).join('\n').trim(),
      contentSpec: lines.slice(1).join('\n').trim(),
      model: (modelMatch ? modelMatch[1].toLowerCase() : 'haiku') as ModelTier,
    });
  }

  return foundations;
}

/** Parse domain definitions from frontmatter. */
function parseDomains(frontmatter: Record<string, unknown>): Domain[] {
  const rawDomains = frontmatter.domains as Record<string, unknown>[] | undefined;
  if (!rawDomains) return [];

  return rawDomains.map(d => ({
    name: (d.name as string) ?? 'unknown',
    description: (d.description as string) ?? '',
    ownedPaths: Array.isArray(d.paths) ? d.paths as string[] : [],
    leadModel: ((d.lead_model as string) ?? 'sonnet') as ModelTier,
  }));
}

// ─── Cost Estimation ────────────────────────────────────────────

/** Estimate total cost for a set of tasks + domain lead sessions. */
export function estimateCost(tasks: SwarmTask[], domains: Domain[]): number {
  let total = 0;

  // Worker costs
  for (const task of tasks) {
    const tokens = ESTIMATED_TOKENS_PER_TASK[task.model];
    const rates = MODEL_COSTS[task.model];
    total += (tokens.input / 1_000_000) * rates.input;
    total += (tokens.output / 1_000_000) * rates.output;
  }

  // Domain lead costs (sonnet, long-running)
  for (const domain of domains) {
    const tokens = { input: 500_000, output: 100_000 }; // heuristic for lead session
    const rates = MODEL_COSTS[domain.leadModel];
    total += (tokens.input / 1_000_000) * rates.input;
    total += (tokens.output / 1_000_000) * rates.output;
  }

  // Wyvern Prime cost (opus, one-shot)
  const wyvernTokens = { input: 200_000, output: 50_000 };
  total += (wyvernTokens.input / 1_000_000) * MODEL_COSTS.opus.input;
  total += (wyvernTokens.output / 1_000_000) * MODEL_COSTS.opus.output;

  return Math.round(total * 100) / 100;
}

// ─── Main Entry Point ───────────────────────────────────────────

/** Read a spec file and produce a complete SwarmPlan. */
export async function generateSwarmPlan(specPath: string): Promise<SwarmPlan> {
  const raw = await readFile(resolve(specPath), 'utf-8');
  const { frontmatter, body } = splitFrontmatter(raw);

  const project = (frontmatter.project as string) ?? 'unnamed';
  const domains = parseDomains(frontmatter);
  const foundations = parseFoundations(body);
  const tasks = parseTasks(body);

  // Validate the graph
  const validation = validateGraph(tasks);
  if (!validation.valid) {
    const errorList = validation.errors.join('\n  - ');
    throw new Error(`Invalid dependency graph:\n  - ${errorList}`);
  }

  const criticalPath = findCriticalPath(tasks);
  const stats = computeStats(tasks);
  const estimatedCost = estimateCost(tasks, domains);
  const mergeOrder = (frontmatter.mergeOrder as string[]) ?? domains.map(d => d.name);

  return {
    project,
    domains,
    foundations,
    tasks,
    estimatedCost,
    criticalPath,
    mergeOrder,
    stats,
  };
}

/** Format a SwarmPlan for human review before execution. */
export function formatSwarmPlan(plan: SwarmPlan): string {
  const lines: string[] = [
    `SWARM PLAN: ${plan.project}`,
    '='.repeat(60),
    '',
    `Domains: ${plan.domains.map(d => d.name).join(', ')}`,
    `Total tasks: ${plan.stats.totalTasks}`,
    `Estimated cost: $${plan.estimatedCost.toFixed(2)}`,
    `Estimated time (critical path): ${plan.stats.estimatedMinutes} min`,
    `Max parallelism: ${plan.stats.maxParallelism} concurrent tasks`,
    '',
    'Tasks by tier:',
  ];

  for (const [tier, count] of Object.entries(plan.stats.tasksByTier)) {
    lines.push(`  Tier ${tier}: ${count} tasks`);
  }

  lines.push('', 'Tasks by domain:');
  for (const [domain, count] of Object.entries(plan.stats.tasksByDomain)) {
    lines.push(`  ${domain}: ${count} tasks`);
  }

  lines.push('', 'Tasks by model:');
  for (const [model, count] of Object.entries(plan.stats.tasksByModel)) {
    lines.push(`  @${model}: ${count} tasks`);
  }

  lines.push('', `Critical path: ${plan.criticalPath.join(' → ')}`);

  if (plan.foundations.length > 0) {
    lines.push('', 'Foundations (Tier 0):');
    for (const f of plan.foundations) {
      lines.push(`  ${f.file} @${f.model} — ${f.description.split('\n')[0]}`);
    }
  }

  lines.push('', '-'.repeat(60), '', 'Full task list:', '');

  const byTier = new Map<number, SwarmTask[]>();
  for (const task of plan.tasks) {
    const list = byTier.get(task.tier) || [];
    list.push(task);
    byTier.set(task.tier, list);
  }

  for (const tier of Array.from(byTier.keys()).sort((a, b) => a - b)) {
    lines.push(`TIER ${tier}`);
    const tierTasks = byTier.get(tier)!;
    const byDomain = new Map<string, SwarmTask[]>();
    for (const t of tierTasks) {
      const list = byDomain.get(t.domain) || [];
      list.push(t);
      byDomain.set(t.domain, list);
    }
    for (const [domain, domainTasks] of byDomain) {
      lines.push(`  [${domain}]`);
      for (const t of domainTasks) {
        const deps = t.blockedBy.length > 0 ? ` ← ${t.blockedBy.join(', ')}` : '';
        lines.push(`    ${t.id} @${t.model} — ${t.description}${deps}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
