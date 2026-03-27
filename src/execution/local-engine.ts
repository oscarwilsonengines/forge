import { spawn as cpSpawn, execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecutionEngine, SpawnOptions } from "./engine.js";
import type { WorkerHandle } from "../types.js";
import { isProcessAlive, killProcess } from "./platform.js";
import { buildWorkerPrompt } from "../workers/prompts.js";

// ─── Local Execution Engine ─────────────────────────────────────

/**
 * Spawns Claude CLI processes as detached background children on
 * the local machine. Each worker gets its own git worktree and
 * writes JSON output to a file under `.forge/outputs/`.
 *
 * Works on both Windows (Git Bash) and Unix.
 */
export class LocalEngine implements ExecutionEngine {
  constructor(private forgeDir: string) {}

  async spawn(opts: SpawnOptions): Promise<WorkerHandle> {
    const agentId = `worker-${opts.task.id}`;
    const branchName = `forge/task-${opts.task.issue_number ?? opts.task.id}`;
    const worktreePath = join(this.forgeDir, "worktrees", agentId);
    const outputPath = join(this.forgeDir, "outputs", `${agentId}.json`);
    const promptPath = join(this.forgeDir, "prompts", `${agentId}.md`);

    // 1. Create required directories
    for (const dir of ["worktrees", "outputs", "prompts"]) {
      mkdirSync(join(this.forgeDir, dir), { recursive: true });
    }

    // 2. Build the worker prompt and write it to disk
    const prompt = buildWorkerPrompt(opts);
    writeFileSync(promptPath, prompt);

    // 3. Create a git worktree for isolation
    this.createWorktree(opts.projectRoot, branchName, worktreePath);

    // 4. Open file descriptors for stdout/stderr capture
    const outFd = openSync(outputPath, "w");
    const errPath = join(this.forgeDir, "outputs", `${agentId}.err`);
    const errFd = openSync(errPath, "w");

    // 5. Resolve the full path to the claude CLI
    const claudePath = this.resolveClaudePath();

    // 6. Build CLI args — use prompt file path instead of inline content
    //    to avoid shell escaping issues with multiline prompts
    const args = [
      "-p", readFileSync(promptPath, "utf-8"),
      "--model", opts.model,
      "--max-turns", String(opts.maxTurns),
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
    ];

    // 7. Spawn claude as a detached background process
    const child = cpSpawn(claudePath, args, {
      cwd: worktreePath,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
    child.unref();

    return {
      id: agentId,
      engineType: "local",
      pid: child.pid,
      host: "local",
      worktreePath,
      outputPath,
      startedAt: new Date().toISOString(),
    };
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    if (!handle.pid) return false;
    return isProcessAlive(handle.pid);
  }

  async getOutput(handle: WorkerHandle): Promise<string | null> {
    try {
      if (!existsSync(handle.outputPath)) return null;
      const content = readFileSync(handle.outputPath, "utf-8").trim();
      if (!content) return null;
      return content;
    } catch {
      return null;
    }
  }

  async getExitCode(handle: WorkerHandle): Promise<number | null> {
    // Still running -- no exit code yet
    if (handle.pid && isProcessAlive(handle.pid)) return null;

    // Process is gone. Try to determine exit status from output.
    // Valid JSON output from `claude --output-format json` means success.
    const output = await this.getOutput(handle);
    if (output) {
      try {
        JSON.parse(output);
        return 0;
      } catch {
        return 1;
      }
    }

    // No output at all -- indeterminate
    return null;
  }

  async kill(handle: WorkerHandle): Promise<void> {
    if (handle.pid) {
      killProcess(handle.pid);
    }
  }

  async cleanup(handle: WorkerHandle): Promise<void> {
    // Remove the git worktree. The project root is one level above forgeDir.
    try {
      const projectRoot = join(this.forgeDir, "..");
      execSync(
        `git worktree remove "${handle.worktreePath}" --force`,
        { cwd: projectRoot, stdio: "pipe" },
      );
    } catch {
      // Worktree may already be removed or never fully created
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Create a git worktree, handling the case where the branch
   * or worktree may already exist.
   */
  /** Resolve the full path to the claude CLI binary */
  private resolveClaudePath(): string {
    try {
      // Try 'where' on Windows, 'which' on Unix
      const cmd = process.platform === "win32" ? "where claude" : "which claude";
      return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0];
    } catch {
      // Fallback — assume it's on PATH and hope for the best
      return "claude";
    }
  }

  private createWorktree(
    projectRoot: string,
    branchName: string,
    worktreePath: string,
  ): void {
    // Try creating a new branch + worktree in one shot
    try {
      execSync(
        `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
        { cwd: projectRoot, stdio: "pipe" },
      );
      return;
    } catch {
      // Branch may already exist -- fall through
    }

    // Branch exists, just attach the worktree to it
    try {
      execSync(
        `git worktree add "${worktreePath}" "${branchName}"`,
        { cwd: projectRoot, stdio: "pipe" },
      );
      return;
    } catch {
      // Worktree may already exist at that path -- that's acceptable
    }
  }
}
