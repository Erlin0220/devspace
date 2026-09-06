import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function normalizeNulRedirects(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return command;

  let result = "";
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let trailingBackslashes = 0;
  let i = 0;
  const redirectRe = /([12&]?)(>>?)\s*nul(?=\s|$|[|&;()<>])/iy;

  while (i < command.length) {
    const char = command[i];
    if (char === "\\") {
      trailingBackslashes += 1;
      result += char;
      i += 1;
      continue;
    }

    const isEscaped = trailingBackslashes % 2 === 1;
    trailingBackslashes = 0;

    if (char === "'" && !inDoubleQuotes) {
      if (!inSingleQuotes && isEscaped) {
        result += char;
        i += 1;
        continue;
      }
      inSingleQuotes = !inSingleQuotes;
      result += char;
      i += 1;
      continue;
    }

    if (char === '"' && !inSingleQuotes && !isEscaped) {
      inDoubleQuotes = !inDoubleQuotes;
      result += char;
      i += 1;
      continue;
    }

    if (!inSingleQuotes && !inDoubleQuotes && !isEscaped) {
      redirectRe.lastIndex = i;
      const match = redirectRe.exec(command);
      if (match) {
        result += `${match[1]}${match[2]}/dev/null`;
        i += match[0].length;
        continue;
      }
    }

    result += char;
    i += 1;
  }

  return result;
}

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}
