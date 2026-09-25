import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { scheduleDeadline } from "@pico/runtime/deadline";
import { isVerifiedBundledExecutable, resolveBundledSandboxExecutable } from "./backend.js";
import { SandboxViolationError } from "./types.js";

interface NetworkState {
  schema: 1;
  taskId: string;
  profileName: string;
}

export interface WindowsNetworkReceipt {
  schema: 1;
  taskId: string;
  boundaryRevision: number;
  generation: number;
  profileName: string;
  scope: "session" | "once";
  ticket: string;
  expiresAtMs: number;
}

/** Host-owned state for one persisted task. The control directory is never granted to AppContainer. */
export class WindowsTaskNetworkAuthority {
  private readonly statePath: string;
  private readonly broker: string;
  private state: NetworkState | undefined;

  get receiptDirectory(): string { return this.controlRoot; }

  async hasPreparationState(): Promise<boolean> { return (await this.loadState()) !== undefined; }

  /** The Broker checks this marker at admission and again before process resume. */
  async blockNewLaunches(): Promise<void> {
    await this.assertPrivateRoot();
    await writeFile(join(this.controlRoot, "revoking"), "", { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }

  constructor(
    readonly taskId: string,
    readonly controlRoot: string,
    broker = resolveBundledSandboxExecutable("win32"),
  ) {
    if (!taskId || !isAbsolute(controlRoot)) throw new Error("Windows task identity is invalid");
    this.broker = broker;
    this.statePath = join(controlRoot, "state.json");
  }

  async verify(): Promise<boolean> {
    const state = await this.loadState();
    if (!state) return false;
    try {
      const outcome = await this.runBroker("verify", state.profileName);
      return outcome === "match";
    } catch {
      return false;
    }
  }

  /** Prepare only after a user approved task network access. UAC cancellation rejects. */
  async prepare(): Promise<void> {
    const prior = await this.loadState();
    if (prior && (await this.verify())) return;
    const state: NetworkState =
      prior ?? {
        schema: 1,
        taskId: this.taskId,
        profileName: `PicoTaskNetwork.${randomBytes(16).toString("hex")}`,
      };
    await this.assertPrivateRoot();
    const outcome = await this.runBroker("prepare", state.profileName);
    if (outcome !== "applied" && outcome !== "no-change") {
      throw new SandboxViolationError("sandbox_unavailable", "Windows 任务联网准备未完成。");
    }
    this.state = state;
    await this.atomicWrite(this.statePath, state);
    if (!(await this.verify())) {
      throw new SandboxViolationError("sandbox_unavailable", "Windows 任务联网状态验证失败。");
    }
  }

  /** A fresh receipt binds the exact boundary version used by the spawned process. */
  async issueReceipt(input: {
    boundaryRevision: number;
    generation: number;
    scope: "session" | "once";
  }): Promise<string> {
    if (!(await this.verify())) {
      throw new SandboxViolationError("sandbox_unavailable", "Windows 联网准备状态缺失或已撤销。");
    }
    if (!Number.isSafeInteger(input.boundaryRevision) || !Number.isSafeInteger(input.generation)) {
      throw new Error("Windows network boundary version is invalid");
    }
    const state = this.state!;
    await this.assertPrivateRoot();
    const receipt: WindowsNetworkReceipt = {
      schema: 1,
      taskId: this.taskId,
      boundaryRevision: input.boundaryRevision,
      generation: input.generation,
      profileName: state.profileName,
      scope: input.scope,
      ticket: randomBytes(32).toString("hex"),
      expiresAtMs: Date.now() + (input.scope === "once" ? 5 * 60_000 : 60 * 60_000),
    };
    const target = join(this.controlRoot, `${receipt.ticket}.json`);
    await writeFile(target, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    return target;
  }

  /** Stop new launches before invoking this. A failed revoke remains a hard error. */
  async revoke(): Promise<void> {
    const state = await this.loadState();
    if (!state) return;
    const outcome = await this.runBroker("revoke", state.profileName);
    if (outcome !== "revoked" && outcome !== "no-change") {
      throw new SandboxViolationError("sandbox_cleanup_failed", "Windows 任务联网回环例外撤销失败。");
    }
    for (const entry of await readdir(this.controlRoot)) {
      if (/^[a-f0-9]{64}\.(?:json|consumed)$/u.test(entry)) await rm(join(this.controlRoot, entry), { force: true });
    }
    await rm(this.statePath, { force: true });
    this.state = undefined;
    await rm(join(this.controlRoot, "revoking"), { force: true });
  }

  private async loadState(): Promise<NetworkState | undefined> {
    if (this.state) return this.state;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const candidate = raw as Partial<NetworkState>;
    if (
      candidate.schema !== 1 ||
      candidate.taskId !== this.taskId ||
      !/^PicoTaskNetwork\.[a-f0-9]{32}$/u.test(candidate.profileName ?? "")
    ) {
      throw new SandboxViolationError("sandbox_unavailable", "Windows 任务联网状态文件无效。");
    }
    this.state = candidate as NetworkState;
    return this.state;
  }

  private async assertPrivateRoot(): Promise<void> {
    await mkdir(this.controlRoot, { recursive: true, mode: 0o700 });
    const info = await stat(this.controlRoot);
    if (!info.isDirectory() || !existsSync(this.broker) || !isVerifiedBundledExecutable(this.broker, "win32")) {
      throw new SandboxViolationError("sandbox_unavailable", "Windows Broker 缺失或控制目录无效。");
    }
  }

  private async runBroker(operation: "prepare" | "verify" | "revoke", profileName: string): Promise<string> {
    await this.assertPrivateRoot();
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(
        this.broker,
        [
          "--task-network",
          operation,
          "--profile-name",
          profileName,
          "--control-root",
          this.controlRoot,
          ...(operation === "prepare" ? ["--host-pid", String(process.pid)] : []),
          "--json",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      const timer = scheduleDeadline(() => child.kill(), 120_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 16_384) child.kill();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) child.kill();
      });
      child.once("error", (error) => { timer.cancel(); reject(error); });
      child.once("close", (code) => {
        timer.cancel();
        if (code !== 0) {
          reject(new SandboxViolationError("sandbox_unavailable", `Windows 任务联网${operation}失败：${stderr.trim() || String(code)}`));
        } else resolveOutput(stdout);
      });
    });
    let response: unknown;
    try { response = JSON.parse(output.trim()); } catch {
      throw new SandboxViolationError("sandbox_unavailable", "Windows Broker 返回了无效的联网准备响应。");
    }
    const parsed = response as { op?: unknown; result?: unknown; profileName?: unknown };
    if (parsed.op !== `${operation}-task-network` || parsed.profileName !== profileName || typeof parsed.result !== "string") {
      throw new SandboxViolationError("sandbox_unavailable", "Windows Broker 联网准备响应不匹配。");
    }
    return parsed.result;
  }

  private async atomicWrite(path: string, value: NetworkState): Promise<void> {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
