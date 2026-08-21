export async function forbiddenDynamicComputedSubtle(
  key: CryptoKey,
  signature: BufferSource,
  data: BufferSource,
): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const property = 'verify';
  return await subtle[property]('Ed25519', key, signature, data);
}
