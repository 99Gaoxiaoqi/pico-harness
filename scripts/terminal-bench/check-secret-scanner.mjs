import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";

const root = await mkdtemp(join(tmpdir(), "pico-secret-scanner-"));
const secret = `PICO_ARCHIVE_CANARY_${process.pid}_${Date.now()}`;
try {
  await writeFile(join(root, "v7.tar"), v7Tar("nested.gz", gzipSync(secret)));
  const zipPayload = join(root, "zip-payload.txt");
  const zipPath = join(root, "payload.zip");
  await writeFile(zipPayload, secret);
  await run("zip", ["-q", "-j", zipPath, zipPayload], root);
  await unlink(zipPayload);
  await writeFile(
    join(root, "self-extracting.zip"),
    Buffer.concat([
      Buffer.from("#!/bin/sh\nexit 0\n"),
      await readFile(zipPath),
      Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]),
    ]),
  );
  await unlink(zipPath);

  const output = await capture(process.execPath, [join(import.meta.dirname, "run.mjs")], {
    ...allowlistedHostEnv(process.env),
    PICO_TB_SECRET_SCAN_ROOT: root,
    PICO_TB_SECRET_SCAN_CANARY: secret,
  });
  const result = JSON.parse(output);
  assert(result.matches.some((match) => match.encoding.includes(">tar>gzip:raw")));
  assert(result.matches.some((match) => match.encoding.includes(">zip:raw")));
  process.stdout.write("Terminal-Bench recursive archive secret scanner passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function v7Tar(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

function capture(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}
