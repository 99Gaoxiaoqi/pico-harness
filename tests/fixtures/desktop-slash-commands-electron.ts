import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { registerCommandIpc } from "../../apps/desktop/src/main/command-ipc.js";

const root = process.argv[2]!;
const url = process.argv[3]!;
app.setPath("userData", join(root, "electron"));
const session = (id: unknown) => ({
  sessionId: id,
  workspacePath: "/fixture",
  title: id === "s2" ? "第二个会话" : "原会话",
  createdAt: 1,
  updatedAt: 2,
  status: "active",
});
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const dispose = registerCommandIpc({
    ipcMain,
    trusted: (event) =>
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
    isQuitting: () => false,
    runtime: {
      async request(method: string, params: Record<string, unknown>) {
        if (method === "runs.list") return { runs: [] };
        if (method === "goal.get")
          return {
            goal: {
              currentGoal: {
                id: "g1",
                revision: 1,
                status: "active",
                condition: "完成验收",
                maxIterations: 50,
                iterations: 0,
                tokensAtStart: 0,
                tokensNow: 0,
              },
            },
          };
        if (method === "session.list") return { sessions: [session("s2")] };
        if (method === "session.get") return { session: session(params.sessionId) };
        if (method === "session.send")
          return { session: session(params.sessionId ?? "created-1"), disposition: "started" };
        if (method === "rewind.list")
          return {
            checkpoints: [
              {
                checkpointId: "cp1",
                label: "原始提示",
                createdAt: 1,
                changedFileCount: 1,
                additions: 1,
                deletions: 1,
              },
            ],
          };
        throw new Error(`Unexpected command RPC ${method}`);
      },
    } as never,
  });
  ipcMain.handle("test:native-slash", () => window.webContents.insertText("/"));
  app.on("before-quit", dispose);
  await window.loadURL(url);
}
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
