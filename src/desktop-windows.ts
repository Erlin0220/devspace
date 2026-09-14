import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadDevspaceFiles } from "./user-config.js";

const exec = promisify(execFile);
const COMPONENTS = ["runtime", "tray"] as const;
type DesktopComponent = (typeof COMPONENTS)[number];

interface DesktopPaths {
  home: string;
  packageRoot: string;
  cli: string;
  node: string;
  launcher: string;
  tray: string;
  logs: string;
  startup: string;
}

interface DesktopProbe {
  local: boolean;
  public: boolean | null;
  publicBaseUrl: string | null;
  host: string;
  port: number;
}

export interface DesktopMenuEntry {
  id: string;
  text: string;
  enabled: boolean;
  action?: string;
  separator?: boolean;
  children?: DesktopMenuEntry[];
}

export interface DesktopTrayState {
  status: "ready" | "partial" | "busy" | "stopped";
  iconStatus: "ready" | "partial" | "busy" | "stopped";
  tooltip: string;
  menu: DesktopMenuEntry[];
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("DevSpace desktop management currently supports Windows only.");
  }
}

function xml(value: string): string {
  return String(value).replace(/[<>&"']/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}

function quoted(value: string): string {
  return `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

export function desktopTaskName(ownerToken: string, component: DesktopComponent): string {
  if (!ownerToken) throw new Error("DevSpace owner token is required for desktop task identity.");
  const owner = createHash("sha256").update(ownerToken).digest("hex").slice(0, 16);
  return `com.devspace.${owner}.${component}`;
}

export function windowsDesktopTaskXml(input: {
  component: DesktopComponent;
  ownerToken: string;
  sid: string;
  paths: DesktopPaths;
  widgets?: string;
  trustProxy?: string;
  nodeOptions?: string;
}): string {
  const { component, ownerToken, sid, paths } = input;
  const label = desktopTaskName(ownerToken, component);
  const stdout = join(paths.logs, `${component}.log`);
  const stderr = join(paths.logs, `${component}.error.log`);
  const commandArgs = component === "runtime" ? [paths.cli, "serve"] : [paths.cli, "desktop", "tray"];
  const environment = [
    `DEVSPACE_CONFIG_DIR=${paths.home}`,
    component === "runtime" ? `DEVSPACE_WIDGETS=${input.widgets ?? "off"}` : undefined,
    component === "runtime" ? `DEVSPACE_TRUST_PROXY=${input.trustProxy ?? "1"}` : undefined,
    component === "runtime" ? `NODE_OPTIONS=${input.nodeOptions ?? "--max-old-space-size=6144"}` : "NODE_OPTIONS=",
  ].filter((value): value is string => Boolean(value));
  const args = [
    "--cwd", paths.packageRoot,
    "--stdout", stdout,
    "--stderr", stderr,
    ...environment.flatMap((assignment) => ["--env", assignment]),
    "--", paths.node, ...commandArgs,
  ];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>DevSpace ${component}; runs only in this user session.</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${xml(sid)})</SecurityDescriptor></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="User"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>${xml(paths.launcher)}</Command><Arguments>${xml(args.map(quoted).join(" "))}</Arguments><WorkingDirectory>${xml(paths.packageRoot)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

function desktopPaths(home: string): DesktopPaths {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const packageRoot = resolve(dirname(cli), "..");
  const desktop = join(home, "desktop");
  return {
    home,
    packageRoot,
    cli,
    node: process.execPath,
    launcher: join(desktop, "bin", "devspace-launcher.exe"),
    tray: join(desktop, "bin", "devspace-tray.exe"),
    logs: join(home, "logs"),
    startup: join(desktop, "startup"),
  };
}

function nativeExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", name);
}

function windowsExplorer(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "explorer.exe");
}

async function native(command: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string } | null> {
  try {
    return await exec(nativeExecutable(command), args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return null;
    const failure = error as { code?: string | number; stdout?: string; stderr?: string };
    const detail = String(failure.stderr ?? failure.stdout ?? "").trim().replace(/\s+/g, " ").slice(0, 240);
    throw new Error(`${command} ${args.join(" ")} failed (${failure.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
}

async function currentSid(): Promise<string> {
  const result = await native("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = /S-1-5-[0-9-]+/.exec(result?.stdout ?? "")?.[0];
  if (!sid) throw new Error("Unable to resolve the current Windows user SID.");
  return sid;
}

async function taskExists(name: string): Promise<boolean> {
  return Boolean(await native("schtasks.exe", ["/Query", "/TN", name, "/XML"], true));
}

async function taskAction(action: "start" | "stop" | "remove", name: string): Promise<void> {
  if (action === "start") {
    await native("schtasks.exe", ["/Run", "/TN", name]);
    return;
  }
  await native("schtasks.exe", ["/End", "/TN", name], true);
  if (action === "remove") await native("schtasks.exe", ["/Delete", "/TN", name, "/F"], true);
}

async function readActiveTeamDevSpaceRoot(): Promise<string | null> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const candidates: string[] = [];
  try {
    const active = (await readFile(join(localAppData, "TDS", "active-path"), "utf8")).trim();
    if (active) candidates.push(active);
  } catch {}
  candidates.push(join(localAppData, "TDS", "v", "0"));
  for (const candidate of candidates) {
    const launcher = join(candidate, "platform", "windows", "tds-launcher.exe");
    const tray = join(candidate, "platform", "windows", "team-devspace-tray.exe");
    try {
      await Promise.all([access(launcher), access(tray)]);
      return candidate;
    } catch {}
  }
  return null;
}

async function installNativeHelpers(paths: DesktopPaths): Promise<void> {
  await mkdir(dirname(paths.launcher), { recursive: true });
  const teamRoot = await readActiveTeamDevSpaceRoot();
  if (teamRoot) {
    await copyFileWithRetry(join(teamRoot, "platform", "windows", "tds-launcher.exe"), paths.launcher);
    await copyFileWithRetry(join(teamRoot, "platform", "windows", "team-devspace-tray.exe"), paths.tray);
    return;
  }
  try {
    await Promise.all([access(paths.launcher), access(paths.tray)]);
  } catch {
    throw new Error(
      "Team DevSpace native tray helpers were not found. Install Team DevSpace once, then run `devspace desktop install` again.",
    );
  }
}

async function copyFileWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await copyFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') || attempt >= 99) throw error;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  }
}

async function listenerPid(port: number): Promise<number | null> {
  const result = await native("netstat.exe", ["-ano", "-p", "TCP"], true);
  if (!result) return null;
  const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

async function removeLegacyBackground(home: string, port: number): Promise<void> {
  const existed = await taskExists("DevSpace Background");
  await taskAction("remove", "DevSpace Background");
  if (existed && await probeLocal("127.0.0.1", port)) {
    const pid = await listenerPid(port);
    if (pid && pid !== process.pid) {
      await native("taskkill.exe", ["/PID", String(pid), "/T", "/F"], true);
      await waitForLocal(false, 10_000);
    }
  }
  await Promise.all([
    rm(join(home, "launch-hidden.vbs"), { force: true }),
    rm(join(home, "launch-hidden.ps1"), { force: true }),
  ]);
  const lock = join(home, "launch.lock");
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(lock, { force: true });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      if (attempt === 19) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
  }
}

async function installDesktop(): Promise<void> {
  assertWindows();
  const files = loadDevspaceFiles();
  if (!files.auth.ownerToken) throw new Error("DevSpace is not initialized. Run `devspace init` first.");
  const paths = desktopPaths(files.dir);
  const port = files.config.port ?? 7676;
  await Promise.all([
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.startup, { recursive: true }),
  ]);

  let stoppedRuntimeTask = false;
  for (const component of [...COMPONENTS].reverse()) {
    const name = desktopTaskName(files.auth.ownerToken, component);
    if (await taskExists(name)) {
      await taskAction("stop", name);
      if (component === "runtime") stoppedRuntimeTask = true;
    }
  }
  await removeLegacyBackground(files.dir, port);
  if (stoppedRuntimeTask) await waitForLocal(false, 10_000);
  await installNativeHelpers(paths);

  const sid = await currentSid();
  for (const component of COMPONENTS) {
    const name = desktopTaskName(files.auth.ownerToken, component);
    const taskPath = join(paths.startup, `${component}.xml`);
    const taskXml = windowsDesktopTaskXml({
      component,
      ownerToken: files.auth.ownerToken,
      sid,
      paths,
      widgets: process.env.DEVSPACE_WIDGETS ?? "off",
      trustProxy: process.env.DEVSPACE_TRUST_PROXY ?? "1",
      nodeOptions: process.env.NODE_OPTIONS || "--max-old-space-size=6144",
    });
    await writeFile(taskPath, `\uFEFF${taskXml}`, "utf16le");
    await native("schtasks.exe", ["/Create", "/TN", name, "/XML", taskPath, "/F"]);
  }

  await taskAction("start", desktopTaskName(files.auth.ownerToken, "runtime"));
  await taskAction("start", desktopTaskName(files.auth.ownerToken, "tray"));
}

async function uninstallDesktop(): Promise<void> {
  assertWindows();
  const files = loadDevspaceFiles();
  if (files.auth.ownerToken) {
    for (const component of [...COMPONENTS].reverse()) {
      await taskAction("remove", desktopTaskName(files.auth.ownerToken, component));
    }
  }
  await rm(join(files.dir, "desktop"), { recursive: true, force: true });
}

function connectionHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

async function probeLocal(host: string, port: number, timeout = 700): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ host: connectionHost(host), port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

async function probePublic(publicBaseUrl: string, timeout = 4000): Promise<boolean> {
  try {
    const response = await fetch(new URL("/mcp", publicBaseUrl), {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function probeDesktop(forcePublic = false, cache?: { value: boolean | null; at: number }): Promise<DesktopProbe> {
  const files = loadDevspaceFiles();
  const host = files.config.host ?? "127.0.0.1";
  const port = files.config.port ?? 7676;
  const publicBaseUrl = files.config.publicBaseUrl ?? null;
  const local = await probeLocal(host, port);
  let publicReachable: boolean | null = null;
  if (publicBaseUrl) {
    const fresh = cache && Date.now() - cache.at < 30_000;
    publicReachable = !forcePublic && fresh ? cache.value : await probePublic(publicBaseUrl);
  }
  return { local, public: publicReachable, publicBaseUrl, host, port };
}

export function createDesktopTrayState(
  probe: DesktopProbe,
  options: { busy?: boolean; activity?: string; alert?: string } = {},
): DesktopTrayState {
  const { busy = false, activity, alert } = options;
  let status: DesktopTrayState["status"] = "stopped";
  let summary = "DevSpace 本机服务已停止";
  if (probe.local && probe.public === false) {
    status = "partial";
    summary = "DevSpace 公网连接异常";
  } else if (probe.local) {
    status = "ready";
    summary = probe.publicBaseUrl ? "DevSpace 已连接" : "DevSpace 本机已运行";
  }
  const item = (id: string, text: string, enabled: boolean, action = id): DesktopMenuEntry => ({ id, text, enabled, action });
  const separator = (id: string): DesktopMenuEntry => ({ id, text: "", enabled: false, separator: true });
  const iconStatus: DesktopTrayState["iconStatus"] = alert ? "partial" : activity ? "busy" : status;
  const publicText = probe.publicBaseUrl
    ? `公网：${probe.public === false ? "不可达" : probe.public === true ? "可达" : "待检查"}`
    : "公网：未配置";
  return {
    status,
    iconStatus,
    tooltip: `DevSpace · ${alert ? "需要处理" : activity ?? summary.replace(/^DevSpace /, "")}`,
    menu: [
      item("status", alert ? `操作未完成：${alert}` : activity ?? summary, false, ""),
      item("device", `此设备：${hostname()}`, false, ""),
      item("local", `本机：http://${probe.host}:${probe.port}/mcp`, false, ""),
      item("public", publicText, false, ""),
      separator("main-separator"),
      item(probe.local ? "stop" : "start", probe.local ? "停止 DevSpace" : "启动 DevSpace", !busy),
      item("restart", "重启 DevSpace", !busy && probe.local),
      {
        id: "tools",
        text: "诊断与管理",
        enabled: !busy,
        children: [
          item("check", "检查连接", !busy),
          separator("tools-separator"),
          item("logs", "打开日志目录", !busy),
          item("config", "打开配置目录", !busy),
        ],
      },
      separator("exit-separator"),
      item("exit", "退出托盘", !busy),
    ],
  };
}

function findMenuAction(menu: DesktopMenuEntry[], action: string): DesktopMenuEntry | undefined {
  for (const item of menu) {
    if (!item.enabled) continue;
    if (item.children) {
      const child = findMenuAction(item.children, action);
      if (child) return child;
    } else if (item.action === action) return item;
  }
}

async function waitForLocal(expected: boolean, timeoutMs: number): Promise<boolean> {
  const files = loadDevspaceFiles();
  const host = files.config.host ?? "127.0.0.1";
  const port = files.config.port ?? 7676;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeLocal(host, port) === expected) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  } while (Date.now() < deadline);
  return false;
}

function openDirectory(path: string): void {
  const child = spawn(windowsExplorer(), [path], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function runTray(): Promise<void> {
  assertWindows();
  const files = loadDevspaceFiles();
  if (!files.auth.ownerToken) throw new Error("DevSpace is not initialized.");
  const paths = desktopPaths(files.dir);
  await access(paths.tray);
  const runtimeTask = desktopTaskName(files.auth.ownerToken, "runtime");
  const instanceId = createHash("sha256").update(resolve(files.dir)).digest("hex");
  const child = spawn(paths.tray, [], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: instanceId },
  });
  let closed = false;
  let ready = false;
  let exiting = false;
  let busy = false;
  let activity: string | undefined;
  let alert: string | undefined;
  let lastState: DesktopTrayState | undefined;
  let publicCache = { value: null as boolean | null, at: 0 };
  let interval: NodeJS.Timeout | undefined;
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const send = (state: DesktopTrayState) => {
    lastState = state;
    if (!closed && !child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(state)}\n`);
    }
  };
  const refresh = async (forcePublic = false) => {
    const probe = await probeDesktop(forcePublic, publicCache);
    if (probe.publicBaseUrl && (forcePublic || Date.now() - publicCache.at >= 30_000 || publicCache.at === 0)) {
      publicCache = { value: probe.public, at: Date.now() };
    }
    send(createDesktopTrayState(probe, { busy, activity, alert }));
  };
  const runAction = async (action: string) => {
    if (!lastState || !findMenuAction(lastState.menu, action) || busy || exiting) return;
    if (action === "exit") {
      exiting = true;
      clearInterval(interval);
      child.stdin.end();
      return;
    }
    if (action === "logs") {
      openDirectory(paths.logs);
      return;
    }
    if (action === "config") {
      openDirectory(files.dir);
      return;
    }
    const labels: Record<string, string> = {
      start: "正在启动 DevSpace…",
      stop: "正在停止 DevSpace…",
      restart: "正在重启 DevSpace…",
      check: "正在检查连接…",
    };
    busy = true;
    activity = labels[action] ?? "正在处理…";
    alert = undefined;
    await refresh(action === "check");
    try {
      if (action === "start") {
        await taskAction("start", runtimeTask);
        if (!await waitForLocal(true, 15_000)) throw new Error("本机服务未在预期时间内启动");
      } else if (action === "stop") {
        await taskAction("stop", runtimeTask);
        if (!await waitForLocal(false, 10_000)) throw new Error("本机服务未在预期时间内停止");
      } else if (action === "restart") {
        await taskAction("stop", runtimeTask);
        await waitForLocal(false, 10_000);
        await taskAction("start", runtimeTask);
        if (!await waitForLocal(true, 15_000)) throw new Error("本机服务未在预期时间内恢复");
      }
    } catch (error) {
      alert = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      activity = undefined;
      await refresh(true).catch((error) => {
        alert = error instanceof Error ? error.message : String(error);
      });
    }
  };

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line) as { event?: string; action?: string };
      if (event.event === "ready" && !ready) {
        ready = true;
        void refresh(true);
        interval = setInterval(() => void refresh().catch(() => {}), 5000);
        interval.unref();
      } else if (event.event === "duplicate") {
        exiting = true;
        child.stdin.end();
      } else if (event.event === "menu" && typeof event.action === "string") {
        void runAction(event.action);
      } else if (event.event === "protocol-error") {
        process.stderr.write("[DevSpace desktop] Native tray protocol error\n");
      }
    } catch {
      process.stderr.write("[DevSpace desktop] Invalid native tray event\n");
    }
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      closed = true;
      resolveExit({ code, signal });
    });
  });
  clearInterval(interval);
  lines.close();
  if (!exiting && (result.signal || result.code !== 0)) {
    throw new Error(`Native tray exited unexpectedly (${result.signal ?? result.code})`);
  }
}

async function desktopStatus(): Promise<Record<string, unknown>> {
  assertWindows();
  const files = loadDevspaceFiles();
  const probe = await probeDesktop(true);
  const installed = files.auth.ownerToken ? Object.fromEntries(await Promise.all(
    COMPONENTS.map(async (component) => [component, await taskExists(desktopTaskName(files.auth.ownerToken!, component))]),
  )) : { runtime: false, tray: false };
  return { installed, ...probe, configDir: files.dir };
}

export async function runDesktopCommand(args: string[]): Promise<void> {
  assertWindows();
  const [subcommand = "status", ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace desktop <install|status|start|stop|restart|uninstall>");
  const files = loadDevspaceFiles();
  const ownerToken = files.auth.ownerToken;
  switch (subcommand) {
    case "install":
      await installDesktop();
      console.log("DevSpace desktop startup and tray are installed and running.");
      return;
    case "status":
      console.log(JSON.stringify(await desktopStatus(), null, 2));
      return;
    case "start":
      if (!ownerToken) throw new Error("DevSpace is not initialized.");
      await taskAction("start", desktopTaskName(ownerToken, "runtime"));
      await taskAction("start", desktopTaskName(ownerToken, "tray"));
      console.log("DevSpace desktop started.");
      return;
    case "stop":
      if (!ownerToken) throw new Error("DevSpace is not initialized.");
      await taskAction("stop", desktopTaskName(ownerToken, "tray"));
      await taskAction("stop", desktopTaskName(ownerToken, "runtime"));
      console.log("DevSpace desktop stopped.");
      return;
    case "restart":
      if (!ownerToken) throw new Error("DevSpace is not initialized.");
      await taskAction("stop", desktopTaskName(ownerToken, "runtime"));
      await waitForLocal(false, 10_000);
      await taskAction("start", desktopTaskName(ownerToken, "runtime"));
      await taskAction("start", desktopTaskName(ownerToken, "tray"));
      console.log("DevSpace desktop restarted.");
      return;
    case "uninstall":
      await uninstallDesktop();
      console.log("DevSpace desktop startup and tray were removed. DevSpace configuration was kept.");
      return;
    case "tray":
      await runTray();
      return;
    case "help":
    case "--help":
    case "-h":
      console.log([
        "DevSpace desktop (Windows)",
        "",
        "  devspace desktop install    Install native background startup and system tray",
        "  devspace desktop status     Show task and connection status",
        "  devspace desktop start      Start runtime and tray",
        "  devspace desktop stop       Stop runtime and tray",
        "  devspace desktop restart    Restart runtime and ensure tray is running",
        "  devspace desktop uninstall  Remove desktop startup/tray; keep configuration",
      ].join("\n"));
      return;
    default:
      throw new Error(`Unknown desktop command: ${subcommand}`);
  }
}
