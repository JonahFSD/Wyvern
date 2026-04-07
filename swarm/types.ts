/**
 * Swarm types — extends Wyvern's base types for multi-domain orchestration.
 * These types describe the spec → DAG → Agent Teams pipeline.
 */

import type { ModelTier } from '../engine/types.js';

/** A domain is a vertical slice of the codebase with clear file ownership. */
export interface Domain {
  name: string;
  description: string;
  /** Directories this domain owns. Glob patterns. */
  ownedPaths: string[];
  /** Model tier for the domain lead session. */
  leadModel: ModelTier;
  /** Git branch name for this domain. Defaults to `domain/{name}`. */
  branch?: string;
}

/** A single task in the dependency graph. */
export interface SwarmTask {
  id: string;
  description: string;
  domain: string;
  tier: number;
  model: ModelTier;
  /** Task IDs this task is blocked by. Empty = immediately available. */
  blockedBy: string[];
  /** Files this task creates or modifies. For conflict detection. */
  touchesFiles: string[];
  /** What this task exports for other tasks to consume (type names, API routes, etc.) */
  exports: string[];
  /** Estimated duration in minutes. Used for scheduling, not enforced. */
  estimatedMinutes: number;
}

/** A foundation file written in Tier 0 before any domain work begins. */
export interface Foundation {
  file: string;
  description: string;
  /** Content specification — what goes in this file. */
  contentSpec: string;
  model: ModelTier;
}

/** The full dependency graph output by Wyvern. */
export interface SwarmPlan {
  /** Project name, pulled from spec. */
  project: string;
  /** All domains identified in the spec. */
  domains: Domain[];
  /** Foundation files (Tier 0). Written before domain work starts. */
  foundations: Foundation[];
  /** All tasks across all domains and tiers. */
  tasks: SwarmTask[];
  /** Budget estimate in USD. */
  estimatedCost: number;
  /** Critical path — the longest chain of sequential dependencies. */
  criticalPath: string[];
  /** Deterministic order for merging domains back to main. */
  mergeOrder: string[];
  /** Summary stats. */
  stats: {
    totalTasks: number;
    tasksByTier: Record<number, number>;
    tasksByDomain: Record<string, number>;
    tasksByModel: Record<string, number>;
    maxParallelism: number;
    estimatedMinutes: number;
  };
}

/** Parsed spec structure — what Wyvern extracts from the spec file. */
export interface ParsedSpec {
  project: string;
  /** Top-level sections found in the spec. */
  sections: SpecSection[];
  /** Data model entities extracted. */
  entities: Entity[];
  /** Third-party integrations mentioned. */
  integrations: string[];
  /** Pages/routes defined. */
  pages: PageSpec[];
}

export interface SpecSection {
  title: string;
  level: number;
  content: string;
  subsections: SpecSection[];
}

export interface Entity {
  name: string;
  fields: EntityField[];
  relationships: EntityRelationship[];
}

export interface EntityField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface EntityRelationship {
  target: string;
  type: 'one-to-one' | 'one-to-many' | 'many-to-many';
  field: string;
}

export interface PageSpec {
  route: string;
  name: string;
  description: string;
  /** Which domain this page belongs to. */
  domain: string;
  /** What backend queries/mutations this page needs. */
  dataNeeds: string[];
}

/** Model cost rates per million tokens. */
export const MODEL_COSTS: Record<ModelTier, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.80, output: 4 },
};

/** Estimated tokens per task by model tier (rough heuristic). */
export const ESTIMATED_TOKENS_PER_TASK: Record<ModelTier, { input: number; output: number }> = {
  opus: { input: 200_000, output: 50_000 },
  sonnet: { input: 200_000, output: 50_000 },
  haiku: { input: 100_000, output: 30_000 },
};
