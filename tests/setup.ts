// 全局测试 setup:在所有测试运行前关闭 Session 持久化。
//
// 原因:大量测试用 new Session(id, "/tmp") 直接构造,持久化默认开启会向
// 工作区写 .claw/sessions/ 文件,破坏测试隔离。生产入口不设此变量,自动获得持久化。
//
// 持久化本身的正确性由 tests/session-persistence.test.ts 显式开启(临时目录)单独覆盖。
process.env.PICO_PERSISTENCE = "0";
// 全局 Catalog 默认写 ~/.pico；测试只能通过显式注入的临时 Catalog 验证。
process.env.PICO_SESSION_CATALOG = "0";

// FTS5Store 连接池是模块级单例,测试间若复用同一 workDir(如 /tmp)会跨用例泄漏实例。
// 每个测试结束后清空池 + 关闭所有 SQLite 句柄,保证完全隔离(并释放 Windows 句柄)。
import { afterEach } from "vitest";
import { FTS5Store } from "../src/memory/fts5-store.js";

afterEach(() => {
  FTS5Store.closeAll();
});
