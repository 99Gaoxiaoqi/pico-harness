import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename, stat, statfs, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
// Node 未暴露 Linux O_PATH；该稳定 ABI 标志让覆盖绑定目标 inode 而不额外要求读权限。
const LINUX_O_PATH_FLAG = 0o10000000;
// Linux O_TMPFILE 的高位在当前支持架构上一致，O_DIRECTORY 则由 Node 提供架构值。
const LINUX_O_TMPFILE_FLAG = 0o20000000 | (constants.O_DIRECTORY ?? 0);
const TEMPORARY_FILE_PREFIX = ".pico-write-";
const METADATA_PROBE_PREFIX = ".pico-metadata-probe-";
const MACOS_PROVENANCE_ATTRIBUTE = "com.apple.provenance";
const LINUX_CAPABILITY_ATTRIBUTE = "security.capability";
const LINUX_POSIX_ACL_ATTRIBUTE = "system.posix_acl_access";
const LINUX_PROC_SUPER_MAGIC = 0x9fa0n;
const METADATA_PROBE_MAX_BYTES = 256 * 1024;
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

interface LinuxMetadataSource {
  readonly handle: FileHandle;
  readonly version: FileVersion;
  readonly attributes: ReadonlyMap<string, string>;
  readonly permissionMode: number;
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
  const linuxMetadataSource = await openLinuxMetadataSource(
    input.targetPath,
    input.precondition,
    directory,
  );

  const temporaryPath = join(
    directory,
    `${TEMPORARY_FILE_PREFIX}${randomBytes(16).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(input.content, "utf8");
  let handle: FileHandle | undefined;
  let temporaryIdentity: FileVersion | undefined;
  let finalizedTemporaryVersion: FileVersion | undefined;
  let published = false;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
      0o600,
    );
    const temporaryInfo = await handle.stat({ bigint: true });
    assertRegularNonSymlink(temporaryInfo, temporaryPath);
    temporaryIdentity = toFileVersion(temporaryInfo);
    const publishedPermissionMode =
      input.precondition.kind === "file"
        ? input.precondition.permissionMode
        : (linuxMetadataSource?.permissionMode ?? 0o666 & ~process.umask());
    if (linuxMetadataSource) {
      // 暂存阶段只迁移不会放宽访问的 user.* 属性；ACL 延迟到内容完整且发布前
      // 路径复核通过后再应用，其他安全 namespace 只接受同目录自然继承的相同值。
      await stageLinuxExtendedMetadata(
        linuxMetadataSource,
        handle,
        temporaryIdentity,
        temporaryPath,
      );
    }

    if (linuxMetadataSource) await handle.truncate(0);
    // open() 也使用路径；先确认它确实发生在刚才校验的父目录，再写入用户内容。
    await input.revalidateTarget();
    await assertDirectoryIdentity(directory, directoryIdentity);

    await writeAll(handle, bytes);
    await handle.sync();
    const stagedTemporaryVersion = toFileVersion(await handle.stat({ bigint: true }));

    // 在放宽 owner/mode/ACL 前完成最后一次原请求复核；失败时临时文件仍保持 0600。
    await input.revalidateTarget();
    await assertDirectoryIdentity(directory, directoryIdentity);
    await assertTargetPrecondition(input.targetPath, input.precondition);
    await assertTemporaryVersion(temporaryPath, stagedTemporaryVersion);

    if (input.precondition.kind === "file") {
      await preserveOwnership(handle, input.precondition.version, temporaryPath);
    }
    // Linux 仍在 0600 时先移除临时 inode 的继承 ACL；源 ACL 存在时由单次
    // setxattr 原子建立最终 ACL/mode，避免先恢复宽 mode 再补拒绝 ACL 的暴露窗口。
    if (linuxMetadataSource) {
      await finalizeLinuxExtendedMetadata(handle, linuxMetadataSource, temporaryPath);
      if (linuxMetadataSource.attributes.has(LINUX_POSIX_ACL_ATTRIBUTE)) {
        await assertPublishedPermissionMode(handle, publishedPermissionMode, temporaryPath);
      } else {
        await handle.chmod(publishedPermissionMode);
      }
    } else {
      // 只发布普通 rwx 位。覆盖时不复活 setuid/setgid/sticky；新建时保持 0666 + umask。
      await handle.chmod(publishedPermissionMode);
    }
    await handle.sync();
    const beforeMetadataVerification = await handle.stat({ bigint: true });
    await assertMacExtendedMetadataPreserved(temporaryPath, macMetadata);
    await assertLinuxExtendedMetadataPreserved(handle, linuxMetadataSource, temporaryPath);
    const finalizedTemporary = await handle.stat({ bigint: true });
    if (
      !sameFileVersion(toFileVersion(beforeMetadataVerification), toFileVersion(finalizedTemporary))
    ) {
      throw new Error(`验证扩展元数据时临时文件发生并发变化: ${temporaryPath}`);
    }
    assertPreparedTemporary(
      finalizedTemporary,
      temporaryIdentity,
      input.precondition,
      publishedPermissionMode,
      bytes.length,
      temporaryPath,
    );
    finalizedTemporaryVersion = toFileVersion(finalizedTemporary);
    if (!linuxMetadataSource) {
      await handle.close();
      handle = undefined;
      await input.revalidateTarget();
    }

    await assertDirectoryIdentity(directory, directoryIdentity);
    await assertTargetPrecondition(input.targetPath, input.precondition);
    await assertTemporaryVersion(temporaryPath, finalizedTemporaryVersion);
    await rename(temporaryPath, input.targetPath);
    published = true;
  } finally {
    if (!published && linuxMetadataSource) await handle?.chmod(0).catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await linuxMetadataSource?.handle.close().catch(() => undefined);
    if (!published && temporaryIdentity) {
      await unlinkIfSameFile(temporaryPath, temporaryIdentity);
    }
  }
}

async function openLinuxMetadataSource(
  targetPath: string,
  precondition: AtomicFilePrecondition,
  directory: string,
): Promise<LinuxMetadataSource | undefined> {
  if (process.platform !== "linux") return undefined;
  if (precondition.kind === "missing") return openLinuxCreationMetadataProbe(directory);
  let handle: FileHandle | undefined;
  try {
    handle = await open(targetPath, LINUX_O_PATH_FLAG | NO_FOLLOW_FLAG);
    const info = await handle.stat({ bigint: true });
    assertRegularNonSymlink(info, targetPath);
    if (!sameFileVersion(precondition.version, toFileVersion(info))) {
      throw new Error(`复制扩展元数据前目标文件已被替换或修改: ${targetPath}`);
    }
    const attributes = await readLinuxExtendedAttributes(handle, targetPath);
    const after = await handle.stat({ bigint: true });
    if (!sameFileVersion(precondition.version, toFileVersion(after))) {
      throw new Error(`读取扩展元数据时目标文件发生并发变化: ${targetPath}`);
    }
    return {
      handle,
      version: precondition.version,
      attributes,
      permissionMode: precondition.permissionMode,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new Error(`无法绑定 Linux 目标元数据，已拒绝覆盖: ${targetPath}`, { cause: error });
  }
}

async function openLinuxCreationMetadataProbe(directory: string): Promise<LinuxMetadataSource> {
  let handle: FileHandle | undefined;
  let namedProbePath: string | undefined;
  let namedProbeIdentity: FileVersion | undefined;
  try {
    try {
      handle = await open(
        directory,
        constants.O_RDWR | constants.O_EXCL | NO_FOLLOW_FLAG | LINUX_O_TMPFILE_FLAG,
        0o666,
      );
    } catch (error) {
      if (!isUnsupportedAnonymousTemporaryFileError(error)) throw error;
      namedProbePath = join(
        directory,
        `${METADATA_PROBE_PREFIX}${randomBytes(16).toString("hex")}.tmp`,
      );
      handle = await open(
        namedProbePath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
        0o666,
      );
      const namedInfo = await handle.stat({ bigint: true });
      assertRegularNonSymlink(namedInfo, namedProbePath);
      namedProbeIdentity = toFileVersion(namedInfo);
      await unlinkIfSameFile(namedProbePath, namedProbeIdentity);
    }

    const probeInfo = await handle.stat({ bigint: true });
    assertRegularNonSymlink(probeInfo, directory);
    if (probeInfo.nlink !== 0n || probeInfo.size !== 0n) {
      throw new Error("new-file metadata probe is not an empty unlinked inode");
    }
    const version = toFileVersion(probeInfo);
    const attributes = await readLinuxExtendedAttributes(handle, directory);
    const after = await handle.stat({ bigint: true });
    if (!sameFileVersion(version, toFileVersion(after))) {
      throw new Error("new-file metadata probe changed while being inspected");
    }
    return {
      handle,
      version,
      attributes,
      permissionMode: Number(probeInfo.mode & 0o777n),
    };
  } catch (error) {
    if (namedProbePath && namedProbeIdentity) {
      await unlinkIfSameFile(namedProbePath, namedProbeIdentity).catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    throw new Error(`无法安全推导 Linux 新文件权限，已拒绝创建: ${directory}`, {
      cause: error,
    });
  }
}

function isUnsupportedAnonymousTemporaryFileError(error: unknown): boolean {
  return ["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].some((code) =>
    hasErrnoCode(error, code),
  );
}

async function stageLinuxExtendedMetadata(
  source: LinuxMetadataSource,
  destination: FileHandle,
  expectedDestination: FileVersion,
  temporaryPath: string,
): Promise<void> {
  const sourceDescriptorPath = linuxDescriptorPath(source.handle);
  const currentAttributes = await readLinuxExtendedAttributes(destination, temporaryPath);
  assertSupportedLinuxAttributeNamespaces(source.attributes, sourceDescriptorPath);
  assertSupportedLinuxAttributeNamespaces(currentAttributes, temporaryPath);

  // SELinux/IMA/EVM/trusted/system 等语义可能与内容或 LSM 绑定，绝不能在写入后
  // 重新附加。只有临时 inode 已从同目录自然继承完全相同的值时才继续。
  for (const [name, value] of source.attributes) {
    if (isManagedLinuxAttribute(name)) continue;
    if (currentAttributes.get(name) !== value) {
      throw new Error(`目标含无法安全迁移的 Linux 扩展属性，已拒绝覆盖: ${temporaryPath}`);
    }
  }
  for (const [name, value] of currentAttributes) {
    if (isManagedLinuxAttribute(name)) continue;
    if (source.attributes.get(name) !== value) {
      throw new Error(`临时文件含无法安全迁移的 Linux 扩展属性，已拒绝覆盖: ${temporaryPath}`);
    }
  }

  for (const [name, value] of sortedLinuxAttributes(source.attributes)) {
    if (!isUserLinuxAttribute(name)) continue;
    if (currentAttributes.get(name) === value) continue;
    await setLinuxExtendedAttribute(destination, name, value, temporaryPath);
  }
  for (const name of [...currentAttributes.keys()].sort()) {
    if (!isUserLinuxAttribute(name) || source.attributes.has(name)) continue;
    await removeLinuxExtendedAttribute(destination, name, temporaryPath);
  }

  const [sourceAfter, destinationAfter] = await Promise.all([
    source.handle.stat({ bigint: true }),
    destination.stat({ bigint: true }),
  ]);
  assertRegularNonSymlink(sourceAfter, sourceDescriptorPath);
  assertRegularNonSymlink(destinationAfter, temporaryPath);
  if (!sameFileVersion(source.version, toFileVersion(sourceAfter))) {
    throw new Error(`复制扩展元数据时源文件发生并发变化: ${sourceDescriptorPath}`);
  }
  if (!sameFileIdentity(expectedDestination, toFileVersion(destinationAfter))) {
    throw new Error(`复制扩展元数据时临时文件已被替换: ${temporaryPath}`);
  }
}

async function finalizeLinuxExtendedMetadata(
  destination: FileHandle,
  source: LinuxMetadataSource | undefined,
  temporaryPath: string,
): Promise<void> {
  if (!source) return;
  const current = await readLinuxExtendedAttributes(destination, temporaryPath);

  for (const [name, value] of sortedLinuxAttributes(source.attributes)) {
    if (!isUserLinuxAttribute(name) || current.get(name) === value) continue;
    await setLinuxExtendedAttribute(destination, name, value, temporaryPath);
  }
  for (const name of [...current.keys()].sort()) {
    if (isUserLinuxAttribute(name) && !source.attributes.has(name)) {
      await removeLinuxExtendedAttribute(destination, name, temporaryPath);
    }
  }

  if (current.has(LINUX_CAPABILITY_ATTRIBUTE)) {
    await removeLinuxExtendedAttribute(destination, LINUX_CAPABILITY_ATTRIBUTE, temporaryPath);
  }
  const expectedAcl = source.attributes.get(LINUX_POSIX_ACL_ATTRIBUTE);
  if (expectedAcl === undefined) {
    if (current.has(LINUX_POSIX_ACL_ATTRIBUTE)) {
      await removeLinuxExtendedAttribute(destination, LINUX_POSIX_ACL_ATTRIBUTE, temporaryPath);
    }
  } else if (current.get(LINUX_POSIX_ACL_ATTRIBUTE) !== expectedAcl) {
    await setLinuxExtendedAttribute(
      destination,
      LINUX_POSIX_ACL_ATTRIBUTE,
      expectedAcl,
      temporaryPath,
    );
  }
}

async function assertPublishedPermissionMode(
  handle: FileHandle,
  expectedMode: number,
  temporaryPath: string,
): Promise<void> {
  const info = await handle.stat({ bigint: true });
  if (Number(info.mode & 0o777n) !== expectedMode) {
    throw new Error(`Linux ACL 未能原子建立目标权限，已拒绝覆盖: ${temporaryPath}`);
  }
}

async function assertLinuxExtendedMetadataPreserved(
  destination: FileHandle,
  source: LinuxMetadataSource | undefined,
  temporaryPath: string,
): Promise<void> {
  if (!source) return;
  const actual = await readLinuxExtendedAttributes(destination, temporaryPath);
  const expected = publishedLinuxAttributes(source.attributes);
  if (!sameLinuxAttributes(actual, expected)) {
    throw new Error(`无法保真复制 Linux ACL/扩展属性，已拒绝覆盖: ${temporaryPath}`);
  }
}

async function readLinuxExtendedAttributes(
  handle: FileHandle,
  displayPath: string,
): Promise<ReadonlyMap<string, string>> {
  let lastError: unknown;
  for (const command of ["/usr/bin/getfattr", "/bin/getfattr"] as const) {
    try {
      const descriptorPath = await assertLinuxDescriptorBinding(handle, displayPath);
      const { stdout, stderr } = await execFileAsync(
        command,
        ["--absolute-names", "--dump", "--match=-", "--encoding=hex", "--", descriptorPath],
        linuxMetadataProcessOptions(),
      );
      if (stderr.length > 0) {
        throw new Error("getfattr reported an incomplete metadata read");
      }
      await assertLinuxDescriptorBinding(handle, displayPath);
      return parseLinuxAttributeDump(stdout, displayPath);
    } catch (error) {
      lastError = error;
      if (!hasErrnoCode(error, "ENOENT")) break;
    }
  }
  throw new Error(`无法读取 Linux ACL/扩展属性，已拒绝覆盖: ${displayPath}`, {
    cause: lastError,
  });
}

async function setLinuxExtendedAttribute(
  handle: FileHandle,
  name: string,
  value: string,
  displayPath: string,
): Promise<void> {
  await runLinuxSetfattr(handle, ["--name", name, "--value", value], displayPath);
}

async function removeLinuxExtendedAttribute(
  handle: FileHandle,
  name: string,
  displayPath: string,
): Promise<void> {
  await runLinuxSetfattr(handle, ["--remove", name], displayPath);
}

async function runLinuxSetfattr(
  handle: FileHandle,
  args: readonly string[],
  displayPath: string,
): Promise<void> {
  let lastError: unknown;
  for (const command of ["/usr/bin/setfattr", "/bin/setfattr"] as const) {
    try {
      const descriptorPath = await assertLinuxDescriptorBinding(handle, displayPath);
      const { stderr } = await execFileAsync(
        command,
        [...args, "--", descriptorPath],
        linuxMetadataProcessOptions(),
      );
      if (stderr.length > 0) {
        throw new Error("setfattr reported an incomplete metadata write");
      }
      await assertLinuxDescriptorBinding(handle, displayPath);
      return;
    } catch (error) {
      lastError = error;
      if (!hasErrnoCode(error, "ENOENT")) break;
    }
  }
  throw new Error(`无法写入 Linux ACL/扩展属性，已拒绝覆盖: ${displayPath}`, {
    cause: lastError,
  });
}

async function assertLinuxDescriptorBinding(
  handle: FileHandle,
  displayPath: string,
): Promise<string> {
  const descriptorPath = linuxDescriptorPath(handle);
  try {
    const [filesystem, linkInfo, pathInfo, handleInfo] = await Promise.all([
      statfs(dirname(descriptorPath), { bigint: true }),
      lstat(descriptorPath, { bigint: true }),
      stat(descriptorPath, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (filesystem.type !== LINUX_PROC_SUPER_MAGIC || !linkInfo.isSymbolicLink()) {
      throw new Error("descriptor path is not a procfs symlink");
    }
    assertRegularNonSymlink(pathInfo, descriptorPath);
    assertRegularNonSymlink(handleInfo, displayPath);
    if (!sameFileIdentity(toFileVersion(pathInfo), toFileVersion(handleInfo))) {
      throw new Error("descriptor path does not identify the opened file");
    }
    return descriptorPath;
  } catch (error) {
    throw new Error(`Linux 文件描述符绑定验证失败，已拒绝覆盖: ${displayPath}`, {
      cause: error,
    });
  }
}

function linuxMetadataProcessOptions() {
  return {
    encoding: "utf8" as const,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: METADATA_PROBE_MAX_BYTES,
  };
}

function parseLinuxAttributeDump(output: string, displayPath: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("# ")) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_.:-]*)=(0x(?:[0-9a-fA-F]{2})*)$/u);
    if (!match || attributes.has(match[1]!)) {
      throw new Error(`Linux 扩展属性输出无法安全解析，已拒绝覆盖: ${displayPath}`);
    }
    attributes.set(match[1]!, match[2]!.toLowerCase());
  }
  return attributes;
}

function assertSupportedLinuxAttributeNamespaces(
  attributes: ReadonlyMap<string, string>,
  displayPath: string,
): void {
  for (const name of attributes.keys()) {
    if (/^(?:security|system|trusted|user)\./u.test(name)) continue;
    throw new Error(`目标含不支持的 Linux 扩展属性 ${name}，已拒绝覆盖: ${displayPath}`);
  }
}

function isUserLinuxAttribute(name: string): boolean {
  return name.startsWith("user.");
}

function isManagedLinuxAttribute(name: string): boolean {
  return (
    isUserLinuxAttribute(name) ||
    name === LINUX_POSIX_ACL_ATTRIBUTE ||
    name === LINUX_CAPABILITY_ATTRIBUTE
  );
}

function sortedLinuxAttributes(
  attributes: ReadonlyMap<string, string>,
): readonly (readonly [string, string])[] {
  return [...attributes].sort(([left], [right]) => left.localeCompare(right));
}

function publishedLinuxAttributes(
  source: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const published = new Map(source);
  published.delete(LINUX_CAPABILITY_ATTRIBUTE);
  return published;
}

function sameLinuxAttributes(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return left.size === right.size && [...left].every(([name, value]) => right.get(name) === value);
}

function linuxDescriptorPath(handle: FileHandle): string {
  return `/proc/${process.pid}/fd/${handle.fd}`;
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
