import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const TEMPORARY_FILE_PREFIX = ".pico-write-";
const MACOS_PROVENANCE_ATTRIBUTE = "com.apple.provenance";
const METADATA_PROBE_MAX_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

interface FileVersion {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface MacExtendedMetadataSnapshot {
  readonly provenanceHex?: string;
}

export type AtomicFilePrecondition =
  | { readonly kind: "missing" }
  | {
      readonly kind: "file";
      readonly version: FileVersion;
      readonly permissionMode: number;
    };

export interface BoundedFileSnapshot {
  readonly content: string;
  readonly precondition: Extract<AtomicFilePrecondition, { kind: "file" }>;
}

export interface AtomicWorkspaceFileWrite {
  readonly targetPath: string;
  readonly content: string;
  readonly precondition: AtomicFilePrecondition;
  /**
   * 重新解析用户最初请求的路径，并确认它仍指向 targetPath。
   * 调用方保留 WorkspaceRoots 的授权语义，原子 helper 不自行扩大根目录。
   */
  readonly revalidateTarget: () => void | Promise<void>;
}

/**
 * 捕获 write_file 发布前的目标状态。lstat 不跟随最后一级符号链接；调用方传入的
 * targetPath 已由 WorkspaceRoots 规范化为授权根内的真实目标。
 */
export async function captureAtomicFilePrecondition(
  targetPath: string,
): Promise<AtomicFilePrecondition> {
  let info: BigIntStats;
  try {
    info = await lstat(targetPath, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }

  assertRegularNonSymlink(info, targetPath);
  return filePrecondition(info);
}

/**
 * 在分配 Buffer 前检查文件大小，并通过同一个 O_NOFOLLOW 文件描述符完成有界读取。
 * 读取前后都验证路径和 inode 版本，避免基于已被替换/并发改写的旧内容发布编辑。
 */
export async function readBoundedFileSnapshot(
  targetPath: string,
  maxBytes: number,
  displayPath: string,
): Promise<BoundedFileSnapshot> {
  const before = await lstat(targetPath, { bigint: true });
  assertRegularNonSymlink(before, displayPath);

  const handle = await open(targetPath, constants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularNonSymlink(opened, displayPath);
    if (!sameFileVersion(toFileVersion(before), toFileVersion(opened))) {
      throw new Error(`读取文件时目标已被替换: ${displayPath}`);
    }
    if (opened.size > BigInt(maxBytes)) {
      throw new Error(
        `文件大小 ${opened.size} 字节，超过 edit_file 上限 ${maxBytes} 字节；请用 grep 先缩小范围。`,
      );
    }

    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const afterOpen = await handle.stat({ bigint: true });
    const afterPath = await lstat(targetPath, { bigint: true });
    const openedVersion = toFileVersion(opened);
    if (
      offset !== buffer.length ||
      !sameFileVersion(openedVersion, toFileVersion(afterOpen)) ||
      !sameFileVersion(openedVersion, toFileVersion(afterPath))
    ) {
      throw new Error(`读取文件时内容发生并发变化: ${displayPath}`);
    }

    return {
      content: buffer.toString("utf8"),
      precondition: filePrecondition(afterPath),
    };
  } finally {
    await handle.close();
  }
}

/**
 * 同目录临时文件 + fsync + rename 发布。发布前目标若被创建、删除、替换或改写，
 * 本次操作会失败并清理临时文件，旧目标不会被提前截断。
 *
 * Node.js 未暴露 openat/renameat 的 dirfd 接口，因此无法从用户态彻底消除恶意进程
 * 在两次系统调用之间替换父目录的理论 TOCTOU 窗口。这里在创建临时文件前、创建后
 * 写入前和 rename 前重复校验父目录身份与原请求解析结果，并用 O_EXCL/O_NOFOLLOW
 * 避免把可观察到的符号链接或父路径替换继续发布为越界写。
 */
export async function writeAtomicWorkspaceFile(input: AtomicWorkspaceFileWrite): Promise<void> {
  const directory = dirname(input.targetPath);
  const directoryIdentity = await captureDirectoryIdentity(directory);

  await input.revalidateTarget();
  await assertDirectoryIdentity(directory, directoryIdentity);
  await assertTargetPrecondition(input.targetPath, input.precondition);
  const macMetadata = await captureMacExtendedMetadata(input.targetPath, input.precondition);

  const temporaryPath = join(
    directory,
    `${TEMPORARY_FILE_PREFIX}${randomBytes(16).toString("hex")}.tmp`,
  );
  const createMode = input.precondition.kind === "file" ? 0o600 : 0o666;
  const bytes = Buffer.from(input.content, "utf8");
  let handle: FileHandle | undefined;
  let temporaryIdentity: FileVersion | undefined;
  let finalizedTemporaryVersion: FileVersion | undefined;
  let published = false;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
      createMode,
    );
    const temporaryInfo = await handle.stat({ bigint: true });
    assertRegularNonSymlink(temporaryInfo, temporaryPath);
    temporaryIdentity = toFileVersion(temporaryInfo);
    const publishedPermissionMode =
      input.precondition.kind === "file"
        ? input.precondition.permissionMode
        : Number(temporaryInfo.mode & 0o777n);
    if (input.precondition.kind === "missing") {
      // 先由 open(0666) 得到与旧实现相同的 umask/default-ACL 模式，再收紧暂存权限。
      await handle.chmod(0o600);
    }

    // open() 也使用路径；先确认它确实发生在刚才校验的父目录，再写入用户内容。
    await input.revalidateTarget();
    await assertDirectoryIdentity(directory, directoryIdentity);

    await writeAll(handle, bytes);
    if (input.precondition.kind === "file") {
      await preserveOwnership(handle, input.precondition.version, temporaryPath);
    }
    // 只发布普通 rwx 位。覆盖时不复活 setuid/setgid/sticky；新建时保持 0666 + umask。
    await handle.chmod(publishedPermissionMode);
    await handle.sync();
    await assertMacExtendedMetadataPreserved(temporaryPath, macMetadata);
    const finalizedTemporary = await handle.stat({ bigint: true });
    assertPreparedTemporary(
      finalizedTemporary,
      temporaryIdentity,
      input.precondition,
      publishedPermissionMode,
      bytes.length,
      temporaryPath,
    );
    finalizedTemporaryVersion = toFileVersion(finalizedTemporary);
    await handle.close();
    handle = undefined;

    await input.revalidateTarget();
    await assertDirectoryIdentity(directory, directoryIdentity);
    await assertTargetPrecondition(input.targetPath, input.precondition);
    await assertTemporaryVersion(temporaryPath, finalizedTemporaryVersion);
    await rename(temporaryPath, input.targetPath);
    published = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published && temporaryIdentity) {
      await unlinkIfSameFile(temporaryPath, temporaryIdentity);
    }
  }
}

async function captureMacExtendedMetadata(
  targetPath: string,
  precondition: AtomicFilePrecondition,
): Promise<MacExtendedMetadataSnapshot | undefined> {
  if (process.platform !== "darwin" || precondition.kind !== "file") return undefined;

  const [attributeOutput, aclOutput] = await Promise.all([
    runMacMetadataProbe("/usr/bin/xattr", [targetPath], targetPath),
    runMacMetadataProbe("/bin/ls", ["-lde", targetPath], targetPath),
  ]);
  if (hasExtendedAcl(aclOutput)) {
    throw new Error(`目标文件包含无法保真的扩展 ACL，已拒绝覆盖: ${targetPath}`);
  }

  const attributeNames = parseAttributeNames(attributeOutput);
  // macOS 会自动给新文件附加 provenance；只有临时文件能逐字匹配该值时才允许覆盖。
  // 其他扩展属性没有可靠的 fd 级复制接口，因此一律在创建临时文件前拒绝。
  if (
    attributeNames.length > 1 ||
    attributeNames.some((name) => name !== MACOS_PROVENANCE_ATTRIBUTE)
  ) {
    throw new Error(`目标文件包含无法保真的扩展属性，已拒绝覆盖: ${targetPath}`);
  }

  if (attributeNames.length === 0) return {};
  return {
    provenanceHex: await readMacProvenanceHex(targetPath),
  };
}

async function assertMacExtendedMetadataPreserved(
  temporaryPath: string,
  expected: MacExtendedMetadataSnapshot | undefined,
): Promise<void> {
  if (!expected) return;

  const [attributeOutput, aclOutput] = await Promise.all([
    runMacMetadataProbe("/usr/bin/xattr", [temporaryPath], temporaryPath),
    runMacMetadataProbe("/bin/ls", ["-lde", temporaryPath], temporaryPath),
  ]);
  const attributeNames = parseAttributeNames(attributeOutput);
  const expectedAttributeNames =
    expected.provenanceHex === undefined ? [] : [MACOS_PROVENANCE_ATTRIBUTE];
  if (
    hasExtendedAcl(aclOutput) ||
    attributeNames.length !== expectedAttributeNames.length ||
    attributeNames.some((name, index) => name !== expectedAttributeNames[index])
  ) {
    throw new Error(`无法保真复制目标文件扩展元数据，已拒绝覆盖: ${temporaryPath}`);
  }

  if (
    expected.provenanceHex !== undefined &&
    (await readMacProvenanceHex(temporaryPath)) !== expected.provenanceHex
  ) {
    throw new Error(`无法保真复制目标文件扩展属性，已拒绝覆盖: ${temporaryPath}`);
  }
}

async function readMacProvenanceHex(path: string): Promise<string> {
  const output = await runMacMetadataProbe(
    "/usr/bin/xattr",
    ["-px", MACOS_PROVENANCE_ATTRIBUTE, path],
    path,
  );
  const normalized = output.replaceAll(/\s/gu, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/u.test(normalized)) {
    throw new Error(`无法验证目标文件扩展属性，已拒绝覆盖: ${path}`);
  }
  return normalized;
}

async function runMacMetadataProbe(
  command: "/usr/bin/xattr" | "/bin/ls",
  args: readonly string[],
  path: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: METADATA_PROBE_MAX_BYTES,
    });
    return stdout;
  } catch (error) {
    throw new Error(`无法验证目标文件扩展元数据，已拒绝覆盖: ${path}`, { cause: error });
  }
}

function parseAttributeNames(output: string): string[] {
  return output.split(/\r?\n/u).filter((name) => name.length > 0);
}

function hasExtendedAcl(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .slice(1)
    .some((line) => /^\s*\d+:/u.test(line));
}

async function captureDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const info = await lstat(directory, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`写入目标的父路径不是普通目录: ${directory}`);
  }
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await lstat(directory, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error(`写入过程中父目录已被替换: ${directory}`);
  }
}

async function assertTargetPrecondition(
  targetPath: string,
  expected: AtomicFilePrecondition,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(targetPath, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") && expected.kind === "missing") return;
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(`写入过程中目标文件已被删除: ${targetPath}`, { cause: error });
    }
    throw error;
  }

  if (expected.kind === "missing") {
    throw new Error(`写入过程中目标文件已被创建: ${targetPath}`);
  }
  assertRegularNonSymlink(current, targetPath);
  if (!sameFileVersion(expected.version, toFileVersion(current))) {
    throw new Error(`写入过程中目标文件已被替换或修改: ${targetPath}`);
  }
}

async function preserveOwnership(
  handle: FileHandle,
  expected: FileVersion,
  temporaryPath: string,
): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (current.uid === expected.uid && current.gid === expected.gid) return;

  const uid = safeIdentityNumber(expected.uid, "uid", temporaryPath);
  const gid = safeIdentityNumber(expected.gid, "gid", temporaryPath);
  try {
    await handle.chown(uid, gid);
  } catch (error) {
    throw new Error(`无法保留原文件所有者，已拒绝发布: ${temporaryPath}`, { cause: error });
  }
}

function safeIdentityNumber(value: bigint, label: "uid" | "gid", path: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`原文件 ${label} 无法安全表示，已拒绝发布: ${path}`);
  }
  return number;
}

function assertPreparedTemporary(
  info: BigIntStats,
  created: FileVersion,
  expected: AtomicFilePrecondition,
  permissionMode: number,
  expectedBytes: number,
  path: string,
): void {
  assertRegularNonSymlink(info, path);
  if (info.size !== BigInt(expectedBytes)) {
    throw new Error(`临时文件大小校验失败: ${path}`);
  }
  const expectedOwner = expected.kind === "file" ? expected.version : created;
  if (info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid) {
    throw new Error(`临时文件所有者校验失败，已拒绝发布: ${path}`);
  }
  if (Number(info.mode & 0o777n) !== permissionMode) {
    throw new Error(`临时文件权限校验失败，已拒绝发布: ${path}`);
  }
}

async function assertTemporaryVersion(path: string, expected: FileVersion): Promise<void> {
  const current = await lstat(path, { bigint: true });
  assertRegularNonSymlink(current, path);
  if (!sameFileVersion(expected, toFileVersion(current))) {
    throw new Error(`发布前临时文件已被替换或修改: ${path}`);
  }
}

async function unlinkIfSameFile(path: string, expected: FileVersion): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (
      !current.isSymbolicLink() &&
      current.isFile() &&
      sameFileIdentity(expected, toFileVersion(current))
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) throw error;
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten === 0) throw new Error("文件写入未取得进展");
    offset += bytesWritten;
  }
}

function filePrecondition(info: BigIntStats): Extract<AtomicFilePrecondition, { kind: "file" }> {
  return {
    kind: "file",
    version: toFileVersion(info),
    permissionMode: Number(info.mode & 0o777n),
  };
}

function toFileVersion(info: BigIntStats): FileVersion {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameFileIdentity(left: FileVersion, right: FileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: FileVersion, right: FileVersion): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertRegularNonSymlink(info: BigIntStats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`路径不是普通文件: ${path}`);
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
