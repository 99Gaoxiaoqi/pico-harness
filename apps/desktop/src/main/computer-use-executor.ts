import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, desktopCapturer, powerMonitor, screen, systemPreferences } from "electron";
import { scheduleDeadline } from "@pico/runtime/deadline";
import type { JsonObject, RuntimeClientCapabilityCommand } from "@pico/protocol";
import {
  resolveObservedElement,
  type ComputerObservation,
  type ObservedElement,
} from "./computer-observation-guard.js";

/** The model can act only on a recently observed, unchanged Accessibility element. */
export class ComputerUseExecutor {
  private readonly observations = new Map<string, ComputerObservation>();
  private lockedByEvent = false;
  private monitorInstalled = false;

  async execute(
    command: RuntimeClientCapabilityCommand,
    validate?: () => Promise<void>,
  ): Promise<JsonObject> {
    if (process.platform !== "darwin") throw new Error("电脑操作目前只支持 macOS");
    await validate?.();
    this.checkSystemGates();
    if (command.action === "computer.observe") return this.observe(command.sessionId, validate);
    if (command.action === "computer.click" || command.action === "computer.type") {
      return this.act(command, validate);
    }
    throw new Error(`未提供 Desktop MCP 工具执行器: ${command.action}`);
  }

  clearSession(sessionId: string): void {
    this.observations.delete(sessionId);
  }

  private async observe(sessionId: string, validate?: () => Promise<void>): Promise<JsonObject> {
    await validate?.();
    const native = await this.native({ action: "observe" });
    const pid = readInteger(native["frontmostPid"]);
    const elements = readElements(native["elements"]);
    const display = screen.getPrimaryDisplay();
    const bounds = display.bounds;
    const visible = elements.filter((element) => {
      const x = element.x + element.width / 2;
      const y = element.y + element.height / 2;
      return (
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height
      );
    });
    await validate?.();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 900, height: 900 },
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("屏幕录制返回空画面");
    const image = source.thumbnail.toJPEG(55);
    if (image.byteLength > 600_000) throw new Error("观察截图超过安全传输上限");
    const observationId = randomUUID();
    await validate?.();
    this.observations.set(sessionId, { id: observationId, at: Date.now(), pid, elements: visible });
    return {
      observationId,
      capturedAt: Date.now(),
      frontmostApp: String(native["frontmostApp"] ?? ""),
      elements: visible.map((element) => ({
        index: element.index,
        role: element.role,
        title: element.title,
        description: element.description,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      })),
      display: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      imageDataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
    };
  }

  private async act(
    command: RuntimeClientCapabilityCommand,
    validate?: () => Promise<void>,
  ): Promise<JsonObject> {
    const observationId = command.input["observationId"];
    const elementIndex = command.input["elementIndex"];
    if (typeof observationId !== "string" || !Number.isSafeInteger(elementIndex)) {
      throw new Error("电脑操作缺少有效观察编号或元素 index");
    }
    const previous = this.observations.get(command.sessionId);
    await validate?.();
    const current = await this.native({ action: "observe" });
    const fresh = resolveObservedElement({
      previous,
      observationId,
      elementIndex: Number(elementIndex),
      currentPid: readInteger(current["frontmostPid"]),
      currentElements: readElements(current["elements"]),
      now: Date.now(),
    });
    if (
      command.action === "computer.type" &&
      !["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].includes(fresh.role)
    ) {
      throw new Error("目标不是可输入文本的元素，请重新观察");
    }
    const text = command.action === "computer.type" ? command.input["text"] : undefined;
    if (command.action === "computer.type" && (typeof text !== "string" || text.length > 4_096)) {
      throw new Error("输入文本无效");
    }
    await validate?.();
    this.checkSystemGates();
    // The observation is consumed before the first possible native side effect.
    // A partial click or text insertion must require a fresh observation.
    this.observations.delete(command.sessionId);
    await this.native({
      action: "click",
      expectedPid: previous!.pid,
      elementIndex: fresh.index,
      expectedRole: fresh.role,
      expectedTitle: fresh.title,
      expectedDescription: fresh.description,
      expectedX: fresh.x,
      expectedY: fresh.y,
      expectedWidth: fresh.width,
      expectedHeight: fresh.height,
    });
    if (command.action === "computer.type") {
      this.checkSystemGates();
      await validate?.();
      const focused = await this.native({ action: "status" });
      if (readInteger(focused["frontmostPid"]) !== previous!.pid) {
        throw new Error("输入前前台应用已切换");
      }
      const revoked = new AbortController();
      const stopMonitoring = new AbortController();
      const monitor = validate
        ? (async () => {
            while (!stopMonitoring.signal.aborted) {
              try {
                await validate();
              } catch (error) {
                revoked.abort(error);
                return;
              }
              try {
                await delay(50, undefined, { signal: stopMonitoring.signal });
              } catch {
                return;
              }
            }
          })()
        : undefined;
      try {
        for (const part of splitTextForNativeInput(text as string)) {
          this.checkSystemGates();
          await validate?.();
          if (revoked.signal.aborted) throw revoked.signal.reason;
          await this.native(
            { action: "type", text: part, expectedPid: previous!.pid },
            revoked.signal,
          );
        }
        await validate?.();
        if (revoked.signal.aborted) throw revoked.signal.reason;
      } finally {
        stopMonitoring.abort();
        await monitor;
      }
      if (revoked.signal.aborted) throw revoked.signal.reason;
    }
    return { accepted: true, observationConsumed: true };
  }

  private checkSystemGates(): void {
    if (!this.monitorInstalled) {
      powerMonitor.on("lock-screen", () => {
        this.lockedByEvent = true;
      });
      powerMonitor.on("unlock-screen", () => {
        this.lockedByEvent = false;
      });
      this.monitorInstalled = true;
    }
    let idle: string;
    try {
      idle = powerMonitor.getSystemIdleState(1);
    } catch {
      throw new Error("无法确认屏幕锁定状态，已拒绝电脑操作");
    }
    if (idle === "locked") this.lockedByEvent = true;
    else if (idle === "active" || idle === "idle") this.lockedByEvent = false;
    if (this.lockedByEvent) throw new Error("屏幕已锁定，电脑操作被拒绝");
    if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      throw new Error("缺少 macOS 屏幕录制权限");
    }
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      throw new Error("缺少 macOS 辅助功能权限");
    }
  }

  private async native(input: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    if (signal?.aborted)
      throw new Error("电脑输入授权已撤销，可能已输入部分文本", { cause: signal.reason });
    const executable = await this.verifiedExecutable();
    if (signal?.aborted)
      throw new Error("电脑输入授权已撤销，可能已输入部分文本", { cause: signal.reason });
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
    const output: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 256_000) child.kill();
      else output.push(chunk);
    });
    const deadline = scheduleDeadline(() => child.kill(), 5_000);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }).finally(() => {
      deadline.cancel();
      signal?.removeEventListener("abort", abort);
    });
    if (signal?.aborted) {
      throw new Error("电脑输入授权已撤销，可能已输入部分文本", { cause: signal.reason });
    }
    if (exitCode !== 0 || length > 256_000) throw new Error("macOS 电脑操作执行器失败或超时");
    const value = JSON.parse(Buffer.concat(output).toString("utf8")) as unknown;
    if (!isRecord(value)) throw new Error("macOS 电脑操作响应无效");
    if (value["ok"] !== true) throw new Error(String(value["error"] ?? "macOS 电脑操作失败"));
    return value as JsonObject;
  }

  private async verifiedExecutable(): Promise<string> {
    const resourceRoot = app.isPackaged
      ? join(process.resourcesPath, "computer-use")
      : resolve(app.getAppPath(), "../../resources/computer-use");
    const path = join(resourceRoot, `darwin-${process.arch}`, "pico-computer-use");
    const [bytes, checksum] = await Promise.all([
      readFile(path),
      readFile(`${path}.sha256`, "utf8"),
    ]);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (checksum.trim().split(/\s/u)[0] !== actual) throw new Error("macOS 电脑操作执行器校验失败");
    return path;
  }
}

function splitTextForNativeInput(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let units = 0;
  for (const scalar of text) {
    if (part && units + scalar.length > 128) {
      parts.push(part);
      part = "";
      units = 0;
    }
    part += scalar;
    units += scalar.length;
  }
  if (part) parts.push(part);
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("电脑观察响应无效");
  return value;
}

function readElements(value: unknown): ObservedElement[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("电脑观察元素无效");
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("电脑观察元素无效");
    const index = readInteger(item["index"]);
    const values = [item["x"], item["y"], item["width"], item["height"]];
    if (!values.every((part) => typeof part === "number" && Number.isFinite(part))) {
      throw new Error("电脑观察元素坐标无效");
    }
    return {
      index,
      role: String(item["role"] ?? ""),
      title: String(item["title"] ?? ""),
      description: String(item["description"] ?? ""),
      x: Number(item["x"]),
      y: Number(item["y"]),
      width: Number(item["width"]),
      height: Number(item["height"]),
    };
  });
}
