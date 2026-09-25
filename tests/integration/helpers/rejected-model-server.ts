import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A local model endpoint that fails immediately without triggering transport retries. */
export async function startRejectedModelServer(): Promise<{
  baseURL: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "test model request rejected", type: "invalid_request_error" },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
