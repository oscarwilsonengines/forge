#!/usr/bin/env node
import TelegramBot from "node-telegram-bot-api";
import { loadConfig } from "../config.js";
import { StateManager } from "../core/state-manager.js";
import { Scheduler } from "../core/scheduler.js";
import { Notifier } from "../core/notifier.js";
import { LocalEngine } from "../execution/local-engine.js";
import { GitHubManager } from "../github/manager.js";
import { ReviewPipeline } from "../review/pipeline.js";
import { log } from "../utils/logger.js";

const config = loadConfig();
const projectRoot = process.cwd();
const forgeDir = `${projectRoot}/${config.state.dir}`;

// Validate env vars
const token = process.env[config.telegram?.bot_token_env || "FORGE_TELEGRAM_TOKEN"];
const authorizedChat = process.env[config.telegram?.chat_id_env || "FORGE_TELEGRAM_CHAT"];

if (!token) {
  console.error(`Set ${config.telegram?.bot_token_env || "FORGE_TELEGRAM_TOKEN"} env var`);
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
log.info("Forge Telegram bot started. Waiting for commands...");

function isAuthorized(chatId: number): boolean {
  if (!authorizedChat) return true; // No restriction if not set
  return String(chatId) === authorizedChat;
}

function createServices() {
  const state = new StateManager(projectRoot);
  const engine = new LocalEngine(forgeDir);
  const github = new GitHubManager(config.github);
  const notifier = new Notifier(config.notifications, config.telegram);
  const repoFullName = github.getRepoFullName() || "";
  const scheduler = new Scheduler(state, engine, github, notifier, {
    staggerSeconds: config.agents.stagger_seconds,
    heartbeatInterval: config.state.heartbeat_interval,
    maxAgents: config.hosts.local?.max_agents || 5,
    model: config.agents.model,
    maxTurns: config.agents.max_turns,
    allowedTools: config.agents.allowed_tools,
    timeoutMinutes: config.agents.timeout_minutes,
    repoFullName,
    projectRoot,
  });
  const review = new ReviewPipeline();
  return { state, scheduler, review, github };
}

// ─── Commands ────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id,
    "*Forge Multi-Agent Orchestrator*\n\n" +
    "Commands:\n" +
    "/status — Agent and task status\n" +
    "/approve — Approve pending plan\n" +
    "/build — Start building\n" +
    "/stop — Emergency stop\n" +
    "/review — Run code review\n" +
    "/checklist — Show review findings\n" +
    "/agents — List running agents\n" +
    "/help — This message",
    { parse_mode: "Markdown" },
  );
});

bot.onText(/\/help/, (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id,
    "/status — Current status\n" +
    "/approve — Approve plan\n" +
    "/build — Spawn agents\n" +
    "/stop — Stop all agents\n" +
    "/review — Run reviewers\n" +
    "/checklist — Review findings\n" +
    "/agents — Running agents",
  );
});

bot.onText(/\/status/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices();
    const status = scheduler.getStatus();
    // Telegram has a 4096 char limit — truncate if needed
    const text = status.length > 4000 ? status.slice(0, 4000) + "\n..." : status;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/approve/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state } = createServices();
    const plan = state.loadPlan();
    if (!plan) {
      await bot.sendMessage(msg.chat.id, "No plan found.");
      return;
    }
    plan.status = "approved";
    state.savePlan(plan);
    await bot.sendMessage(msg.chat.id, `Plan approved (${plan.tasks.length} tasks). Run /build to start.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/build/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices();
    const spawned = await scheduler.build();
    await bot.sendMessage(msg.chat.id, `Spawned ${spawned} agent(s). Use /status to monitor.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/stop/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { scheduler } = createServices();
    await scheduler.stopAll();
    await bot.sendMessage(msg.chat.id, "All agents stopped.");
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/review/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state, review, github } = createServices();
    const plan = state.loadPlan();
    if (!plan) { await bot.sendMessage(msg.chat.id, "No plan found."); return; }

    await bot.sendMessage(msg.chat.id, "Starting review pipeline (5 reviewers)...");

    const findings = await review.runReviews({
      projectRoot,
      repoFullName: plan.repo,
      branch: "main",
      model: config.agents.review_model,
      reviewTypes: config.review.agents,
      confidenceThreshold: config.review.confidence_threshold,
      forgeDir,
    });

    plan.review_findings = findings;
    plan.status = "reviewing";
    state.savePlan(plan);

    await bot.sendMessage(msg.chat.id, `Review complete: ${findings.length} findings. Use /checklist to see.`);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/checklist/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state, review } = createServices();
    const plan = state.loadPlan();
    if (!plan) { await bot.sendMessage(msg.chat.id, "No plan found."); return; }

    const checklist = review.generateChecklist(plan.review_findings);
    const text = checklist.length > 4000 ? checklist.slice(0, 4000) + "\n..." : checklist;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

bot.onText(/\/agents/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  try {
    const { state } = createServices();
    const agents = state.listAgents();
    if (agents.length === 0) {
      await bot.sendMessage(msg.chat.id, "No agents running.");
      return;
    }
    let text = "*Running Agents:*\n";
    for (const a of agents) {
      const runtime = Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000);
      text += `- ${a.id} [${a.status}] ${runtime}m (PID ${a.pid})\n`;
    }
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e}`);
  }
});

// Handle unknown commands
bot.on("message", (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  if (msg.text && msg.text.startsWith("/") && !msg.text.match(/^\/(start|help|status|approve|build|stop|review|checklist|agents)/)) {
    bot.sendMessage(msg.chat.id, "Unknown command. Use /help to see available commands.");
  }
});
