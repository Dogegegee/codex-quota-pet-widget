import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..");

describe("project launch files", () => {
  test("includes Windows and macOS one-click launchers", () => {
    const windowsLauncher = fs.readFileSync(path.join(rootDir, "启动额度挂件.cmd"), "utf8");
    const macLauncher = fs.readFileSync(path.join(rootDir, "启动额度挂件.command"), "utf8");

    expect(windowsLauncher).toContain("npm install");
    expect(windowsLauncher).toContain("npm run build");
    expect(windowsLauncher).toContain("Start-Process");
    expect(windowsLauncher).toContain("npm.cmd");
    expect(windowsLauncher).toContain("WindowStyle Hidden");
    expect(macLauncher).toContain("npm install");
    expect(macLauncher).toContain("npm run build");
    expect(macLauncher).toContain("npm start");
    expect(macLauncher).toContain("nohup");
  });

  test("documents agent install prompt and right-click exit", () => {
    const readme = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");
    const mainProcess = fs.readFileSync(path.join(rootDir, "src", "main", "main.js"), "utf8");

    expect(readme).toContain("复制给 Agent 一键安装");
    expect(readme).toContain("https://github.com/Dogegegee/codex-quota-pet-widget.git");
    expect(readme).toContain("docs/effect.png");
    expect(readme).toContain("右键");
    expect(readme).toContain("启动额度挂件.cmd");
    expect(readme).toContain("启动额度挂件.command");
    expect(mainProcess).toContain("requestSingleInstanceLock");
    expect(mainProcess).toContain("second-instance");
    expect(mainProcess).toContain("context-menu");
    expect(mainProcess).toContain("退出额度挂件");
  });
});
