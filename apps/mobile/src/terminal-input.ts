/** Host limits each input request to 64 KiB of UTF-8; preserve code point boundaries. */
export function* terminalInputChunks(data: string): Generator<string> {
  let chunk = "";
  let bytes = 0;
  for (const character of data) {
    const code = character.codePointAt(0)!;
    const length = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + length > 64 * 1024) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += length;
  }
  if (chunk) yield chunk;
}
