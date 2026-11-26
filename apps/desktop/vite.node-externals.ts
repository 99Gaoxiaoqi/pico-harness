/**
 * Node-target desktop bundles run inside Electron or the daemon's Node child
 * process, so Node builtins must stay runtime `require`s. Rolldown's builtin
 * table omits the experimental `node:sqlite` module, which it otherwise
 * resolves as a browser external: a throwing proxy in development and an empty
 * object in production builds. Keep the specifier explicit as a string so the
 * daemon config's `external` array stays consumable as esbuild externals.
 */
export const nodeSqliteExternal = "node:sqlite";
