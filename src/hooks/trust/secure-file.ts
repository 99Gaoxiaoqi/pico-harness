import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`拒绝使用符号链接目录: ${path}`);
    if (!stat.isDirectory()) throw new Error(`期望私有目录: ${path}`);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

export async function assertRegularNonSymlink(path: string): Promise<"present" | "missing"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`拒绝读写符号链接: ${path}`);
    if (!stat.isFile()) throw new Error(`期望普通文件: ${path}`);
    return "present";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

export async function writePrivateFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  await assertRegularNonSymlink(path);
  const temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertRegularNonSymlink(path);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeWorkspaceFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`拒绝使用符号链接目录: ${directory}`);
    if (!stat.isDirectory()) throw new Error(`期望目录: ${directory}`);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(directory, { recursive: true });
  }
  await assertRegularNonSymlink(path);
  const temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertRegularNonSymlink(path);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
