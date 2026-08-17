import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

/**
 * 用户配置私有性断言的平台化封装。
 *
 * POSIX：UserConfigStore 经 chmod 保证目录 0o700 / 文件 0o600，直接校验 mode 位。
 * Windows：Node 的 chmod 只切换只读属性，stat 报告的权限位恒为 0o666（文件）/
 * 0o777（目录）；真实防护在 NTFS ACL（用户目录默认仅当前用户可写），不在本层，
 * 故跳过 mode 断言——秘密不上 wire / 不落投影的行为断言仍全平台真跑。
 */
export async function assertPrivatePermissions(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, kind === "directory" ? 0o700 : 0o600);
}
