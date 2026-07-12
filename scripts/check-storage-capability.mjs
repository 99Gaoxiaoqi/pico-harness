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

  try {
    const { default: Database } = await import("better-sqlite3");
    db = new Database(":memory:");

    const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
    const hasFts5 = db
      .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
      .get().enabled;
    if (hasFts5 !== 1) throw new Error("SQLite 未编译 ENABLE_FTS5");

    db.exec("CREATE VIRTUAL TABLE capability_probe USING fts5(content, tokenize='trigram')");
    db.prepare("INSERT INTO capability_probe(content) VALUES (?)").run("pico storage capability");
    const match = db
      .prepare("SELECT content FROM capability_probe WHERE capability_probe MATCH ?")
      .get("storage");
    if (match?.content !== "pico storage capability") {
      throw new Error("FTS5 trigram 写入或检索校验失败");
    }

    console.log(`[storage-check] 通过: ${runtime}, SQLite ${sqliteVersion}, FTS5 trigram`);
  } catch (error) {
    fail("better-sqlite3 原生模块或 FTS5 trigram 不可用。", error);
  } finally {
    db?.close();
  }
}
