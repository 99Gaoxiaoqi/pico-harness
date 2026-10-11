import { crc32 } from "node:zlib";
import { fromBufferPromise } from "yauzl";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
/** Validate actual inflated bytes and CRCs before either Office library opens the archive. */
export async function validateOfficeZip(bytes: Buffer, requiredEntry: string): Promise<void> {
  const zip = await fromBufferPromise(bytes, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let inflated = 0;
  let declared = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new Error("Office 附件包含过多压缩条目。");
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted()) throw new Error("不支持加密的 Office 附件，请解密后上传。");
      if (names.has(entry.fileName)) throw new Error("Office 附件包含重复条目，文件无效。");
      names.add(entry.fileName);
      declared += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES || declared > MAX_ZIP_BYTES)
        throw new Error("Office 附件解压后体积超过安全上限（单项 20 MiB、总计 50 MiB）。");
      const stream = await zip.openReadStreamPromise(entry);
      let checksum = 0;
      let size = 0;
      try {
        for await (const chunk of stream) {
          const data = chunk as Buffer;
          size += data.byteLength;
          inflated += data.byteLength;
          if (size > MAX_ZIP_ENTRY_BYTES || inflated > MAX_ZIP_BYTES)
            throw new Error("Office 附件实际解压体积超过安全上限。");
          checksum = crc32(data, checksum);
        }
      } finally {
        stream.destroy();
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        throw new Error("Office 附件压缩内容校验失败，文件已损坏。");
    }
    if (!names.has("[Content_Types].xml") || !names.has(requiredEntry))
      throw new Error("附件不是有效的 Office 文档，缺少必要内容。");
  } finally {
    zip.close();
  }
}
