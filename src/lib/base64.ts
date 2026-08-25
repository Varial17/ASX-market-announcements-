/**
 * Base64 for the Anthropic document block. The string must contain no
 * newlines, and `String.fromCharCode(...bytes)` blows the argument limit on
 * anything but a tiny buffer — hence the chunking.
 */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
