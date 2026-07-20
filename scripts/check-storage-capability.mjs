import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const SUPPORTED_NODE_RELEASES = new Map([
  [22, 13],
  [24, 3],
  [26, 0],
]);
const SUPPORTED_NODE_LABEL = "Node 22.13+、24.3+ 或 26.x";
const runtime = [
  `Node ${process.version}`,
  `ABI ${process.versions.modules}`,
  `${process.platform}/${process.arch}`,
].join(", ");

function fail(summary, error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[storage-check] ${summary}`);
  console.error(`[storage-check] 当前运行时: ${runtime}`);
  if (detail) console.error(`[storage-check] 详情: ${detail}`);
  console.error(`[storage-check] 请使用 ${SUPPORTED_NODE_LABEL}，并确保依赖由当前 Node 版本安装。`);
  console.error(
    "[storage-check] 若刚切换过 Node 版本，请运行 npm run repair:storage；需要完全重装时运行 npm ci。",
  );
  process.exitCode = 1;
}

const [nodeMajor = Number.NaN, nodeMinor = Number.NaN] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const minimumMinor = SUPPORTED_NODE_RELEASES.get(nodeMajor);
if (minimumMinor === undefined || nodeMinor < minimumMinor) {
  fail(`项目支持 ${SUPPORTED_NODE_LABEL}，检测到 ${process.version}。`, "Node 版本不受支持");
} else {
  let db;
  let probeDirectory;

  try {
    const { default: Database } = await import("better-sqlite3");
    probeDirectory = mkdtempSync(join(tmpdir(), "pico-storage-check-"));
    db = new Database(join(probeDirectory, "capability.sqlite"));

    const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    db.pragma("foreign_keys = ON");
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    if (journalMode !== "wal" || foreignKeys !== 1) {
      throw new Error(`SQLite WAL/foreign_keys 初始化失败 (${journalMode}/${foreignKeys})`);
    }
    db.exec("CREATE TABLE capability_probe (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
    const writeAndRead = db.transaction((content) => {
      db.prepare("INSERT INTO capability_probe(content) VALUES (?)").run(content);
      return db.prepare("SELECT content FROM capability_probe WHERE id = 1").get();
    });
    const row = writeAndRead.immediate("pico storage capability");
    if (row?.content !== "pico storage capability") {
      throw new Error("SQLite immediate transaction 写入或读取校验失败");
    }

    console.log(
      `[storage-check] 通过: ${runtime}, SQLite ${sqliteVersion}, native transaction/WAL`,
    );
  } catch (error) {
    fail("better-sqlite3 原生模块或项目所需 SQLite 能力不可用。", error);
  } finally {
    db?.close();
    if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
  }
}
