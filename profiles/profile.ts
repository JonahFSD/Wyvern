/**
 * profile.ts — The interface that makes Wyvern project-type-agnostic.
 *
 * A profile answers four questions:
 *   1. How do I verify a task succeeded?
 *   2. How do I generate context (the "pin") for workers?
 *   3. What additional lint rules apply?
 *   4. What are the default config values for this project type?
 *
 * The engine calls the profile — it never implements project-specific
 * logic itself. Web apps and research pipelines are peers, not
 * base-and-extension.
 */

import type { WyvernConfig, LintIssue } from '../engine/types.js';

/** A lint rule contributed by a profile. */
export interface ProfileLintRule {
  name: string;
  /** Return issues found, or empty array if clean. */
  check(content: string, filePath: string): LintIssue[];
}

/** A spec section parser contributed by a profile (for swarm). */
export interface SpecSectionParser {
  /** The H1 heading this parser handles (e.g., "Experiments", "Entities"). */
  sectionName: string;
  /** Parse the section body into structured data. */
  parse(body: string): unknown;
}

/**
 * The profile interface. Every project type implements this.
 * The engine loads the active profile from wyvern.config.json
 * and delegates all project-specific decisions to it.
 */
export interface WyvernProfile {
  /** Profile identifier (e.g., "web-app", "research-pipeline"). */
  name: string;

  /** Human-readable description. */
  description: string;

  /**
   * Default verify commands for this project type.
   * These are used when wyvern.config.json doesn't specify verifyCommands.
   * Supports ${file} interpolation for the current script/file under test.
   */
  defaultVerifyCommands: string[];

  /**
   * Generate a codebase index ("pin") for worker context injection.
   * Web apps scan for routes and exports. Research pipelines scan for
   * scripts, data sources, and artifact locations.
   */
  generatePin(projectRoot: string): Promise<string>;

  /**
   * Additional lint rules specific to this project type.
   * These run alongside the universal rules (required sections,
   * line counts, discovery language).
   */
  lintRules: ProfileLintRule[];

  /**
   * Spec section parsers for swarm mode.
   * Web apps register "Entities", "Pages", "Routes".
   * Research pipelines register "Experiments", "Data Sources", "Pipeline Stages".
   */
  specSections: SpecSectionParser[];

  /**
   * Default config values for this project type.
   * Merged under user-specified values in wyvern.config.json
   * (user config wins on conflict).
   */
  defaults: Partial<WyvernConfig>;
}

/** Load a profile by name. Throws if the profile doesn't exist. */
export async function loadProfile(name: string): Promise<WyvernProfile> {
  switch (name) {
    case 'web-app': {
      const { webAppProfile } = await import('./web-app.js');
      return webAppProfile;
    }
    case 'research-pipeline': {
      const { researchPipelineProfile } = await import('./research-pipeline.js');
      return researchPipelineProfile;
    }
    default:
      throw new Error(
        `Unknown profile: "${name}". Available profiles: web-app, research-pipeline`
      );
  }
}
