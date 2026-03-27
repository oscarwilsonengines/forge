import type {
  Plan, Task, Agent, ForgeConfig, WorkerHandle, HostConfig,
} from "../types.js";
import type { StateManager } from "./state-manager.js";
import type { ExecutionEngine, SpawnOptions } from "../execution/engine.js";
import type { Notifier } from "./notifier.js";
import type { GitHubManager } from "../github/manager.js";
import { log } from "../utils/logger.js";

interface SchedulerConfig {
  staggerSeconds: number;
  heartbeatInterval: number;
  maxAgents: number;
  model: string;
  maxTurns: number;
  allowedTools: string[];
  timeoutMinutes: number;
  repoFullName: string;
  projectRoot: string;
}

export class Scheduler {
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private state: StateManager,
    private engine: ExecutionEngine,
    private github: GitHubManager,
    private notifier: Notifier,
    private config: SchedulerConfig,
  ) {}

  /** Spawn workers for all ready tasks */
  async build(): Promise<number> {
    const plan = this.state.loadPlan();
    if (!plan) throw new Error("No plan found. Run 'forge plan' first.");
    if (plan.status !== "approved" && plan.status !== "building") {
      throw new Error(`Plan status is '${plan.status}'. Run 'forge approve' first.`);
    }

    plan.status = "building";
    this.state.savePlan(plan);

    const spawned = await this.spawnReadyTasks(plan);
    if (spawned > 0) {
      this.startHealthMonitor();
    }

    return spawned;
  }

  /** Find and spawn agents for tasks whose dependencies are met */
  async spawnReadyTasks(plan?: Plan | null): Promise<number> {
    plan = plan ?? this.state.loadPlan();
    if (!plan) return 0;

    const doneTasks = new Set(
      plan.tasks.filter((t) => t.status === "done").map((t) => t.id),
    );
    const runningAgents = this.state.listAgents().filter((a) => a.status === "running");

    if (runningAgents.length >= this.config.maxAgents) {
      log.info(`Max agents (${this.config.maxAgents}) reached. Waiting.`);
      return 0;
    }

    const readyTasks = plan.tasks.filter((t) => {
      if (t.status !== "todo") return false;
      return t.depends_on.every((dep) => doneTasks.has(dep));
    });

    let spawned = 0;
    for (const task of readyTasks) {
      if (runningAgents.length + spawned >= this.config.maxAgents) break;

      const spawnOpts: SpawnOptions = {
        task,
        repoFullName: this.config.repoFullName,
        projectRoot: this.config.projectRoot,
        model: this.config.model,
        maxTurns: this.config.maxTurns,
        allowedTools: this.config.allowedTools,
      };

      try {
        log.info(`Spawning agent for task: ${task.title}`);
        const handle = await this.engine.spawn(spawnOpts);

        // Save agent record
        this.state.saveAgent({
          id: handle.id,
          task_id: task.id,
          pid: handle.pid,
          host: handle.host,
          model: this.config.model,
          started_at: handle.startedAt,
          last_heartbeat: handle.startedAt,
          status: "running",
          worktree_path: handle.worktreePath,
          output_path: handle.outputPath,
          token_usage: 0,
          cost_usd: 0,
        });

        // Update task status
        this.state.updateTask(task.id, {
          status: "in-progress",
          assigned_to: handle.id,
        });

        // Update GitHub Issue
        if (task.issue_number) {
          try {
            this.github.updateIssueLabel(
              this.config.repoFullName,
              task.issue_number,
              "forge:in-progress",
              "forge:todo",
            );
          } catch { /* non-critical */ }
        }

        spawned++;
        log.success(`Agent ${handle.id} spawned (PID ${handle.pid})`);

        // Stagger next spawn
        if (spawned < readyTasks.length) {
          await new Promise((r) => setTimeout(r, this.config.staggerSeconds * 1000));
        }
      } catch (e) {
        log.error(`Failed to spawn agent for ${task.id}: ${e}`);
      }
    }

    this.state.generateProjectState();
    return spawned;
  }

  /** Start the health monitoring loop */
  startHealthMonitor(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(
      () => void this.checkHealth(),
      this.config.heartbeatInterval * 1000,
    );
    log.info(`Health monitor started (every ${this.config.heartbeatInterval}s)`);
  }

  /** Stop the health monitor */
  stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** Check health of all running agents */
  private async checkHealth(): Promise<void> {
    const agents = this.state.listAgents().filter((a) => a.status === "running");
    if (agents.length === 0) {
      this.stopHealthMonitor();
      return;
    }

    for (const agent of agents) {
      const handle: WorkerHandle = {
        id: agent.id,
        engineType: agent.host === "local" ? "local" : "ssh",
        pid: agent.pid,
        host: agent.host,
        worktreePath: agent.worktree_path,
        outputPath: agent.output_path,
        startedAt: agent.started_at,
      };

      const alive = await this.engine.isAlive(handle);

      if (!alive) {
        // Agent finished — check exit code
        const exitCode = await this.engine.getExitCode(handle);
        const output = await this.engine.getOutput(handle);

        if (exitCode === 0 && output) {
          this.state.saveAgent({ ...agent, status: "completed", finished_at: new Date().toISOString(), exit_code: 0 });
          this.state.updateTask(agent.task_id, { status: "done" });
          log.success(`Agent ${agent.id} completed`);
          await this.notifier.notify("agent_complete", `Agent Complete: ${agent.id}`, `Task ${agent.task_id} finished successfully.`);
        } else {
          // Check timeout
          const runtime = Date.now() - new Date(agent.started_at).getTime();
          const timeoutMs = this.config.timeoutMinutes * 60 * 1000;
          const status = runtime > timeoutMs ? "timeout" : "failed";

          this.state.saveAgent({ ...agent, status, finished_at: new Date().toISOString(), exit_code: exitCode ?? -1 });
          this.state.updateTask(agent.task_id, { status: "failed" });
          log.error(`Agent ${agent.id} ${status}`);
          await this.notifier.notify("agent_failed", `Agent Failed: ${agent.id}`, `Task ${agent.task_id} ${status}.`);
        }

        // Update GitHub Issue
        const plan = this.state.loadPlan();
        const task = plan?.tasks.find((t) => t.id === agent.task_id);
        if (task?.issue_number && plan) {
          try {
            const label = task.status === "done" ? "forge:done" : "forge:blocked";
            this.github.updateIssueLabel(this.config.repoFullName, task.issue_number, label, "forge:in-progress");
          } catch { /* non-critical */ }
        }

        // Try to spawn next ready tasks
        await this.spawnReadyTasks();
      } else {
        // Update heartbeat
        this.state.saveAgent({ ...agent, last_heartbeat: new Date().toISOString() });
      }
    }

    // Check if all tasks are done
    const plan = this.state.loadPlan();
    if (plan) {
      const allDone = plan.tasks.every((t) => t.status === "done" || t.status === "failed");
      if (allDone) {
        this.stopHealthMonitor();
        log.success("All tasks complete!");
        await this.notifier.notify("all_done", "All Tasks Complete", "Run 'forge review' to start the review pipeline.");
      }
    }

    this.state.generateProjectState();
  }

  /** Get a formatted status string */
  getStatus(): string {
    const plan = this.state.loadPlan();
    if (!plan) return "No plan found.";

    const agents = this.state.listAgents();
    const running = agents.filter((a) => a.status === "running");
    const completed = agents.filter((a) => a.status === "completed");
    const failed = agents.filter((a) => a.status === "failed" || a.status === "timeout");

    const tasks = plan.tasks;
    const todo = tasks.filter((t) => t.status === "todo");
    const inProgress = tasks.filter((t) => t.status === "in-progress");
    const done = tasks.filter((t) => t.status === "done");
    const blocked = tasks.filter((t) => t.status === "blocked");

    let status = `## Forge Status — ${plan.project}\n\n`;
    status += `Plan: ${plan.status} | Tasks: ${done.length}/${tasks.length} done\n\n`;

    if (running.length > 0) {
      status += `### Running (${running.length})\n`;
      for (const a of running) {
        const task = tasks.find((t) => t.id === a.task_id);
        const runtime = Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000);
        status += `- ${a.id}: ${task?.title || a.task_id} (${runtime}m, PID ${a.pid})\n`;
      }
      status += "\n";
    }

    if (inProgress.length > 0) {
      status += `### In Progress (${inProgress.length})\n`;
      for (const t of inProgress) status += `- ${t.title} → ${t.assigned_to || "unassigned"}\n`;
      status += "\n";
    }

    if (blocked.length > 0) {
      status += `### Blocked (${blocked.length})\n`;
      for (const t of blocked) status += `- ${t.title} (waiting on: ${t.depends_on.join(", ")})\n`;
      status += "\n";
    }

    if (todo.length > 0) {
      status += `### Todo (${todo.length})\n`;
      for (const t of todo) status += `- ${t.title} [${t.priority}]\n`;
      status += "\n";
    }

    if (done.length > 0) {
      status += `### Done (${done.length})\n`;
      for (const t of done) status += `- ${t.title}\n`;
      status += "\n";
    }

    if (failed.length > 0) {
      status += `### Failed (${failed.length})\n`;
      for (const a of failed) {
        const task = tasks.find((t) => t.id === a.task_id);
        status += `- ${a.id}: ${task?.title || a.task_id} (${a.status})\n`;
      }
    }

    return status;
  }

  /** Stop all running agents */
  async stopAll(): Promise<void> {
    const agents = this.state.listAgents().filter((a) => a.status === "running");
    for (const agent of agents) {
      const handle: WorkerHandle = {
        id: agent.id,
        engineType: agent.host === "local" ? "local" : "ssh",
        pid: agent.pid,
        host: agent.host,
        worktreePath: agent.worktree_path,
        outputPath: agent.output_path,
        startedAt: agent.started_at,
      };
      await this.engine.kill(handle);
      this.state.saveAgent({ ...agent, status: "killed", finished_at: new Date().toISOString() });
      this.state.updateTask(agent.task_id, { status: "todo", assigned_to: undefined });
      log.info(`Killed agent ${agent.id}`);
    }
    this.stopHealthMonitor();
  }
}
