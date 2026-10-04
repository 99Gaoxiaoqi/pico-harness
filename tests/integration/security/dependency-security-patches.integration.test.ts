import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const expo = require("@expo/code-signing-certificates");

function signingFixture() {
  const native = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 65537,
  });
  const keyPair = expo.convertKeyPairPEMToKeyPair({
    privateKeyPEM: native.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPEM: native.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const certificate = expo.generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: new Date(Date.now() - 60_000),
    validityNotAfter: new Date(Date.now() + 60_000),
    commonName: "ephemeral Expo dependency regression",
  });
  return { native, keyPair, certificate };
}

function der(tag: number, value: Buffer): Buffer {
  assert.ok(value.length < 256, "fixture DER uses at most one length octet");
  return Buffer.concat([
    Buffer.from(value.length < 128 ? [tag, value.length] : [tag, 0x81, value.length]),
    value,
  ]);
}

const sha256Oid = Buffer.from("0609608648016503040201", "hex");
const emptyNull = Buffer.from("0500", "hex");

function digestInfo(algorithm: Buffer, digest: Buffer, extra: Buffer = Buffer.alloc(0)): Buffer {
  return der(0x30, Buffer.concat([der(0x30, algorithm), digest, extra]));
}

function signDigestInfo(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  info: Buffer,
): Buffer {
  const width = 256;
  assert.ok(info.length <= width - 11);
  // Sign an intentionally chosen encoded message with the actual RSA key. This
  // isolates DigestInfo acceptance from the feasibility of an e=3 forgery.
  const encoded = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(width - info.length - 3, 0xff),
    Buffer.from([0]),
    info,
  ]);
  return privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded);
}

test("patched forge preserves real Expo certificate/manifest signing, omitted NULL and RSA-PSS", () => {
  assert.equal(require("node-forge/package.json").version, "1.4.0");
  const { native, keyPair, certificate } = signingFixture();
  expo.validateSelfSignedCertificate(certificate, keyPair);
  const certificatePem = expo.convertCertificateToCertificatePEM(certificate);
  const restored = expo.convertCertificatePEMToCertificate(certificatePem);
  expo.validateSelfSignedCertificate(restored, keyPair);

  const manifest = Buffer.from(JSON.stringify({ id: "expo-regression", message: "中文 🚀" }));
  const signature = Buffer.from(
    expo.signBufferRSASHA256AndVerify(keyPair.privateKey, restored, manifest),
    "base64",
  );
  assert.equal(verify("sha256", manifest, native.publicKey, signature), true);

  const digest = createHash("sha256").update(manifest).digest();
  const omittedNull = signDigestInfo(native.privateKey, digestInfo(sha256Oid, der(4, digest)));
  assert.equal(
    keyPair.publicKey.verify(digest.toString("binary"), omittedNull.toString("binary")),
    true,
  );

  const pssSignature = sign("sha256", manifest, {
    key: native.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  const pss = forge.pss.create({
    md: forge.md.sha256.create(),
    mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
    saltLength: 32,
  });
  assert.equal(
    keyPair.publicKey.verify(digest.toString("binary"), pssSignature.toString("binary"), pss),
    true,
  );
  assert.equal(
    verify(
      "sha256",
      manifest,
      {
        key: native.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      pssSignature,
    ),
    true,
  );
});

test("Expo verification rejects extra AlgorithmIdentifier children and malformed ASN.1 parameters", () => {
  const { native, keyPair, certificate } = signingFixture();
  const manifest = Buffer.from('{"id":"untrusted-manifest"}');
  const digest = createHash("sha256").update(manifest).digest();
  const garbage = der(4, Buffer.alloc(64, 0x47));
  const attacks = [
    digestInfo(Buffer.concat([sha256Oid, emptyNull, garbage]), der(4, digest)),
    digestInfo(Buffer.concat([sha256Oid, garbage]), der(4, digest)),
    digestInfo(Buffer.concat([sha256Oid, der(5, Buffer.alloc(64, 0x47))]), der(4, digest)),
    digestInfo(Buffer.concat([sha256Oid, Buffer.from("2500", "hex")]), der(4, digest)),
    digestInfo(Buffer.concat([sha256Oid, emptyNull]), der(0x24, der(4, digest))),
    digestInfo(Buffer.concat([sha256Oid, emptyNull]), der(4, digest), garbage),
  ];
  for (const info of attacks) {
    const signature = signDigestInfo(native.privateKey, info);
    assert.equal(verify("sha256", manifest, native.publicKey, signature), false);
    assert.throws(
      () => keyPair.publicKey.verify(digest.toString("binary"), signature.toString("binary")),
      /valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
    const badSigner = Object.create(keyPair.privateKey);
    badSigner.sign = () => signature.toString("binary");
    assert.throws(
      () => expo.signBufferRSASHA256AndVerify(badSigner, certificate, manifest),
      /valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
  }

  const certificateDigest = Buffer.from(certificate.md.digest().getBytes(), "binary");
  certificate.signature = signDigestInfo(
    native.privateKey,
    digestInfo(Buffer.concat([sha256Oid, emptyNull, garbage]), der(4, certificateDigest)),
  ).toString("binary");
  assert.throws(
    () => expo.validateSelfSignedCertificate(certificate, keyPair),
    /valid RSASSA-PKCS1-v1_5 DigestInfo/,
  );
});

function runBracesChild(source: string): string {
  return execFileSync(process.execPath, ["--input-type=commonjs", "-e", source], {
    env: { ...process.env, PICO_BRACES_MODULE: require.resolve("braces") },
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
}

test("braces preserves normal expansion, all depth-100 entry points and escapeInvalid behavior", () => {
  assert.equal(require("braces/package.json").version, "3.0.3");
  const output = runBracesChild(`
    const assert = require('node:assert/strict');
    const braces = require(process.env.PICO_BRACES_MODULE);
    assert.deepEqual(braces.expand('src/{mobile,desktop}/{a,b}.ts'), [
      'src/mobile/a.ts', 'src/mobile/b.ts', 'src/desktop/a.ts', 'src/desktop/b.ts'
    ]);
    assert.equal(braces.stringify('{{a}}', {escapeInvalid: true}), '{{a}}');
    assert.deepEqual(braces.expand('{1..3}'), ['1', '2', '3']);
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      const input = open.repeat(100) + 'a' + close.repeat(100);
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.doesNotThrow(() => braces[method](input));
        if (method !== 'parse') assert.doesNotThrow(() => braces[method](braces.parse(input)));
      }
    }
    console.log('bounded success');
  `);
  assert.match(output, /bounded success/);
});

test("braces rejects excessive string/AST depth and cycles in a timeout-isolated process", () => {
  const output = runBracesChild(`
    const assert = require('node:assert/strict');
    const braces = require(process.env.PICO_BRACES_MODULE);
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      for (const depth of [101, 4000]) {
        const input = open.repeat(depth) + 'a' + close.repeat(depth);
        for (const method of ['parse', 'compile', 'expand', 'stringify']) {
          assert.throws(() => braces[method](input, {maxDepth: 1000}), /exceeds max depth/);
        }
      }
    }
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.doesNotThrow(() => braces[method]('{a}', {maxDepth: 1.5}));
      assert.throws(() => braces[method]('{{a}}', {maxDepth: 1.5}), /exceeds max depth/);
    }
    for (const method of ['compile', 'expand', 'stringify']) {
      const ast = braces.parse('{'.repeat(100) + 'a' + '}'.repeat(100));
      let deepest = ast;
      while (deepest.nodes.some(node => node.type === 'brace')) {
        deepest = deepest.nodes.find(node => node.type === 'brace');
      }
      deepest.nodes.push({type: 'paren', nodes: [{type: 'text', value: 'x'}], parent: deepest});
      assert.throws(() => braces[method](ast), /AST depth .*exceeds max depth/);
      const cyclic = braces.parse('{a,b}');
      cyclic.nodes.push(cyclic);
      assert.throws(() => braces[method](cyclic), /AST depth .*exceeds max depth/);
    }
    const parentCycle = braces.parse('(a)');
    const paren = parentCycle.nodes.find(node => node.type === 'paren');
    paren.parent = paren;
    assert.throws(() => braces.expand(parentCycle), /AST parent chain contains a cycle/);
    console.log('bounded rejection');
  `);
  assert.match(output, /bounded rejection/);
});

test("query-string CommonJS consumers use decoder 0.5 with Unicode, plus signs and malformed escapes", () => {
  assert.equal(require("query-string/package.json").version, "7.1.3");
  const queryStringRequire = createRequire(require.resolve("query-string"));
  const decoderPath = queryStringRequire.resolve("decode-uri-component");
  assert.equal(
    JSON.parse(readFileSync(join(dirname(decoderPath), "package.json"), "utf8")).version,
    "0.5.0",
  );
  const query = require("query-string");
  const parsed = query.parse("q=%E4%B8%AD%E6%96%87%F0%9F%9A%80&space=a+b&plus=%2B&empty=&flag");
  assert.deepEqual({ ...parsed }, { q: "中文🚀", space: "a b", plus: "+", empty: "", flag: null });
  assert.deepEqual({ ...query.parse(query.stringify(parsed)) }, { ...parsed });
  assert.deepEqual(
    { ...query.parse("q=%E4%B8%AD%ZZ&bad=%&utf8=%E0%A4%A") },
    {
      q: "中%ZZ",
      bad: "%",
      utf8: "%E0%A4%A",
    },
  );
  assert.deepEqual({ ...query.parse("q=%2B+a", { decode: false }) }, { q: "%2B+a" });
});
