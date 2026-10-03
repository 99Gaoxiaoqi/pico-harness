/* global require, module */
// Expo loads local config plugins synchronously as CommonJS.
const { withAndroidManifest } = require("expo/config-plugins"); // eslint-disable-line @typescript-eslint/no-require-imports

// Make the intended HTTPS-only policy explicit in every generated native project.
module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android Manifest 缺少 application");
    application.$["android:usesCleartextTraffic"] = "false";
    return mod;
  });
