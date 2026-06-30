// 全局测试 setup:在所有测试运行前关闭 Session 持久化。
//
// 原因:大量测试用 new Session(id, "/tmp") 直接构造,持久化默认开启会向
// 工作区写 .claw/sessions/ 文件,破坏测试隔离。生产入口不设此变量,自动获得持久化。
//
// 持久化本身的正确性由 tests/session-persistence.test.ts 显式开启(临时目录)单独覆盖。
process.env.PICO_PERSISTENCE = "0";
