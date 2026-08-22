declare module "fs-native-extensions" {
  export interface LockOptions {
    shared?: boolean;
  }
  export function tryLock(fd: number, options?: LockOptions): boolean;
  export function unlock(fd: number): void;
  export function waitForLock(fd: number, options?: LockOptions): Promise<void>;
  export function waitForLockSync(fd: number, options?: LockOptions): void;
}
