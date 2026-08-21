declare const require: (specifier: string) => unknown;

export async function forbiddenDynamicJose(): Promise<unknown[]> {
  return [
    await import('jose'),
    await import('jsonwebtoken'),
    await import('jws'),
    require('jose'),
    require('jsonwebtoken'),
    require('jws'),
  ];
}
