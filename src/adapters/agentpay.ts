import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilHookResult, SigilRejectionContext } from '../types.js';

export interface AgentPayTransfer {
  chainId: number | string;
  amount: string;
  recipient?: string;
  to?: string;
  txCommit?: string;
  rawTxCommit?: string;
  token?: string;
  walletAction?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentPayGuardApproved {
  approved: true;
  result: SigilHookResult;
}

export interface AgentPayGuardBlocked {
  approved: false;
  rejection: SigilRejectionContext;
}

export type AgentPayGuardResult = AgentPayGuardApproved | AgentPayGuardBlocked;

export async function checkAgentPayTransfer(
  transfer: AgentPayTransfer,
  config: SigilHookConfig,
): Promise<AgentPayGuardResult> {
  const to = transfer.to ?? transfer.recipient;
  const chainIdCandidate = typeof transfer.chainId === 'string'
    ? Number(transfer.chainId)
    : transfer.chainId;
  const chainId = Number.isFinite(chainIdCandidate) ? chainIdCandidate : undefined;
  const action = transfer.walletAction ?? 'wallet.transfer';
  const result = await checkIntent(
    {
      action,
      chainId,
      to,
      amount: transfer.amount,
      txCommit: transfer.txCommit ?? transfer.rawTxCommit,
      metadata: {
        ...(transfer.metadata ?? {}),
        agentpay: {
          token: transfer.token,
          walletAction: action,
          recipient: to,
        },
      },
    },
    {
      ...config,
      framework: config.framework ?? 'agentpay',
      failMode: 'closed',
    },
  );

  if (result.decision === 'APPROVED') return { approved: true, result };

  return {
    approved: false,
    rejection: buildRejectionContext(result, action),
  };
}
