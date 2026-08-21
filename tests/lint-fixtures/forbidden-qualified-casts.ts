import type * as Decision from '../../src/decision.js';

const input: unknown = JSON.parse('{"kind":"verified"}');
export const forgedQualified = input as Decision.VerifiedAuthorization;
export const forgedAngle = <Decision.VerifiedAuthorization>input;
