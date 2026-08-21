type Forged = import('../../src/decision.js').VerifiedAuthorization;

const input: unknown = JSON.parse('{"kind":"verified"}');
export const forgedImportType = input as Forged;
