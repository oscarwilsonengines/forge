import { execSync } from "node:child_process";
import { platform } from "node:os";
import type { ForgeConfig } from "../types.js";
import { log } from "../utils/logger.js";

type NotifyEvent = "agent_complete" | "agent_failed" | "review_ready" | "all_done" | "blocked_task";

export class Notifier {
  private config: ForgeConfig["notifications"];
  private telegramConfig?: ForgeConfig["telegram"];

  constructor(config: ForgeConfig["notifications"], telegramConfig?: ForgeConfig["telegram"]) {
    this.config = config;
    this.telegramConfig = telegramConfig;
  }

  /** Send notification through all configured channels */
  async notify(event: NotifyEvent, title: string, body: string): Promise<void> {
    if (!this.config.notify_on.includes(event)) return;

    const promises: Promise<void>[] = [];

    if (this.config.terminal_bell) this.bell();
    if (this.config.desktop) this.desktop(title, body);
    if (this.config.slack_webhook) promises.push(this.slack(title, body));
    if (this.config.discord_webhook) promises.push(this.discord(title, body));
    if (this.telegramConfig) promises.push(this.telegram(title, body));

    await Promise.allSettled(promises);
  }

  /** Terminal bell character */
  private bell(): void {
    process.stdout.write("\x07");
  }

  /** OS-native desktop notification */
  private desktop(title: string, body: string): void {
    const os = platform();
    try {
      if (os === "darwin") {
        execSync(`osascript -e 'display notification "${body}" with title "${title}"'`);
      } else if (os === "linux") {
        execSync(`notify-send "${title}" "${body}"`);
      } else if (os === "win32") {
        const ps = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${body.replace(/'/g, "''")}', 'Info')`;
        execSync(`powershell -Command "${ps}"`, { stdio: "pipe" });
      }
    } catch {
      log.debug(`Desktop notification failed (${os})`);
    }
  }

  /** Post to Slack via webhook */
  private async slack(title: string, body: string): Promise<void> {
    if (!this.config.slack_webhook) return;
    try {
      const payload = JSON.stringify({
        attachments: [{
          color: "good",
          title,
          text: body,
        }],
      });
      execSync(
        `curl -s -X POST -H "Content-type: application/json" --data '${payload.replace(/'/g, "\\'")}' "${this.config.slack_webhook}"`,
        { stdio: "pipe", timeout: 10_000 },
      );
    } catch (e) {
      log.warn("Slack notification failed");
    }
  }

  /** Post to Discord via webhook */
  private async discord(title: string, body: string): Promise<void> {
    if (!this.config.discord_webhook) return;
    try {
      const payload = JSON.stringify({
        embeds: [{ title, description: body, color: 3066993 }],
      });
      execSync(
        `curl -s -H "Content-Type: application/json" -X POST --data '${payload.replace(/'/g, "\\'")}' "${this.config.discord_webhook}"`,
        { stdio: "pipe", timeout: 10_000 },
      );
    } catch {
      log.warn("Discord notification failed");
    }
  }

  /** Send via Telegram bot */
  private async telegram(title: string, body: string): Promise<void> {
    if (!this.telegramConfig) return;
    const token = process.env[this.telegramConfig.bot_token_env];
    const chatId = process.env[this.telegramConfig.chat_id_env];
    if (!token || !chatId) return;

    try {
      const text = `*${title}*\n${body}`;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const payload = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      });
      execSync(
        `curl -s -X POST -H "Content-Type: application/json" --data '${payload.replace(/'/g, "\\'")}' "${url}"`,
        { stdio: "pipe", timeout: 10_000 },
      );
    } catch {
      log.warn("Telegram notification failed");
    }
  }

  /** Test all configured channels */
  async test(): Promise<void> {
    log.info("Testing notification channels...");
    this.bell();
    this.desktop("Forge Test", "Notifications are working!");
    if (this.config.slack_webhook) await this.slack("Forge Test", "Slack notifications working!");
    if (this.config.discord_webhook) await this.discord("Forge Test", "Discord notifications working!");
    if (this.telegramConfig) await this.telegram("Forge Test", "Telegram notifications working!");
    log.success("Notification test complete");
  }
}
