export async function loadDecisionBoundary(): Promise<unknown> {
  return await import('../../src/decision.js');
}
