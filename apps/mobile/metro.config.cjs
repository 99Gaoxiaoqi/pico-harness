/* global require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads this config as CommonJS. */
const { getDefaultConfig } = require("expo/metro-config");
const { sep } = require("node:path");
const config = getDefaultConfig(__dirname);
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = (name) =>
    defaultResolve
      ? defaultResolve(context, name, platform)
      : context.resolveRequest(context, name, platform);
  try {
    return resolve(moduleName);
  } catch (error) {
    // Shared mobile helpers also run in NodeNext integration tests, which require .js
    // import specifiers. Metro resolves their original TypeScript source instead.
    if (
      context.originModulePath.startsWith(`${__dirname}${sep}src${sep}`) &&
      /^\.\.?\//.test(moduleName) &&
      moduleName.endsWith(".js")
    ) {
      try {
        return resolve(moduleName.slice(0, -3));
      } catch {
        /* keep the original diagnostic */
      }
    }
    throw error;
  }
};
module.exports = config;
