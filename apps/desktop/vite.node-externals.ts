/**
 * Node-target desktop bundles run inside Electron or the daemon's Node child
 * process, so Node builtins must stay runtime `require`s. Rolldown's builtin
 * table omits experimental modules such as `node:sqlite`, which it otherwise
 * resolves as a browser external: a throwing proxy in development and an empty
 * object in production builds. Matching every `node:` specifier keeps future
 * experimental builtins external too.
 */
export const nodeBuiltinExternal = /^node:/;
