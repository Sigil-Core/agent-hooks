import type { VerifiedAuthorization } from '../src/decision.js';

// @ts-expect-error The private brand makes literal construction impossible.
const forgedLiteral: VerifiedAuthorization = {
  kind: 'verified',
  decision: 'ALLOWED',
  intentHash: '0'.repeat(64),
  policyHash: '0'.repeat(64),
};

const structuralAuthorization = JSON.parse(JSON.stringify({
  kind: 'verified',
  decision: 'ALLOWED',
  intentHash: '0'.repeat(64),
  policyHash: '0'.repeat(64),
})) as {
  readonly kind: 'verified';
  readonly decision: 'ALLOWED';
  readonly intentHash: string;
  readonly policyHash: string;
};
// @ts-expect-error The private brand rejects an otherwise complete structural match.
const forgedStructural: VerifiedAuthorization = structuralAuthorization;

void forgedLiteral;
void forgedStructural;
