import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopTrayState,
  desktopTaskName,
  windowsDesktopTaskXml,
} from "./desktop-windows.js";

test("desktop task names are stable and do not expose the owner token", () => {
  const token = "owner-token-that-must-not-appear-in-the-task-name";
  const runtime = desktopTaskName(token, "runtime");
  const tray = desktopTaskName(token, "tray");

  assert.match(runtime, /^com\.devspace\.[a-f0-9]{16}\.runtime$/);
  assert.match(tray, /^com\.devspace\.[a-f0-9]{16}\.tray$/);
  assert.equal(runtime.includes(token), false);
  assert.equal(desktopTaskName(token, "runtime"), runtime);
});

test("Windows task XML uses the copied native launcher and quiet user-session lifecycle", () => {
  const xml = windowsDesktopTaskXml({
    component: "runtime",
    ownerToken: "owner-token",
    sid: "S-1-5-21-1000",
    paths: {
      home: "C:\\Users\\test\\.devspace",
      packageRoot: "C:\\npm\\node_modules\\@waishnav\\devspace",
      cli: "C:\\npm\\node_modules\\@waishnav\\devspace\\dist\\cli.js",
      node: "C:\\node\\node.exe",
      launcher: "C:\\Users\\test\\.devspace\\desktop\\bin\\devspace-launcher.exe",
      tray: "C:\\Users\\test\\.devspace\\desktop\\bin\\devspace-tray.exe",
      logs: "C:\\Users\\test\\.devspace\\logs",
      startup: "C:\\Users\\test\\.devspace\\desktop\\startup",
    },
    widgets: "off",
    trustProxy: "1",
    nodeOptions: "--max-old-space-size=6144",
  });

  assert.match(xml, /InteractiveToken/);
  assert.match(xml, /LeastPrivilege/);
  assert.match(xml, /RestartOnFailure/);
  assert.match(xml, /devspace-launcher\.exe/);
  assert.match(xml, /DEVSPACE_CONFIG_DIR=/);
  assert.match(xml, /DEVSPACE_TRUST_PROXY=1/);
  assert.match(xml, /DEVSPACE_WIDGETS=off/);
  assert.match(xml, /--max-old-space-size=6144/);
  assert.doesNotMatch(xml, /powershell\.exe|wscript\.exe|cmd\.exe/i);
});

test("tray projection exposes start, stop, restart and public health without enterprise controls", () => {
  const ready = createDesktopTrayState({
    local: true,
    public: true,
    publicBaseUrl: "https://devspace.example.com",
    host: "127.0.0.1",
    port: 7676,
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.iconStatus, "ready");
  assert.equal(ready.menu.some((item) => item.action === "stop"), true);
  assert.equal(ready.menu.some((item) => item.action === "restart" && item.enabled), true);
  assert.equal(JSON.stringify(ready.menu).includes("Access Key"), false);
  assert.equal(JSON.stringify(ready.menu).includes("Enrollment"), false);

  const partial = createDesktopTrayState({
    local: true,
    public: false,
    publicBaseUrl: "https://devspace.example.com",
    host: "127.0.0.1",
    port: 7676,
  });
  assert.equal(partial.status, "partial");
  assert.match(partial.tooltip, /公网连接异常/);

  const stopped = createDesktopTrayState({
    local: false,
    public: null,
    publicBaseUrl: null,
    host: "127.0.0.1",
    port: 7676,
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.menu.some((item) => item.action === "start" && item.enabled), true);
});
