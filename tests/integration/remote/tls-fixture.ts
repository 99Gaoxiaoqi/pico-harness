import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest, Agent } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { RemoteSocket } from "../../../packages/remote-client/src/index.js";

/** Local test CA only; never changes process trust or bypasses certificate verification. */
export async function createTestTlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pico-client-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  const agent = new Agent({ ca: cert });
  return {
    directory,
    certPath,
    keyPath,
    cert,
    key,
    fetcher: trustedFetch(agent),
    createWebSocket: (url: string, headers: Readonly<Record<string, string>>) =>
      new WebSocket(url, { ca: cert, headers }) as unknown as RemoteSocket,
    async close() {
      agent.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function trustedFetch(agent: Agent): typeof fetch {
  return (async (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        String(input),
        {
          agent,
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal ?? undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("error", reject);
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const body = new Uint8Array(buffer.byteLength);
            body.set(buffer);
            resolve(
              new Response(body, {
                status: response.statusCode ?? 200,
                headers: response.headers as Record<string, string>,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      if (init.body !== undefined) request.write(init.body);
      request.end();
    })) as typeof fetch;
}
