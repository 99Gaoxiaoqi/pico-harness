import "./owner-lease.js";

// 兼容旧的 Storage 导入路径；实现已收敛到 @pico/storage。
export {
  assertPrivateDataFileSync,
  FileLockTimeoutError,
  FileStorageIntegrityError,
  isUnsupportedDirectorySync,
  mkdirPrivateSync,
  readJsonFileSync,
  syncDirectorySync,
  withFileLock,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from "@pico/storage";
export type { FileLockOptions } from "@pico/storage";
