// EVM calldata enrichment — the adapter side of the Policy 2.1
// require_calldata_enrichment contract. A trusted shim decodes the 4-byte
// selector of a contract.call and, for the ERC-20 set, emits decoded values
// as metadata.evm. Sign only trusts this metadata on shim-provenance
// submissions; the decode itself never widens authority — it exposes what
// the calldata already claims so token caps can bind to it.
//
// Out of scope by design (documented residuals): proxy contracts, multicall
// unwrapping, and non-ERC-20 standards. Unknown selectors emit selector-only
// metadata so a strict policy can deny them.

/** Decoded ERC-20 metadata emitted as metadata.evm on a contract.call. */
export interface EvmCalldataMetadata {
  selector: string;
  token_target?: string;
  spender?: string;
  recipient?: string;
  token_amount?: string;
}

const ADDRESS_WORD = /^[0-9a-f]{24}([0-9a-f]{40})$/;

function decodeWord(words: string[], index: number): string | undefined {
  return words[index];
}

function decodeAddress(words: string[], index: number): string | undefined {
  const word = decodeWord(words, index);
  if (word === undefined) return undefined;
  const m = word.match(ADDRESS_WORD);
  return m ? `0x${m[1]}` : undefined;
}

function decodeUint(words: string[], index: number): string | undefined {
  const word = decodeWord(words, index);
  if (word === undefined || !/^[0-9a-f]{64}$/.test(word)) return undefined;
  try {
    return BigInt(`0x${word}`).toString(10);
  } catch {
    return undefined;
  }
}

/**
 * Decodes ERC-20 calldata for the selector set Sign evaluates:
 * transfer(address,uint256), transferFrom(address,address,uint256),
 * approve(address,uint256), increaseAllowance(address,uint256), and
 * permit(address,address,uint256,uint256,uint8,bytes32,bytes32).
 *
 * Returns undefined when calldata is absent or shorter than a selector.
 * Returns selector-only metadata for selectors outside the decoded set or
 * for argument words that do not decode cleanly — never a guessed value.
 * Amounts are emitted as base-units decimal strings.
 */
export function decodeErc20Calldata(
  targetAddress: string | undefined,
  calldata: string | undefined,
): EvmCalldataMetadata | undefined {
  if (typeof calldata !== 'string') return undefined;
  const hex = calldata.trim().toLowerCase().replace(/^0x/, '');
  if (hex.length < 8 || !/^[0-9a-f]+$/.test(hex)) return undefined;

  const selector = `0x${hex.slice(0, 8)}`;
  const body = hex.slice(8);
  const words: string[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    words.push(body.slice(i, i + 64));
  }

  const tokenTarget = typeof targetAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(targetAddress.trim())
    ? targetAddress.trim().toLowerCase()
    : undefined;
  const base: EvmCalldataMetadata = { selector };

  const withDecoded = (fields: Partial<EvmCalldataMetadata>): EvmCalldataMetadata => {
    for (const value of Object.values(fields)) {
      if (value === undefined) return base; // partial decode is no decode
    }
    return { ...base, ...(tokenTarget ? { token_target: tokenTarget } : {}), ...fields };
  };

  switch (selector) {
    case '0xa9059cbb': // transfer(address to, uint256 amount)
      return withDecoded({
        recipient: decodeAddress(words, 0),
        token_amount: decodeUint(words, 1),
      });
    case '0x23b872dd': // transferFrom(address from, address to, uint256 amount)
      return withDecoded({
        recipient: decodeAddress(words, 1),
        token_amount: decodeUint(words, 2),
      });
    case '0x095ea7b3': // approve(address spender, uint256 amount)
    case '0x39509351': // increaseAllowance(address spender, uint256 addedValue)
      return withDecoded({
        spender: decodeAddress(words, 0),
        token_amount: decodeUint(words, 1),
      });
    case '0xd505accf': // permit(address owner, address spender, uint256 value, ...)
      return withDecoded({
        spender: decodeAddress(words, 1),
        token_amount: decodeUint(words, 2),
      });
    default:
      return base;
  }
}
