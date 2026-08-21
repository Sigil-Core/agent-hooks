export async function forbiddenAliasedComputedSubtle(
  key: CryptoKey,
  signature: BufferSource,
  data: BufferSource,
): Promise<boolean[]> {
  const subtle = globalThis.crypto.subtle;
  const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
  const { verify: destructuredVerify } = globalThis.crypto.subtle;
  return [
    await subtle.verify('Ed25519', key, signature, data),
    await verify('Ed25519', key, signature, data),
    await destructuredVerify.call(globalThis.crypto.subtle, 'Ed25519', key, signature, data),
    await globalThis.crypto.subtle['verify']('Ed25519', key, signature, data),
  ];
}
