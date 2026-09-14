/** Paths that can carry credentials and therefore require explicit authorization to read or write. */
export function isSensitiveCredentialPath(absolutePath: string): boolean {
  const normalized = absolutePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (
    /(?:^|\/)\.(?:ssh|gnupg|aws|kube|docker|azure)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)gcloud(?:\/|$)/iu.test(normalized)
  ) {
    return true;
  }
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/iu.test(basename)) {
    return !/^\.env\.(?:example|sample|template|dist)$/iu.test(basename);
  }
  if (/(?:id_rsa|id_ed25519|id_ecdsa|credentials|\.pem$|\.key$)/iu.test(normalized)) {
    return !/(?:id_rsa|id_ed25519|id_ecdsa)\.pub$/iu.test(normalized);
  }
  return false;
}
