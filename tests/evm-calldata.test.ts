import { describe, expect, it } from 'vitest';

import { decodeErc20Calldata } from '../src/evm-calldata.js';
import { intentFromToolInput } from '../src/adapters/shared.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

// transfer(0x4444..., 100000000000) — 100,000 USDC in base units
const TRANSFER_CALLDATA = `0xa9059cbb${pad(RECIPIENT)}${pad('0x174876e800')}`;
const APPROVE_MAX_CALLDATA = `0x095ea7b3${pad(RECIPIENT)}${'f'.repeat(64)}`;

describe('decodeErc20Calldata', () => {
  it('decodes transfer selector, recipient, and base-units amount', () => {
    expect(decodeErc20Calldata(USDC, TRANSFER_CALLDATA)).toEqual({
      selector: '0xa9059cbb',
      token_target: USDC.toLowerCase(),
      recipient: RECIPIENT,
      token_amount: '100000000000',
    });
  });

  it('decodes approve with the max-uint256 sentinel', () => {
    const decoded = decodeErc20Calldata(USDC, APPROVE_MAX_CALLDATA);
    expect(decoded?.selector).toBe('0x095ea7b3');
    expect(decoded?.spender).toBe(RECIPIENT);
    expect(decoded?.token_amount).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  it('decodes transferFrom recipient and amount from the second and third words', () => {
    const calldata = `0x23b872dd${pad('0x' + '1'.repeat(40))}${pad(RECIPIENT)}${pad('0x5f5e100')}`;
    const decoded = decodeErc20Calldata(USDC, calldata);
    expect(decoded?.recipient).toBe(RECIPIENT);
    expect(decoded?.token_amount).toBe('100000000');
  });

  it('emits selector-only metadata for unknown selectors (never guessed values)', () => {
    expect(decodeErc20Calldata(USDC, `0xdeadbeef${pad('0x1')}`)).toEqual({ selector: '0xdeadbeef' });
  });

  it('emits selector-only metadata when an ERC-20 argument word does not decode cleanly', () => {
    // transfer with a truncated amount word
    const truncated = `0xa9059cbb${pad(RECIPIENT)}deadbeef`;
    expect(decodeErc20Calldata(USDC, truncated)).toEqual({ selector: '0xa9059cbb' });
  });

  it('returns undefined for absent or sub-selector calldata', () => {
    expect(decodeErc20Calldata(USDC, undefined)).toBeUndefined();
    expect(decodeErc20Calldata(USDC, '0xa9')).toBeUndefined();
    expect(decodeErc20Calldata(USDC, 'not-hex')).toBeUndefined();
  });
});

describe('intentFromToolInput — EVM amount contract', () => {
  it('passes a supplied amount through verbatim', () => {
    const intent = intentFromToolInput('wallet.transfer', { amount: '1.5', chainId: 1, to: RECIPIENT });
    expect(intent.amount).toBe('1.5');
  });

  it('stringifies a finite numeric value field', () => {
    const intent = intentFromToolInput('contract.call', { value: 0, chainId: 1, to: USDC });
    expect(intent.amount).toBe('0');
  });

  it('defaults contract.call with no amount/value key to explicit "0"', () => {
    const intent = intentFromToolInput('contract.call', { chainId: 1, to: USDC, calldata: TRANSFER_CALLDATA });
    expect(intent.amount).toBe('0');
  });

  it('leaves wallet.transfer without any amount absent so Sign fails closed', () => {
    const intent = intentFromToolInput('wallet.transfer', { chainId: 1, to: RECIPIENT });
    expect(intent.amount).toBeUndefined();
  });

  it('does not default amounts for non-EVM actions', () => {
    const intent = intentFromToolInput('bash', { command: 'ls' });
    expect(intent.amount).toBeUndefined();
  });

  it('attaches decoded calldata as metadata.evm on contract.call', () => {
    const intent = intentFromToolInput('contract.call', {
      chainId: 1,
      to: USDC,
      calldata: TRANSFER_CALLDATA,
    });
    expect(intent.calldata).toBe(TRANSFER_CALLDATA);
    expect(intent.metadata?.['evm']).toEqual({
      selector: '0xa9059cbb',
      token_target: USDC.toLowerCase(),
      recipient: RECIPIENT,
      token_amount: '100000000000',
    });
  });

  it('preserves caller metadata when merging the evm enrichment', () => {
    const intent = intentFromToolInput(
      'contract.call',
      { chainId: 1, to: USDC, calldata: TRANSFER_CALLDATA },
      { job_type: 'rebalance' },
    );
    expect(intent.metadata?.['job_type']).toBe('rebalance');
    expect(intent.metadata?.['evm']).toBeDefined();
  });

  it('does not attach evm metadata for wallet.transfer', () => {
    const intent = intentFromToolInput('wallet.transfer', { chainId: 1, to: RECIPIENT, amount: '1' });
    expect(intent.metadata?.['evm']).toBeUndefined();
  });
});
