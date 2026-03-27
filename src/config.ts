import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ForgeConfigSchema, type ForgeConfig } from "./types.js";

const CONFIG_FILENAMES = ["forge.yaml", "forge.yml"];
const CONFIG_SEARCH_PATHS = [
  (cwd: string) => cwd,
  (cwd: string) => join(cwd, ".forge"),
  () => join(process.env.HOME || process.env.USERPROFILE || "~", ".config", "forge"),
];

export function loadConfig(cwd?: string): ForgeConfig {
  const root = cwd || process.cwd();

  for (const pathFn of CONFIG_SEARCH_PATHS) {
    const dir = pathFn(root);
    for (const filename of CONFIG_FILENAMES) {
      const filepath = join(dir, filename);
      if (existsSync(filepath)) {
        const raw = readFileSync(filepath, "utf-8");
        const parsed = parseYaml(raw);
        return ForgeConfigSchema.parse(parsed);
      }
    }
  }

  // Return defaults if no config found
  return ForgeConfigSchema.parse({
    github: { org: "", labels: [] },
    hosts: { local: { type: "local", max_agents: 5 } },
    agents: {},
    review: {},
    notifications: {},
    state: {},
  });
}

export function getForgeDir(cwd?: string): string {
  const config = loadConfig(cwd);
  return join(cwd || process.cwd(), config.state.dir);
}
