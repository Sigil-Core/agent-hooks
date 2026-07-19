import { describe, expect, it } from 'vitest';

import { decodeErc20Calldata } from '../src/evm-calldata.js';
import { intentFromToolInput, mapToolAction } from '../src/adapters/shared.js';
import { buildAuthorizeRequestBody } from '../src/request.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

// transfer(0x4444..., 100000000000) — 100,000 USDC in base units
const TRANSFER_CALLDATA = `0xa9059cbb${pad(RECIPIENT)}${pad('0x174876e800')}`;
const APPROVE_MAX_CALLDATA = `0x095ea7b3${pad(RECIPIENT)}${'f'.repeat(64)}`;
const INCREASE_ALLOWANCE_CALLDATA = `0x39509351${pad(RECIPIENT)}${pad('0x5f5e100')}`;
const PERMIT_CALLDATA =
  `0xd505accf${pad('0x' + '1'.repeat(40))}${pad(RECIPIENT)}${pad('0x5f5e100')}` +
  `${pad('0x1')}${pad('0x1b')}${'a'.repeat(64)}${'b'.repeat(64)}`;

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

  it('decodes increaseAllowance spender and amount', () => {
    expect(decodeErc20Calldata(USDC, INCREASE_ALLOWANCE_CALLDATA)).toEqual({
      selector: '0x39509351',
      token_target: USDC.toLowerCase(),
      spender: RECIPIENT,
      token_amount: '100000000',
    });
  });

  it('decodes permit spender and value from the second and third words', () => {
    expect(decodeErc20Calldata(USDC, PERMIT_CALLDATA)).toEqual({
      selector: '0xd505accf',
      token_target: USDC.toLowerCase(),
      spender: RECIPIENT,
      token_amount: '100000000',
    });
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

  it('rejects dirty high bytes in an ABI-encoded address word', () => {
    const dirtyAddressWord = `${'f'.repeat(24)}${RECIPIENT.slice(2)}`;
    const calldata = `0xa9059cbb${dirtyAddressWord}${pad('0x1')}`;
    expect(decodeErc20Calldata(USDC, calldata)).toEqual({ selector: '0xa9059cbb' });
  });

  it.each([
    ['increaseAllowance', `0x39509351${pad(RECIPIENT)}deadbeef`, '0x39509351'],
    [
      'permit',
      `0xd505accf${pad('0x' + '1'.repeat(40))}${'f'.repeat(24)}${RECIPIENT.slice(2)}${pad('0x1')}`,
      '0xd505accf',
    ],
  ])('returns selector-only metadata for malformed %s arguments', (_name, calldata, selector) => {
    expect(decodeErc20Calldata(USDC, calldata)).toEqual({ selector });
  });

  it('returns undefined for absent or sub-selector calldata', () => {
    expect(decodeErc20Calldata(USDC, undefined)).toBeUndefined();
    expect(decodeErc20Calldata(USDC, '0xa9')).toBeUndefined();
    expect(decodeErc20Calldata(USDC, 'not-hex')).toBeUndefined();
  });
});

describe('intentFromToolInput — EVM amount contract', () => {
  it.each(['contract_call', 'contract.call'])(
    'maps %s to the enriched contract.call action',
    (toolName) => {
      const action = mapToolAction(toolName);
      const intent = intentFromToolInput(action, {
        chainId: 1,
        to: USDC,
        calldata: TRANSFER_CALLDATA,
      });

      expect(action).toBe('contract.call');
      expect(intent.amount).toBe('0');
      expect(intent.metadata?.['evm']).toEqual(expect.objectContaining({
        selector: '0xa9059cbb',
        token_target: USDC.toLowerCase(),
      }));
    },
  );

  it('passes a supplied amount through verbatim', () => {
    const intent = intentFromToolInput('wallet.transfer', { amount: '1.5', chainId: 1, to: RECIPIENT });
    expect(intent.amount).toBe('1.5');
  });

  it('stringifies a finite numeric value field', () => {
    const intent = intentFromToolInput('contract.call', { value: 0, chainId: 1, to: USDC });
    expect(intent.amount).toBe('0');
  });

  it.each([
    ['negative string', '-1'],
    ['exponent string', '1e18'],
    ['negative number', -1],
    ['fractional number', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['non-finite number', Number.POSITIVE_INFINITY],
  ])('rejects an unsafe %s amount representation', (_name, value) => {
    const intent = intentFromToolInput('wallet.transfer', { value, chainId: 1, to: RECIPIENT });
    expect(intent.amount).toBeUndefined();
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

  it('normalizes valid calldata and rejects malformed non-empty calldata', () => {
    const normalized = intentFromToolInput('contract.call', {
      chainId: 1,
      to: USDC,
      calldata: TRANSFER_CALLDATA.slice(2).toUpperCase(),
    });
    expect(normalized.calldata).toBe(TRANSFER_CALLDATA);

    const malformed = intentFromToolInput('contract.call', {
      chainId: 1,
      to: USDC,
      calldata: '0xabc',
      data: TRANSFER_CALLDATA,
    });
    expect(malformed.calldata).toBeUndefined();
    expect(malformed.metadata?.['evm']).toBeUndefined();
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
    const intent = intentFromToolInput('wallet.transfer', {
      chainId: 1,
      to: RECIPIENT,
      amount: '1',
      calldata: TRANSFER_CALLDATA,
    });
    expect(intent.metadata?.['evm']).toBeUndefined();
    expect(intent.calldata).toBeUndefined();
  });

  it('binds fallback intent commits to calldata', () => {
    const config = { apiKey: 'sk_sigil_test' };
    const first = buildAuthorizeRequestBody(
      intentFromToolInput('contract.call', {
        chainId: 1,
        to: USDC,
        calldata: TRANSFER_CALLDATA,
      }),
      config,
    );
    const second = buildAuthorizeRequestBody(
      intentFromToolInput('contract.call', {
        chainId: 1,
        to: USDC,
        calldata: APPROVE_MAX_CALLDATA,
      }),
      config,
    );
    expect(first['txCommit']).not.toBe(second['txCommit']);
  });
});
