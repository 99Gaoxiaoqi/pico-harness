import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { allowlistedHostEnv } from "./host-secret-boundary.mjs";

const suffix = `${process.pid}-${Date.now()}`;
const taskNetwork = `pico-tb-task-${suffix}`;
const gatewayNetwork = `pico-tb-gateway-${suffix}`;
const relay = `pico-tb-relay-${suffix}`;
const main = `pico-tb-main-${suffix}`;
const sidecar = `pico-tb-sidecar-${suffix}`;
const image = "sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37";
const env = allowlistedHostEnv(process.env);
const server = createServer((_request, response) => {
  response.writeHead(204).end();
});
await new Promise((resolvePromise) => server.listen(0, "0.0.0.0", resolvePromise));
const port = server.address().port;

try {
  await run(["network", "create", "--internal", taskNetwork]);
  await run(["network", "create", "--internal", gatewayNetwork]);
  const relayScript = [
    "const net=require('node:net')",
    `net.createServer(client=>{const upstream=net.connect(${port},'host.docker.internal');`,
    "client.pipe(upstream);upstream.pipe(client)}).listen(8080,'0.0.0.0')",
  ].join(";");
  await run([
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    relay,
    "--network",
    gatewayNetwork,
    "--network-alias",
    "pico-gateway",
    image,
    "node",
    "-e",
    relayScript,
  ]);
  await run(["network", "connect", "bridge", relay]);
  await run(["run", "--detach", "--name", main, "--network", taskNetwork, image, "sleep", "300"]);
  await run(["network", "connect", gatewayNetwork, main]);
  await run([
    "run",
    "--detach",
    "--name",
    sidecar,
    "--network",
    taskNetwork,
    image,
    "sleep",
    "300",
  ]);
  await retry(async () => {
    const result = await execContainer(
      main,
      "fetch('http://pico-gateway:8080').then(r=>process.exit(r.status===204?0:2)).catch(()=>process.exit(3))",
    );
    assert.equal(result, 0);
  });
  assert.equal(
    await execContainer(
      main,
      "fetch('https://example.com').then(()=>process.exit(2)).catch(()=>process.exit(0))",
    ),
    0,
  );
  assert.equal(
    await execContainer(
      sidecar,
      "fetch('http://pico-gateway:8080').then(()=>process.exit(2)).catch(()=>process.exit(0))",
    ),
    0,
  );
  process.stdout.write("Terminal-Bench workload network boundary passed.\n");
} finally {
  server.close();
  await run(["rm", "--force", relay, main, sidecar], new Set([0, 1])).catch(() => undefined);
  await run(["network", "rm", taskNetwork, gatewayNetwork], new Set([0, 1])).catch(() => undefined);
}

async function execContainer(container, script) {
  return run(["exec", container, "node", "-e", script], new Set([0, 2, 3]));
}

async function retry(callback) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError;
}

function run(args, allowed = new Set([0])) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (allowed.has(code)) resolvePromise(code);
      else reject(new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderr}`));
    });
  });
}
