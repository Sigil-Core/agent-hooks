export async function forbiddenGlobalSubtle(
  key: CryptoKey,
  signature: BufferSource,
  data: BufferSource,
): Promise<boolean> {
  return globalThis.crypto.subtle.verify('Ed25519', key, signature, data);
}
