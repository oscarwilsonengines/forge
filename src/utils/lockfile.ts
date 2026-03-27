import { writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";

const STALE_TIMEOUT_MS = 60_000; // 60 seconds

/** Acquire a lockfile. Returns true if acquired, false if locked by another process. */
export function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    const stat = statSync(lockPath);
    const age = Date.now() - stat.mtimeMs;
    if (age > STALE_TIMEOUT_MS) {
      // Stale lock — remove it
      try { unlinkSync(lockPath); } catch { /* race condition OK */ }
    } else {
      return false;
    }
  }
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false; // Another process beat us
  }
}

/** Release a lockfile. */
export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already removed */ }
}

/** Execute a function while holding a lock. Retries up to maxRetries times. */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  maxRetries = 10,
  retryDelayMs = 100,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    if (acquireLock(lockPath)) {
      try {
        return await fn();
      } finally {
        releaseLock(lockPath);
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Could not acquire lock: ${lockPath} (after ${maxRetries} retries)`);
}
