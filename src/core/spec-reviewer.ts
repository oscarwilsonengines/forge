import { execSync, spawnSync } from "node:child_process";
import type { Task } from "../types.js";
import { buildSpecReviewPrompt } from "../review/prompts.js";
import { log } from "../utils/logger.js";

export interface SpecReviewResult {
  pass: boolean;
  reasons: string[];
}

export class SpecReviewer {
  private claudePath: string;

  constructor(private model: string = "haiku") {
    this.claudePath = this.resolveClaudePath();
  }

  /** Review a completed task's changes against its acceptance criteria */
  async review(task: Task, projectRoot: string): Promise<SpecReviewResult> {
    const { diff, error } = this.getDiff(projectRoot);
    if (error) return { pass: false, reasons: [`Git diff failed: ${error}`] };
    if (!diff) return { pass: false, reasons: ["No changes detected — diff is empty (check branch or working directory)"] };

    const prompt = buildSpecReviewPrompt(task, diff);

    try {
      const result = spawnSync(this.claudePath, [
        "-p", prompt,
        "--model", this.model,
        "--max-turns", "5",
        "--output-format", "json",
        "--permission-mode", "bypassPermissions",
      ], {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 120_000,
      });

      if (result.error) throw result.error;
      return this.parseResult(result.stdout);
    } catch (err) {
      log.warn(`Spec review failed for ${task.id}: ${err}`);
      return { pass: false, reasons: [`Review process error: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  private getDiff(projectRoot: string): { diff: string; error?: string } {
    try {
      const result = execSync("git diff main --no-color", {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 30_000,
      }).trim();
      return { diff: result };
    } catch (err) {
      return { diff: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private parseResult(raw: string): SpecReviewResult {
    try {
      let content = raw;
      try {
        const envelope = JSON.parse(raw);
        if (typeof envelope.result === "string") content = envelope.result;
      } catch { /* raw text */ }

      const match = content.match(/\{[\s\S]*"pass"[\s\S]*\}/);
      if (!match) return { pass: true, reasons: ["Could not parse review output"] };

      const parsed = JSON.parse(match[0]) as SpecReviewResult;
      return {
        pass: Boolean(parsed.pass),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      };
    } catch {
      return { pass: true, reasons: ["Could not parse review output"] };
    }
  }

  private resolveClaudePath(): string {
    try {
      const cmd = process.platform === "win32" ? "where claude" : "which claude";
      return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0];
    } catch {
      return "claude";
    }
  }
}
