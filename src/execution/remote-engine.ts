import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEngine, SpawnOptions } from "./engine.js";
import type { WorkerHandle, HostConfig } from "../types.js";
import { remoteExec, scpTo, scpFrom } from "../utils/ssh.js";
import { buildWorkerPrompt } from "../workers/prompts.js";
import { log } from "../utils/logger.js";

export class RemoteEngine implements ExecutionEngine {
  constructor(
    private forgeDir: string,
    private host: HostConfig,
  ) {}

  async spawn(opts: SpawnOptions): Promise<WorkerHandle> {
    const agentId = `worker-${opts.task.id}`;
    const branchName = `forge/task-${opts.task.issue_number || opts.task.id}`;
    const sessionName = `forge-${agentId}`;
    const worktreePath = `.forge/worktrees/${agentId}`;
    const remotePromptPath = `/tmp/forge-prompt-${agentId}.md`;
    const remoteOutputPath = `/tmp/forge-${agentId}-output.json`;
    const localOutputPath = join(this.forgeDir, "outputs", `${agentId}.json`);

    // Ensure local dirs exist
    mkdirSync(join(this.forgeDir, "outputs"), { recursive: true });
    mkdirSync(join(this.forgeDir, "prompts"), { recursive: true });

    // 1. Write prompt locally then copy to remote
    const prompt = buildWorkerPrompt(opts);
    const localPromptPath = join(this.forgeDir, "prompts", `${agentId}.md`);
    writeFileSync(localPromptPath, prompt);
    scpTo(this.host, localPromptPath, remotePromptPath);

    // 2. Create git worktree on remote
    try {
      remoteExec(this.host,
        `cd "${opts.projectRoot}" && git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
      );
    } catch {
      try {
        remoteExec(this.host,
          `cd "${opts.projectRoot}" && git worktree add "${worktreePath}" "${branchName}"`,
        );
      } catch {
        log.warn(`Worktree ${worktreePath} may already exist on remote`);
      }
    }

    // 3. Spawn claude -p in tmux on remote
    const claudePath = this.host.claude_path || "claude";
    const tmuxCmd = [
      `cd "${opts.projectRoot}/${worktreePath}"`,
      "&&",
      claudePath,
      `--model ${opts.model}`,
      `--max-turns ${opts.maxTurns}`,
      "--output-format json",
      `-p "$(cat ${remotePromptPath})"`,
      `> ${remoteOutputPath} 2>&1`,
      `; echo $? > /tmp/forge-${agentId}-exit`,
    ].join(" ");

    remoteExec(this.host,
      `tmux new-session -d -s "${sessionName}" '${tmuxCmd}'`,
    );

    return {
      id: agentId,
      engineType: "ssh",
      host: this.host.host || "remote",
      worktreePath,
      outputPath: localOutputPath,
      startedAt: new Date().toISOString(),
    };
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    try {
      remoteExec(this.host, `tmux has-session -t "forge-${handle.id}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async getOutput(handle: WorkerHandle): Promise<string | null> {
    try {
      const remoteOutputPath = `/tmp/forge-${handle.id}-output.json`;
      scpFrom(this.host, remoteOutputPath, handle.outputPath);
      if (!existsSync(handle.outputPath)) return null;
      const content = readFileSync(handle.outputPath, "utf-8").trim();
      return content || null;
    } catch {
      return null;
    }
  }

  async getExitCode(handle: WorkerHandle): Promise<number | null> {
    try {
      const code = remoteExec(this.host,
        `cat /tmp/forge-${handle.id}-exit 2>/dev/null`,
      ).trim();
      return code ? parseInt(code, 10) : null;
    } catch {
      return null;
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    try {
      remoteExec(this.host, `tmux kill-session -t "forge-${handle.id}" 2>/dev/null`);
    } catch {
      /* session may already be dead */
    }
  }

  async cleanup(handle: WorkerHandle): Promise<void> {
    try {
      remoteExec(this.host,
        `cd "${join(this.forgeDir, "..")}" && git worktree remove "${handle.worktreePath}" --force`,
      );
    } catch {
      /* worktree may already be removed */
    }
  }
}
