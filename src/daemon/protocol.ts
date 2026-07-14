/**
 * Backward-compatible daemon import surface.
 *
 * New clients should import from `@pico/protocol`; keeping this re-export avoids
 * forcing the CLI and existing daemon services to migrate in the same release.
 */
export * from "@pico/protocol";
