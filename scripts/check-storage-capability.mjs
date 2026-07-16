import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const EXPECTED_NODE_MAJOR = 22;
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
  console.error(
    "[storage-check] 请切换到 Node 22，确保当前 worktree 使用独立的 node_modules，然后运行 npm ci。",
  );
  console.error(
    "[storage-check] 若刚切换过 Node 版本，可在 Node 22 下运行 npm rebuild better-sqlite3。",
  );
  process.exitCode = 1;
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor !== EXPECTED_NODE_MAJOR) {
  fail(`项目固定使用 Node ${EXPECTED_NODE_MAJOR}，检测到 Node ${nodeMajor}。`, "Node 版本不匹配");
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
