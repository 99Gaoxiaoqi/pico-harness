// 资源访问冲突判定单测(对标 kimi-code ToolAccesses.conflict)。
// 验证三层短路:all 互斥 → 操作含写 → 路径重叠。

import { describe, expect, it } from "vitest";
import { ToolAccesses } from "../src/tools/tool-access.js";

describe("ToolAccesses.conflict 资源冲突判定", () => {
  it("两个无副作用工具(read none)互不冲突", () => {
    expect(ToolAccesses.conflict(ToolAccesses.none(), ToolAccesses.none())).toBe(false);
  });

  it("read + read 同文件 → 不冲突(并行)", () => {
    const a = ToolAccesses.readFile("/app/a.ts");
    const b = ToolAccesses.readFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(false);
  });

  it("read + read 不同文件 → 不冲突", () => {
    expect(ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.readFile("/b"))).toBe(
      false,
    );
  });

  it("write + write 不同文件 → 不冲突(并行) ← 旧二元模型做不到", () => {
    const a = ToolAccesses.writeFile("/app/a.ts");
    const b = ToolAccesses.writeFile("/app/b.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(false);
  });

  it("write + read 同文件 → 冲突(串行)", () => {
    const a = ToolAccesses.writeFile("/app/a.ts");
    const b = ToolAccesses.readFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("write + write 同文件 → 冲突", () => {
    const a = ToolAccesses.writeFile("/app/a.ts");
    const b = ToolAccesses.writeFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("readwrite(Edit) + write 同文件 → 冲突", () => {
    const a = ToolAccesses.readWriteFile("/app/a.ts");
    const b = ToolAccesses.writeFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("readwrite(Edit) + read 同文件 → 冲突(Edit 先读后写,与并发读冲突)", () => {
    const a = ToolAccesses.readWriteFile("/app/a.ts");
    const b = ToolAccesses.readFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("all() 与有资源的访问冲突(bash 全局互斥)", () => {
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.readFile("/a"))).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.writeFile("/a"))).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.all())).toBe(true);
  });

  it("all() 与 none() 不冲突(none 无副作用,可与 bash 并行)", () => {
    // none() ��空访问集,all() 找不到资源与之匹配 → 不冲突。
    // 语义正确:echo / web 查询无副作用,与任意工具并行都安全。
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.none())).toBe(false);
    expect(ToolAccesses.conflict(ToolAccesses.none(), ToolAccesses.all())).toBe(false);
  });

  it("冲突判定对称:conflict(a,b) === conflict(b,a)", () => {
    const a = ToolAccesses.writeFile("/a");
    const b = ToolAccesses.readFile("/a");
    expect(ToolAccesses.conflict(a, b)).toBe(ToolAccesses.conflict(b, a));
  });
});

describe("ToolAccesses 路径归一化(跨平台一致)", () => {
  it("反斜杠与正斜杠视为同一资源(Windows 兼容)", () => {
    const win = ToolAccesses.writeFile("D:\\app\\a.ts");
    const posix = ToolAccesses.readFile("d:/app/a.ts");
    expect(ToolAccesses.conflict(win, posix)).toBe(true);
  });

  it("大小写不敏感:Foo 与 foo 视为同一资源", () => {
    const a = ToolAccesses.writeFile("/app/Foo.ts");
    const b = ToolAccesses.readFile("/app/foo.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("尾斜杠差异不影响判定", () => {
    const a = ToolAccesses.writeFile("/app/dir/");
    const b = ToolAccesses.readFile("/app/dir");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });

  it("重复斜杠被合并", () => {
    const a = ToolAccesses.writeFile("/app//a.ts");
    const b = ToolAccesses.readFile("/app/a.ts");
    expect(ToolAccesses.conflict(a, b)).toBe(true);
  });
});
