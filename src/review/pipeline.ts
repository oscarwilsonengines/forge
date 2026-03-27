import { spawn as cpSpawn, execSync } from "node:child_process";
import {
  writeFileSync, readFileSync, existsSync, mkdirSync, openSync,
} from "node:fs";
import { join } from "node:path";
import type { Finding, ForgeConfig } from "../types.js";
import { FindingSchema } from "../types.js";
import { buildReviewPrompt } from "./prompts.js";
import { isProcessAlive } from "../execution/platform.js";
import { log } from "../utils/logger.js";

interface ReviewOptions {
  projectRoot: string;
  repoFullName: string;
  branch: string;
  model: string;
  reviewTypes: string[];
  confidenceThreshold: number;
  forgeDir: string;
}

interface ReviewerProcess {
  type: string;
  pid: number | undefined;
  outputPath: string;
}

export class ReviewPipeline {
  /** Run all reviewers in parallel, collect and deduplicate findings */
  async runReviews(opts: ReviewOptions): Promise<Finding[]> {
    mkdirSync(join(opts.forgeDir, "reviews"), { recursive: true });
    mkdirSync(join(opts.forgeDir, "outputs"), { recursive: true });
    mkdirSync(join(opts.forgeDir, "prompts"), { recursive: true });

    log.info(`Spawning ${opts.reviewTypes.length} reviewers...`);

    // Spawn all reviewers
    const reviewers: ReviewerProcess[] = [];
    for (const type of opts.reviewTypes) {
      const proc = this.spawnReviewer(type, opts);
      reviewers.push(proc);
      log.info(`  Reviewer: ${type} (PID ${proc.pid})`);
    }

    // Poll until all complete (max 15 minutes)
    const allFindings = await this.pollReviewers(reviewers, 15 * 60 * 1000);

    // Filter by confidence
    const filtered = allFindings.filter(
      (f) => f.confidence >= opts.confidenceThreshold,
    );

    // Deduplicate by file:line overlap
    const deduped = this.deduplicateFindings(filtered);

    // Sort by severity
    const severityOrder: Record<string, number> = {
      critical: 0, high: 1, medium: 2, low: 3,
    };
    deduped.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // Save each category
    for (const type of opts.reviewTypes) {
      const categoryFindings = deduped.filter((f) => f.category === type);
      writeFileSync(
        join(opts.forgeDir, "reviews", `${type}.json`),
        JSON.stringify(categoryFindings, null, 2),
      );
    }

    return deduped;
  }

  /** Spawn a single reviewer as a detached claude -p process */
  private spawnReviewer(type: string, opts: ReviewOptions): ReviewerProcess {
    const promptPath = join(opts.forgeDir, "prompts", `reviewer-${type}.md`);
    const outputPath = join(opts.forgeDir, "outputs", `reviewer-${type}.json`);
    const errPath = join(opts.forgeDir, "outputs", `reviewer-${type}.err`);

    const prompt = buildReviewPrompt(type, opts.repoFullName, opts.branch);
    writeFileSync(promptPath, prompt);

    const outFd = openSync(outputPath, "w");
    const errFd = openSync(errPath, "w");

    const claudePath = this.resolveClaudePath();
    const child = cpSpawn(claudePath, [
      "-p", prompt,
      "--model", opts.model,
      "--max-turns", "10",
      "--output-format", "json",
    ], {
      cwd: opts.projectRoot,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
    child.unref();

    return { type, pid: child.pid, outputPath };
  }

  /** Poll reviewers until all complete or timeout */
  private async pollReviewers(
    reviewers: ReviewerProcess[],
    timeoutMs: number,
  ): Promise<Finding[]> {
    const startTime = Date.now();
    const completed = new Set<string>();
    const allFindings: Finding[] = [];

    while (completed.size < reviewers.length) {
      if (Date.now() - startTime > timeoutMs) {
        log.warn("Review timeout — some reviewers did not finish");
        break;
      }

      for (const reviewer of reviewers) {
        if (completed.has(reviewer.type)) continue;

        const alive = reviewer.pid ? isProcessAlive(reviewer.pid) : false;
        if (!alive) {
          // Process finished — read output
          const findings = this.parseReviewOutput(reviewer.outputPath);
          allFindings.push(...findings);
          completed.add(reviewer.type);
          log.info(`  Reviewer ${reviewer.type}: ${findings.length} findings`);
        }
      }

      if (completed.size < reviewers.length) {
        await new Promise((r) => setTimeout(r, 5_000)); // Poll every 5s
      }
    }

    return allFindings;
  }

  /** Parse JSON output from a reviewer process */
  private resolveClaudePath(): string {
    try {
      const cmd = process.platform === "win32" ? "where claude" : "which claude";
      return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0];
    } catch {
      return "claude";
    }
  }

  private parseReviewOutput(outputPath: string): Finding[] {
    try {
      if (!existsSync(outputPath)) return [];
      const raw = readFileSync(outputPath, "utf-8").trim();
      if (!raw) return [];

      // claude -p --output-format json wraps the result
      let content = raw;
      try {
        const parsed = JSON.parse(raw);
        content = parsed.result || raw;
      } catch { /* not JSON wrapper — try raw */ }

      // Find the JSON array in the content
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) return [];

      const arr = JSON.parse(match[0]);
      if (!Array.isArray(arr)) return [];

      // Validate each finding
      return arr.filter((item: unknown) => {
        try {
          FindingSchema.parse(item);
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  /** Deduplicate findings by file:line overlap */
  private deduplicateFindings(findings: Finding[]): Finding[] {
    const result: Finding[] = [];

    for (const finding of findings) {
      const duplicate = result.find(
        (f) =>
          f.file === finding.file &&
          Math.abs(f.line_start - finding.line_start) <= 3 &&
          Math.abs(f.line_end - finding.line_end) <= 3,
      );

      if (duplicate) {
        // Keep the one with higher confidence
        if (finding.confidence > duplicate.confidence) {
          const idx = result.indexOf(duplicate);
          result[idx] = finding;
        }
      } else {
        result.push(finding);
      }
    }

    return result;
  }

  /** Generate a markdown checklist from findings */
  generateChecklist(findings: Finding[]): string {
    if (findings.length === 0) {
      return "## Review Checklist\n\nNo findings above confidence threshold. Code looks good!";
    }

    const sections: Record<string, Finding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const f of findings) {
      sections[f.severity].push(f);
    }

    const icons: Record<string, string> = {
      critical: "CRITICAL",
      high: "HIGH",
      medium: "MEDIUM",
      low: "LOW",
    };

    let md = "## Review Checklist\n\n";

    for (const [severity, items] of Object.entries(sections)) {
      if (items.length === 0) continue;
      md += `### ${icons[severity]} (${items.length} items)\n\n`;
      for (const f of items) {
        md += `- [ ] **${f.file}:${f.line_start}-${f.line_end}** [${f.category}] ${f.title}\n`;
        md += `  ${f.suggestion}\n\n`;
      }
    }

    return md;
  }

  /** Save checklist to file */
  saveChecklist(forgeDir: string, checklist: string): string {
    const path = join(forgeDir, "REVIEW_CHECKLIST.md");
    writeFileSync(path, checklist);
    return path;
  }
}
