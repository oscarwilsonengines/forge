import { execSync, execFileSync } from "node:child_process";
import type { Task, ForgeConfig } from "../types.js";

// ─── GitHub Manager ────────────────────────────────────────────

/**
 * Manages GitHub resources (repos, issues, labels) via the `gh` CLI.
 *
 * Every shell interaction goes through the private `gh()` helper so
 * error handling and encoding are consistent across all operations.
 */
export class GitHubManager {
  constructor(private config: ForgeConfig["github"]) {}

  // ── Shell helper ───────────────────────────────────────────────

  /**
   * Run a `gh` CLI command and return trimmed stdout.
   * Throws a descriptive error on non-zero exit.
   */
  private cwd?: string;

  /** Set working directory for gh commands (important for repo detection) */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  private gh(...args: string[]): string {
    try {
      const result = execFileSync("gh", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        cwd: this.cwd,
      });
      return result.trim();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new Error(`gh command failed: gh ${args.join(" ")}\n${msg}`);
    }
  }

  // ── Issues ─────────────────────────────────────────────────────

  /** Create a GitHub Issue for a task. Returns the issue number. */
  createIssue(repo: string, task: Task): number {
    const bodyLines: string[] = [];

    bodyLines.push(`## Description`);
    bodyLines.push(task.description);
    bodyLines.push("");

    if (task.acceptance_criteria.length > 0) {
      bodyLines.push(`## Acceptance Criteria`);
      for (const criterion of task.acceptance_criteria) {
        bodyLines.push(`- [ ] ${criterion}`);
      }
      bodyLines.push("");
    }

    if (task.depends_on.length > 0) {
      bodyLines.push(`## Dependencies`);
      bodyLines.push(
        task.depends_on.map((d) => `- depends on: \`${d}\``).join("\n"),
      );
      bodyLines.push("");
    }

    if (task.conflicts_with.length > 0) {
      bodyLines.push(`## Conflicts`);
      bodyLines.push(
        task.conflicts_with
          .map((c) => `- conflicts with: \`${c}\``)
          .join("\n"),
      );
      bodyLines.push("");
    }

    bodyLines.push(`## Metadata`);
    bodyLines.push(`- **Priority:** ${task.priority}`);
    bodyLines.push(`- **Forge ID:** ${task.id}`);
    if (task.estimated_minutes != null) {
      bodyLines.push(`- **Estimate:** ${task.estimated_minutes}m`);
    }

    const body = bodyLines.join("\n");
    const labels = `forge:todo,priority:${task.priority}`;

    const output = this.gh(
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      task.title,
      "--body",
      body,
      "--label",
      labels,
    );

    // gh outputs a URL like https://github.com/org/repo/issues/42
    const issueNumber = this.parseIssueNumber(output);
    if (issueNumber === null) {
      throw new Error(
        `Could not parse issue number from gh output: ${output}`,
      );
    }
    return issueNumber;
  }

  /** Update issue labels for state transitions. */
  updateIssueLabel(
    repo: string,
    issueNumber: number,
    addLabel: string,
    removeLabel?: string,
  ): void {
    const args = [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      addLabel,
    ];

    if (removeLabel) {
      args.push("--remove-label", removeLabel);
    }

    this.gh(...args);
  }

  /** Comment on an issue. */
  commentOnIssue(
    repo: string,
    issueNumber: number,
    body: string,
  ): void {
    this.gh(
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    );
  }

  // ── Labels ─────────────────────────────────────────────────────

  /** Create the forge labels on a repo. Swallows errors for existing labels. */
  bootstrapLabels(repo: string): void {
    for (const label of this.config.labels) {
      try {
        const args = [
          "label",
          "create",
          (label.name),
          "--repo",
          repo,
          "--color",
          label.color.replace(/^#/, ""),
          "--force",
        ];
        if (label.description) {
          args.push("--description", label.description);
        }
        this.gh(...args);
      } catch {
        // Label may already exist — safe to ignore
      }
    }
  }

  // ── Project bootstrap ──────────────────────────────────────────

  /**
   * Bootstrap a new project: create the repo, clone it, set up labels.
   * Returns the local directory path of the cloned repo.
   */
  bootstrapProject(name: string, description: string): string {
    const repoSlug = `${this.config.org}/${name}`;
    const visibility =
      this.config.default_visibility === "public"
        ? "--public"
        : "--private";

    this.gh(
      "repo",
      "create",
      repoSlug,
      visibility,
      "--description",
      description,
      "--clone",
    );

    this.bootstrapLabels(repoSlug);

    return name;
  }

  // ── Repo info ──────────────────────────────────────────────────

  /** Get the repo full name (owner/repo) for the current directory. */
  getRepoFullName(): string | null {
    try {
      return this.gh(
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "-q",
        ".nameWithOwner",
      );
    } catch {
      return null;
    }
  }

  // ── Utilities ──────────────────────────────────────────────────

  /**
   * Wrap a value in single quotes for safe shell interpolation.
   * Inner single quotes are escaped with the '\'' idiom.
   */
  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Extract the issue number from a gh issue URL.
   * e.g. "https://github.com/org/repo/issues/42" -> 42
   */
  private parseIssueNumber(ghOutput: string): number | null {
    const match = /\/issues\/(\d+)/.exec(ghOutput);
    if (!match) return null;
    return parseInt(match[1], 10);
  }
}
