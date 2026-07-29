import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const requirementPattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9._+-]*)$/u;

export async function verifyApprovedHarborWheelhouse({
  manifestPath,
  wheelhousePath,
  constraintsPath,
  expectedManifestSha256,
}) {
  const rawManifest = await readFile(manifestPath);
  if (sha256(rawManifest) !== expectedManifestSha256) {
    throw new Error("Harbor artifact manifest digest mismatch");
  }
  const manifest = JSON.parse(rawManifest);
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.python !== "3.12" ||
    manifest.platform !== "macos-arm64" ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error("Harbor artifact manifest is invalid");
  }

  const expectedRequirements = new Set(
    (await readFile(constraintsPath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const actualRequirements = new Set();
  const expectedFiles = new Set(["artifact-manifest.json"]);
  for (const artifact of manifest.artifacts) {
    if (
      artifact === null ||
      typeof artifact !== "object" ||
      Object.keys(artifact).sort().join(",") !== "filename,requirement,sha256" ||
      typeof artifact.requirement !== "string" ||
      !requirementPattern.test(artifact.requirement) ||
      typeof artifact.filename !== "string" ||
      basename(artifact.filename) !== artifact.filename ||
      !artifact.filename.endsWith(".whl") ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      actualRequirements.has(artifact.requirement) ||
      expectedFiles.has(artifact.filename)
    ) {
      throw new Error("Harbor artifact manifest entry is invalid");
    }
    actualRequirements.add(artifact.requirement);
    expectedFiles.add(artifact.filename);
    if (sha256(await readFile(join(wheelhousePath, artifact.filename))) !== artifact.sha256) {
      throw new Error(`Harbor artifact digest mismatch: ${artifact.filename}`);
    }
  }
  if (
    expectedRequirements.size !== actualRequirements.size ||
    [...expectedRequirements].some((requirement) => !actualRequirements.has(requirement))
  ) {
    throw new Error("Harbor artifact manifest does not match the constraints");
  }
  const actualFiles = new Set(await readdir(wheelhousePath));
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some((filename) => !actualFiles.has(filename))
  ) {
    throw new Error("Harbor wheelhouse contains unexpected artifacts");
  }
  return {
    artifactCount: manifest.artifacts.length,
    manifestSha256: expectedManifestSha256,
    python: manifest.python,
    platform: manifest.platform,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
