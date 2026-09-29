import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { LocalAgentWorkspaceMode } from "./local-agent-store.js";

export function detectWorkspaceMode(root: string): LocalAgentWorkspaceMode {
  const workspaceRoot = canonicalize(root);
  const gitDir = gitPath(workspaceRoot, "--git-dir");
  const commonDir = gitPath(workspaceRoot, "--git-common-dir");
  if (!gitDir || !commonDir) return "checkout";
  return canonicalize(gitDir) === canonicalize(commonDir) ? "checkout" : "worktree";
}

function gitPath(root: string, option: "--git-dir" | "--git-common-dir"): string | undefined {
  const result = spawnSync("git", ["rev-parse", option], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value ? resolve(root, value) : undefined;
}

function canonicalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
