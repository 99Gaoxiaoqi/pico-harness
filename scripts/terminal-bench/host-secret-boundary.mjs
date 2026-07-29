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
