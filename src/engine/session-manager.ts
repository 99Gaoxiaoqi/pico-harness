import { logger } from "../observability/logger.js";
import { RuntimeSessionManager, type RuntimeSessionManagerLease } from "@pico/runtime";
import { sessionEntryKey } from "./session-manager-state.js";
import type { Session, SessionOptions } from "./session.js";

export interface SessionManagerOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  /** Optional factory used by the owning Session module and isolated tests. */
  readonly createSession?: (id: string, workDir: string, options?: SessionOptions) => Session;
}

export type SessionManagerLease = RuntimeSessionManagerLease<Session>;

let defaultSessionFactory:
  | ((id: string, workDir: string, options?: SessionOptions) => Session)
  | undefined;

/** Configure the default factory without importing Session at runtime. */
export function configureDefaultSessionFactory(
  factory: (id: string, workDir: string, options?: SessionOptions) => Session,
): void {
  defaultSessionFactory = factory;
}

/**
 * Engine compatibility facade for Runtime's generic Session lifecycle policy.
 * Session construction and Pico workspace identity remain at this outer edge.
 */
export class SessionManager extends RuntimeSessionManager<Session, SessionOptions> {
  constructor(options: SessionManagerOptions = {}) {
    const factory = options.createSession ?? defaultSessionFactory;
    if (!factory) throw new Error("SessionManager requires a configured Session factory");
    super({
      ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      createSession: factory,
      entryKey: (id, workDir, identity) =>
        sessionEntryKey(id, workDir, identity?.picoHome, identity?.runtimeStorageRoot),
      onDrainError: ({ key, error }) => {
        logger.warn({ key, error: String(error) }, "[session] 驱逐时持久化 drain 失败");
      },
    });
  }
}
