import { execSync } from "node:child_process";
import type { HostConfig } from "../types.js";

/** Build SSH args with ControlMaster for connection multiplexing */
function sshArgs(host: HostConfig): string[] {
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/forge-ssh-%C",
    "-o", "ControlPersist=30m",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
  ];
  if (host.key) args.push("-i", host.key);
  return args;
}

/** Execute a command on a remote host via SSH */
export function remoteExec(host: HostConfig, cmd: string): string {
  if (!host.host || !host.user) {
    throw new Error("SSH host requires host and user fields");
  }
  const args = [...sshArgs(host), `${host.user}@${host.host}`, cmd];
  return execSync(`ssh ${args.map(a => `"${a}"`).join(" ")}`, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

/** Copy a file to a remote host via SCP */
export function scpTo(host: HostConfig, localPath: string, remotePath: string): void {
  if (!host.host || !host.user) {
    throw new Error("SCP requires host and user fields");
  }
  const args = sshArgs(host);
  execSync(
    `scp ${args.map(a => `"${a}"`).join(" ")} "${localPath}" "${host.user}@${host.host}:${remotePath}"`,
    { timeout: 30_000 },
  );
}

/** Copy a file from a remote host via SCP */
export function scpFrom(host: HostConfig, remotePath: string, localPath: string): void {
  if (!host.host || !host.user) {
    throw new Error("SCP requires host and user fields");
  }
  const args = sshArgs(host);
  execSync(
    `scp ${args.map(a => `"${a}"`).join(" ")} "${host.user}@${host.host}:${remotePath}" "${localPath}"`,
    { timeout: 30_000 },
  );
}

/** Test SSH connectivity to a host */
export function testConnection(host: HostConfig): boolean {
  try {
    remoteExec(host, "echo ok");
    return true;
  } catch {
    return false;
  }
}
