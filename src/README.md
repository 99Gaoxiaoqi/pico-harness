# 根发行包入口

这里不是业务源码目录，只保留根发行包需要的四个进程启动文件：

- `cli/main.ts`：`pico` 可执行入口、预加载与根发行包版本信息。
- `daemon/main.ts`：本机 daemon 可执行入口。
- `internal/headless-one-shot-main.ts`：机器可读的单次执行入口。
- `internal/headless-bootstrap-main.ts`：机器可读的 bootstrap 入口。

业务实现归属 `packages/*/src`，Electron 应用归属 `apps/desktop/src`。
跨模块引用正式 `@pico/*` 导出；不从这里导入模块，不新增 re-export 兼容树。
历史源码路径可通过 Git 查看，不再作为当前代码组织的一部分维护。

`npm run check:architecture` 限定本目录文件清单，并禁止生产代码、测试和工程脚本导入根 `src`。
测试专用默认装配只能位于 `tests/`，不能成为生产代码依赖。
