import type { Task, WorkerHandle, HostConfig } from "../types.js";

// ─── Spawn Options ──────────────────────────────────────────────

export interface SpawnOptions {
  task: Task;
  repoFullName: string;
  projectRoot: string;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  targetBranch: string;
}

// ─── Execution Engine Interface ─────────────────────────────────

/**
 * Abstract interface for worker lifecycle management.
 *
 * Implementations handle the platform-specific details of spawning
 * Claude CLI processes, tracking their state, and cleaning up
 * resources when they finish or are killed.
 */
export interface ExecutionEngine {
  /** Spawn a new worker process for the given task. */
  spawn(opts: SpawnOptions): Promise<WorkerHandle>;

  /** Check whether the worker process is still running. */
  isAlive(handle: WorkerHandle): Promise<boolean>;

  /** Read the worker's stdout output file. Returns null if not yet available. */
  getOutput(handle: WorkerHandle): Promise<string | null>;

  /** Get the worker's exit code. Returns null if still running or unknown. */
  getExitCode(handle: WorkerHandle): Promise<number | null>;

  /** Force-kill the worker process. */
  kill(handle: WorkerHandle): Promise<void>;

  /** Clean up resources (worktrees, temp files) after a worker finishes. */
  cleanup(handle: WorkerHandle): Promise<void>;
}
