import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { LeaseConflictError } from "../../src/storage/owner-lease.js";

describe("durable Runtime Session ownership", () => {
  let workDir: string;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-owner-"));
  });

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("fails closed for a second live writer and releases ownership on close", async () => {
    const owner = new Session("session-a", workDir, { persistence: true });
    await owner.recover();

    const contender = new Session("session-a", workDir, { persistence: true });
    await expect(contender.recover()).rejects.toBeInstanceOf(LeaseConflictError);
    await contender.close();

    await owner.close();
    const successor = new Session("session-a", workDir, { persistence: true });
    await expect(successor.recover()).resolves.toBeUndefined();
    await successor.close();
  });

  it("fails closed across processes and permits takeover after the owner closes", async () => {
    const root = join(workDir, "owner-process-coordination");
    await mkdir(root);
    const readyPath = join(root, "ready");
    const releasePath = join(root, "release");
    const closedPath = join(root, "closed");
    const moduleUrl = new URL("../../src/engine/session.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", SESSION_OWNER_SCRIPT],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PICO_SESSION_MODULE_URL: moduleUrl,
          PICO_SESSION_OWNER_WORK_DIR: workDir,
          PICO_SESSION_OWNER_READY_PATH: readyPath,
          PICO_SESSION_OWNER_RELEASE_PATH: releasePath,
          PICO_SESSION_OWNER_CLOSED_PATH: closedPath,
          PICO_SESSION_OWNER_SESSION_ID: "session-process",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    const childExit = waitForChild(child).finally(() => children.delete(child));

    await waitForPath(readyPath, child);
    const contender = new Session("session-process", workDir, { persistence: true });
    await expect(contender.recover()).rejects.toBeInstanceOf(LeaseConflictError);
    await contender.close();

    await writeFile(releasePath, "release\n", "utf8");
    await expect(childExit).resolves.toEqual(expect.objectContaining({ code: 0 }));
    await expect(access(closedPath)).resolves.toBeUndefined();

    const successor = new Session("session-process", workDir, { persistence: true });
    await expect(successor.recover()).resolves.toBeUndefined();
    await successor.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});

const SESSION_OWNER_SCRIPT = String.raw`
  import { access, writeFile } from "node:fs/promises";
  import { setTimeout as delay } from "node:timers/promises";

  const {
    PICO_SESSION_MODULE_URL: moduleUrl,
    PICO_SESSION_OWNER_WORK_DIR: workDir,
    PICO_SESSION_OWNER_READY_PATH: readyPath,
    PICO_SESSION_OWNER_RELEASE_PATH: releasePath,
    PICO_SESSION_OWNER_CLOSED_PATH: closedPath,
    PICO_SESSION_OWNER_SESSION_ID: sessionId,
  } = process.env;
  if (!moduleUrl || !workDir || !readyPath || !releasePath || !closedPath || !sessionId) {
    throw new Error("missing Session owner child environment");
  }

  const waitForPath = async (path) => {
    for (;;) {
      try {
        await access(path);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await delay(5);
    }
  };

  const { Session } = await import(moduleUrl);
  const session = new Session(sessionId, workDir, { persistence: true });
  await session.recover();
  await writeFile(readyPath, "ready\n", "utf8");
  await waitForPath(releasePath);
  await session.close();
  await writeFile(closedPath, "closed\n", "utf8");
`;

async function waitForPath(path: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`Session owner child exited before readiness (code ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Session owner child readiness");
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}
