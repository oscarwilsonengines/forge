import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEngine, SpawnOptions } from "./engine.js";
import type { WorkerHandle } from "../types.js";
import { buildWorkerPrompt } from "../workers/prompts.js";
import { log } from "../utils/logger.js";

// ─── HTTP Execution Engine ───────────────────────────────────────

/**
 * Spawns workers on a remote Forge Worker API server via HTTP.
 * The API server manages Claude CLI processes, git worktrees,
 * and process lifecycle on the remote machine.
 */
export class HttpEngine implements ExecutionEngine {
  constructor(
    private baseUrl: string,
    private apiToken: string,
    private forgeDir: string,
  ) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async spawn(opts: SpawnOptions): Promise<WorkerHandle> {
    const agentId = `worker-${opts.task.id}`;

    // Save prompt locally for debugging
    mkdirSync(join(this.forgeDir, "prompts"), { recursive: true });
    const prompt = buildWorkerPrompt(opts);
    writeFileSync(join(this.forgeDir, "prompts", `${agentId}.md`), prompt);

    // Determine repo URL from repoFullName
    const repoUrl = `https://github.com/${opts.repoFullName}.git`;

    const res = await fetch(`${this.baseUrl}/workers`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        task: opts.task,
        repoUrl,
        repoFullName: opts.repoFullName,
        model: opts.model,
        maxTurns: opts.maxTurns,
        allowedTools: opts.allowedTools,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`Worker API spawn failed (${res.status}): ${(err as Record<string, string>).error}`);
    }

    const data = await res.json() as { id: string; pid?: number };
    const outputPath = join(this.forgeDir, "outputs", `${agentId}.json`);
    mkdirSync(join(this.forgeDir, "outputs"), { recursive: true });

    return {
      id: data.id,
      engineType: "http",
      pid: data.pid,
      host: this.baseUrl,
      worktreePath: "", // managed by remote
      outputPath,
      startedAt: new Date().toISOString(),
    };
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/workers/${handle.id}`, {
        headers: this.headers(),
      });
      if (!res.ok) return false;
      const data = await res.json() as { status: string };
      return data.status === "running";
    } catch {
      log.warn(`Failed to check worker ${handle.id} health`);
      return false;
    }
  }

  async getOutput(handle: WorkerHandle): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/workers/${handle.id}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const data = await res.json() as { output?: string };
      if (data.output) {
        // Cache output locally
        writeFileSync(handle.outputPath, data.output);
      }
      return data.output || null;
    } catch {
      return null;
    }
  }

  async getExitCode(handle: WorkerHandle): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/workers/${handle.id}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const data = await res.json() as { exitCode?: number | null };
      return data.exitCode ?? null;
    } catch {
      return null;
    }
  }

  async kill(handle: WorkerHandle): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/workers/${handle.id}`, {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch {
      log.warn(`Failed to kill worker ${handle.id}`);
    }
  }

  async cleanup(handle: WorkerHandle): Promise<void> {
    // Kill also cleans up on the remote side
    await this.kill(handle);
  }

  // ─── Private ───────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) h["Authorization"] = `Bearer ${this.apiToken}`;
    return h;
  }
}
