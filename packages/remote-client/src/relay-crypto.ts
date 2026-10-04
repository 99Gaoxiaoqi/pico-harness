import nacl from "tweetnacl";
import { RELAY_MAX_PLAINTEXT_BYTES, parseRelayEndpoint, type RemoteRelayEndpoint } from "@pico/protocol/relay";
import { RemoteProtocolError } from "@pico/protocol/remote";

export type RelayRandomBytes = (length: number) => Uint8Array;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function fail(): never { throw new RemoteProtocolError("RELAY_IDENTITY_ERROR", "中继安全通道校验失败，请核对电脑身份"); }
export function relayHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(value: unknown, size?: number): Uint8Array {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{2})+$/.test(value) ||
      (size !== undefined && value.length !== size * 2) || value.length > (RELAY_MAX_PLAINTEXT_BYTES + 16) * 2) fail();
  const text = value as string;
  return Uint8Array.from({ length: text.length / 2 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16));
}
function random(source: RelayRandomBytes, size: number): Uint8Array {
  const bytes = source(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) fail();
  return Uint8Array.from(bytes);
}
function object(payload: string): Record<string, unknown> {
  if (typeof payload !== "string" || payload.length > (RELAY_MAX_PLAINTEXT_BYTES + 16) * 2 + 256) fail();
  try {
    const v: unknown = JSON.parse(payload);
    if (!v || typeof v !== "object" || Array.isArray(v)) fail();
    return v as Record<string, unknown>;
  } catch { return fail(); }
}
function shared(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (nacl.scalarMult(secretKey, publicKey).every((byte) => byte === 0)) fail();
  return nacl.box.before(publicKey, secretKey);
}
export function createRelayIdentity(randomBytes: RelayRandomBytes): { publicKey: string; secretKey: string } {
  const pair = nacl.box.keyPair.fromSecretKey(random(randomBytes, 32));
  return { publicKey: relayHex(pair.publicKey), secretKey: relayHex(pair.secretKey) };
}

class Cipher {
  private outgoing = 0;
  private incoming = 0;
  private closed = false;
  constructor(private key: Uint8Array, private endpoint: RemoteRelayEndpoint,
    private clientNonce: string, public serverNonce: string | undefined,
    private role: "client" | "host", private randomBytes: RelayRandomBytes) {}
  send(body: unknown): string {
    if (this.closed || !this.serverNonce || !Number.isSafeInteger(this.outgoing)) fail();
    const bytes = encoder.encode(JSON.stringify({ version: 1, gatewayId: this.endpoint.gatewayId,
      clientNonce: this.clientNonce, serverNonce: this.serverNonce, role: this.role, seq: this.outgoing++, body }));
    if (bytes.length > RELAY_MAX_PLAINTEXT_BYTES) throw new RemoteProtocolError("FRAME_TOO_LARGE", "中继请求超过预算");
    const nonce = random(this.randomBytes, 24);
    return JSON.stringify({ version: 1, kind: "box", nonce: relayHex(nonce), ciphertext: relayHex(nacl.box.after(bytes, nonce, this.key)) });
  }
  receive(payload: string): unknown {
    if (this.closed) fail();
    const box = object(payload);
    if (Object.keys(box).some((k) => !["version", "kind", "nonce", "ciphertext"].includes(k)) || box.version !== 1 || box.kind !== "box") fail();
    const bytes = nacl.box.open.after(unhex(box.ciphertext), unhex(box.nonce, 24), this.key);
    if (!bytes || bytes.length > RELAY_MAX_PLAINTEXT_BYTES) fail();
    const value = object(decoder.decode(bytes));
    if (value.version !== 1 || value.gatewayId !== this.endpoint.gatewayId || value.clientNonce !== this.clientNonce ||
        value.role !== (this.role === "client" ? "host" : "client") || value.seq !== this.incoming ||
        typeof value.serverNonce !== "string" || !/^[a-f0-9]{64}$/.test(value.serverNonce) ||
        (this.serverNonce !== undefined && value.serverNonce !== this.serverNonce)) fail();
    if (this.serverNonce === undefined) this.serverNonce = value.serverNonce;
    this.incoming++;
    return value.body;
  }
  close(): void { this.closed = true; this.key.fill(0); }
}

export function createRelayClientSession(value: RemoteRelayEndpoint, randomBytes: RelayRandomBytes) {
  const endpoint = parseRelayEndpoint(value);
  const pair = nacl.box.keyPair.fromSecretKey(random(randomBytes, 32));
  const clientNonce = relayHex(random(randomBytes, 32));
  const cipher = new Cipher(shared(unhex(endpoint.hostPublicKey, 32), pair.secretKey), endpoint, clientNonce, undefined, "client", randomBytes);
  pair.secretKey.fill(0);
  let started = false;
  let ready = false;
  return {
    hello(): string {
      if (started) fail();
      started = true;
      return JSON.stringify({ version: 1, kind: "hello", publicKey: relayHex(pair.publicKey), clientNonce });
    },
    receive(payload: string): { ready: true } | { message: unknown } {
      if (!started) fail();
      const body = cipher.receive(payload);
      if (!ready) {
        if (!body || typeof body !== "object" || (body as { kind?: unknown }).kind !== "ready") fail();
        ready = true;
        return { ready: true };
      }
      return { message: body };
    },
    send(message: unknown): string { if (!ready) fail(); return cipher.send(message); },
    close(): void { ready = false; cipher.close(); },
  };
}

export function createRelayHostSession(value: RemoteRelayEndpoint, secretKey: string, randomBytes: RelayRandomBytes) {
  const endpoint = parseRelayEndpoint(value);
  const secret = unhex(secretKey, 32);
  if (relayHex(nacl.box.keyPair.fromSecretKey(secret).publicKey) !== endpoint.hostPublicKey) fail();
  let cipher: Cipher | undefined;
  let closed = false;
  return {
    receive(payload: string): { reply: string } | { message: unknown } {
      if (closed) fail();
      if (!cipher) {
        const hello = object(payload);
        if (Object.keys(hello).some((k) => !["version", "kind", "publicKey", "clientNonce"].includes(k)) ||
            hello.version !== 1 || hello.kind !== "hello" || typeof hello.clientNonce !== "string" || !/^[a-f0-9]{64}$/.test(hello.clientNonce)) fail();
        cipher = new Cipher(shared(unhex(hello.publicKey, 32), secret), endpoint, hello.clientNonce as string,
          relayHex(random(randomBytes, 32)), "host", randomBytes);
        secret.fill(0);
        return { reply: cipher.send({ kind: "ready" }) };
      }
      return { message: cipher.receive(payload) };
    },
    send(message: unknown): string { if (!cipher || closed) fail(); return cipher.send(message); },
    close(): void { closed = true; secret.fill(0); cipher?.close(); },
  };
}
