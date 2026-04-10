import { execSync } from "node:child_process";
import type { ForgeConfig } from "../types.js";
import { remoteExec } from "../utils/ssh.js";
import { log } from "../utils/logger.js";

interface DeployTarget {
  name: string;
  type: "ssh" | "local";
  host?: string;
  user?: string;
  key?: string;
  path: string;
  branch: string;
  commands: string[];
}

export class Deployer {
  private targets: DeployTarget[];

  constructor(config: ForgeConfig) {
    this.targets = config.deploy?.targets ?? [];
  }

  /** Deploy to all configured targets */
  async deployAll(): Promise<{ target: string; success: boolean; output: string }[]> {
    if (this.targets.length === 0) {
      throw new Error("No deploy targets configured. Add deploy.targets to forge.yaml");
    }

    const results = [];
    for (const target of this.targets) {
      log.info(`Deploying to ${target.name}...`);
      try {
        const output = await this.deployTarget(target);
        results.push({ target: target.name, success: true, output });
        log.success(`Deployed to ${target.name}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ target: target.name, success: false, output: msg });
        log.error(`Deploy to ${target.name} failed: ${msg}`);
      }
    }
    return results;
  }

  /** Deploy to a single named target */
  async deployTo(targetName: string): Promise<string> {
    const target = this.targets.find(t => t.name === targetName);
    if (!target) {
      throw new Error(`Deploy target '${targetName}' not found. Available: ${this.targets.map(t => t.name).join(", ")}`);
    }
    return this.deployTarget(target);
  }

  /** Execute deployment for one target */
  private async deployTarget(target: DeployTarget): Promise<string> {
    const outputs: string[] = [];

    // Default commands: fetch, checkout branch, pull
    const commands = target.commands.length > 0
      ? target.commands
      : [
          "git fetch origin",
          `git checkout ${target.branch}`,
          "git pull",
        ];

    if (target.type === "ssh") {
      if (!target.host || !target.user) {
        throw new Error(`SSH deploy target '${target.name}' requires host and user`);
      }
      const hostConfig = {
        type: "ssh" as const,
        host: target.host,
        user: target.user,
        key: target.key,
        max_agents: 0,
        claude_path: "claude",
      };

      for (const cmd of commands) {
        log.info(`  [${target.name}] ${cmd}`);
        const out = remoteExec(hostConfig, `cd "${target.path}" && ${cmd}`);
        if (out.trim()) outputs.push(out.trim());
      }
    } else {
      // Local deployment
      for (const cmd of commands) {
        log.info(`  [${target.name}] ${cmd}`);
        const out = execSync(cmd, {
          cwd: target.path,
          encoding: "utf-8",
          timeout: 120_000,
        });
        if (out.trim()) outputs.push(out.trim());
      }
    }

    return outputs.join("\n");
  }

  /** List configured deploy targets */
  listTargets(): string {
    if (this.targets.length === 0) return "No deploy targets configured.";
    return this.targets.map(t =>
      `- ${t.name} (${t.type}) → ${t.host ? `${t.user}@${t.host}:` : ""}${t.path} [${t.branch}]`
    ).join("\n");
  }
}
