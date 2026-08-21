declare const require: (specifier: string) => unknown;

export async function forbiddenComputedCrypto(): Promise<unknown[]> {
  return [
    await import('node:' + 'crypto'),
    require('node:' + 'crypto'),
  ];
}
