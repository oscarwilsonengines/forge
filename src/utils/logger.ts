import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (shouldLog("debug")) console.log(chalk.gray(`[${timestamp()}] ${msg}`), ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) console.log(chalk.blue(`[${timestamp()}]`) + ` ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    if (shouldLog("warn")) console.warn(chalk.yellow(`[${timestamp()}] WARN: ${msg}`), ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    if (shouldLog("error")) console.error(chalk.red(`[${timestamp()}] ERROR: ${msg}`), ...args);
  },
  success(msg: string, ...args: unknown[]): void {
    if (shouldLog("info")) console.log(chalk.green(`[${timestamp()}] ${msg}`), ...args);
  },
};
