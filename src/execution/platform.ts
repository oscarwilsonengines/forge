import { execSync } from "node:child_process";

// ─── Platform Detection ─────────────────────────────────────────

/**
 * Returns the normalized platform identifier.
 * Windows (including Git Bash on Windows) returns "windows".
 * Everything else returns "unix".
 */
export function getPlatform(): "windows" | "unix" {
  return process.platform === "win32" ? "windows" : "unix";
}

// ─── Process Liveness Check ─────────────────────────────────────

/**
 * Check whether a process with the given PID is still alive.
 *
 * - Windows: runs `tasklist` filtered by PID and checks if the
 *   output contains the PID string (tasklist returns a header
 *   with "No tasks" when the process doesn't exist).
 * - Unix: sends signal 0 via `process.kill`, which checks
 *   existence without actually delivering a signal.
 *
 * Returns false if the process doesn't exist or access is denied.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    if (getPlatform() === "windows") {
      const output = execSync(
        `tasklist /FI "PID eq ${pid}" /NH`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      // tasklist output contains the PID number when the process exists.
      // When it doesn't, the output says "No tasks are running..." or similar.
      return output.includes(String(pid));
    }

    // Unix: signal 0 checks existence without killing.
    // Throws if the process doesn't exist.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Process Kill ───────────────────────────────────────────────

/**
 * Force-kill a process and its child tree.
 *
 * - Windows: uses `taskkill /PID <pid> /F /T` to forcefully
 *   terminate the process tree.
 * - Unix: sends SIGTERM first, then SIGKILL after 5 seconds
 *   if the process is still alive.
 *
 * Silently ignores errors (e.g. process already exited).
 */
export function killProcess(pid: number): void {
  try {
    if (getPlatform() === "windows") {
      execSync(`taskkill /PID ${pid} /F /T`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      return;
    }

    // Unix: graceful SIGTERM first
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already gone
      return;
    }

    // Wait up to 5 seconds for graceful shutdown, then SIGKILL
    const deadline = Date.now() + 5000;
    const checkInterval = 250;

    const waitAndKill = (): void => {
      while (Date.now() < deadline) {
        try {
          // Check if still alive
          process.kill(pid, 0);
        } catch {
          // Process exited after SIGTERM -- done
          return;
        }
        // Busy-wait in small increments (synchronous context)
        execSync(`sleep 0.25`, { stdio: "pipe" });
      }

      // Still alive after 5s -- force kill
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone
      }
    };

    waitAndKill();
  } catch {
    // Process may already be dead -- that's fine
  }
}
