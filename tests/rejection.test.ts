// tests/rejection.test.ts
import { describe, it, expect } from 'vitest';
import { buildRejectionContext } from '../src/rejection.js';
import type { SigilHookResult } from '../src/types.js';

describe('buildRejectionContext', () => {
  it('returns correct context for DENIED result', () => {
    const result: SigilHookResult = {
      decision: 'DENIED',
      errorCode: 'SIGIL_BASH_BLOCKED',
      message: 'rm -rf is not allowed',
      policyHash: 'hash123',
    };

    const ctx = buildRejectionContext(result, 'bash');

    expect(ctx.sigil_decision).toBe('DENIED');
    expect(ctx.sigil_error_code).toBe('SIGIL_BASH_BLOCKED');
    expect(ctx.sigil_message).toBe('rm -rf is not allowed');
    expect(ctx.sigil_policy_hash).toBe('hash123');
    expect(ctx.sigil_action_taken).toBe('halted');
    expect(ctx.sigil_next_steps).toContain('bash');
    expect(ctx.sigil_next_steps).toContain('blocked');
  });

  it('returns correct context for PENDING result', () => {
    const result: SigilHookResult = {
      decision: 'PENDING',
      holdId: 'hold_xyz',
      message: 'Requires human approval',
      policyHash: 'hash456',
    };

    const ctx = buildRejectionContext(result, 'email.send');

    expect(ctx.sigil_decision).toBe('PENDING');
    expect(ctx.sigil_error_code).toBe('SIGIL_CONSENSUS_HOLD_REQUIRED');
    expect(ctx.sigil_message).toBe('Requires human approval');
    expect(ctx.sigil_hold_id).toBe('hold_xyz');
    expect(ctx.sigil_policy_hash).toBe('hash456');
    expect(ctx.sigil_action_taken).toBe('pending_approval');
    expect(ctx.sigil_next_steps).toContain('paused');
  });

  it('uses default messages when result has none', () => {
    const result: SigilHookResult = { decision: 'DENIED' };
    const ctx = buildRejectionContext(result, 'file_write');

    expect(ctx.sigil_error_code).toBe('SIGIL_POLICY_VIOLATION');
    expect(ctx.sigil_message).toBe('Action blocked by Sigil policy.');
  });
});
