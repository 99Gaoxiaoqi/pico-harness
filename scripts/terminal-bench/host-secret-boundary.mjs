import { open, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

export function allowlistedHostEnv(source) {
  const allowed = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]) {
    if (source[name] !== undefined) allowed[name] = source[name];
  }
  return allowed;
}

export async function openUnlinkedSecret(secret, directory) {
  const path = join(directory, `.provider-secret-${process.pid}-${Date.now()}`);
  const handle = await open(path, "wx+", 0o600);
  try {
    await handle.writeFile(secret);
    await handle.sync();
    await unlink(path);
    return handle;
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}
