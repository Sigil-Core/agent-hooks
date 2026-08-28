// tests/interceptor-observability.test.ts
//
// `X-Sigil-Client` (outbound) and `X-Sigil-Service-Commit` (inbound) are
// observability only. Three things are pinned together here: the client header
// is emitted exactly as the fixed grammar defines it, the response header is
// surfaced on approved and denied results, and neither value can move an
// authorization decision or change the bytes Sign evaluates.
//
// Compatibility is pinned in both directions as well: a build with no identity
// (old client) must still work against a server that sends the response header,
// and a new client must work against a server that sends none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIGIL_CLIENT_HEADER,
  SIGIL_SERVICE_COMMIT_HEADER,
  SigilClientIdentifierError,
} from '../src/client-identifier.js';
import { checkIntent } from '../src/interceptor.js';
import { buildAuthorizeRequestBody } from '../src/request.js';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from '../src/types.js';

const COMMIT = 'b'.repeat(40);
const SERVICE_COMMIT = 'c'.repeat(40);

const IDENTITY_KEYS = [
  'SIGIL_PACKAGE_NAME',
  'SIGIL_PACKAGE_VERSION',
  'SIGIL_SOURCE_COMMIT',
] as const;

type IdentityKey = (typeof IDENTITY_KEYS)[number];

const IDENTITY: Record<IdentityKey, string> = {
  SIGIL_PACKAGE_NAME: '@sigilcore/agent-hooks',
  SIGIL_PACKAGE_VERSION: '0.10.0',
  SIGIL_SOURCE_COMMIT: COMMIT,
};

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  decisionVerificationMode: 'warn',
};

// A pinned txCommit keeps the projected request bytes deterministic: a derived
// commit embeds the current second, which would make a byte-equality test flake.
const INTENT: SigilIntent = {
  action: 'bash',
  command: 'ls -la',
  taskId: 'task-1',
  txCommit: 'd'.repeat(64),
};

const ALLOWED_BODY = { status: 'APPROVED', policyHash: 'abc123' };

const DENIED_BODY = {
  status: 'DENIED',
  error_code: 'SIGIL_BASH_BLOCKED',
  message: 'rm -rf is not allowed',
};

/** Applies an identity environment and restores whatever preceded it. */
const withIdentity = async (
  values: Partial<Record<IdentityKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> => {
  const previous = IDENTITY_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of IDENTITY_KEYS) {
      const value = values[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
};

const jsonResponse = (
  body: unknown,
  { status = 200, headers = {} }: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const sentHeaders = (call = 0): Record<string, string> =>
  (vi.mocked(fetch).mock.calls[call]?.[1] as RequestInit).headers as Record<string, string>;

const sentBody = (call = 0): string =>
  (vi.mocked(fetch).mock.calls[call]?.[1] as RequestInit).body as string;

describe('outbound X-Sigil-Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('emits the fixed grammar on an outbound governed request', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      await checkIntent(INTENT, BASE_CONFIG);
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toBe(
        `name=@sigilcore/agent-hooks; version=0.10.0; commit=${COMMIT}`,
      );
    });
  });

  it('emits the client header on a denied request too', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(DENIED_BODY));
      await checkIntent(INTENT, BASE_CONFIG);
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toContain(`commit=${COMMIT}`);
    });
  });

  it('omits commit entirely when the build carried no source commit', async () => {
    for (const sourceCommit of [undefined, ''] as const) {
      await withIdentity({ ...IDENTITY, SIGIL_SOURCE_COMMIT: sourceCommit }, async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
        await checkIntent(INTENT, BASE_CONFIG);
        expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toBe(
          'name=@sigilcore/agent-hooks; version=0.10.0',
        );
        expect(sentHeaders()[SIGIL_CLIENT_HEADER].includes('commit')).toBe(false);
        expect(sentHeaders()[SIGIL_CLIENT_HEADER].includes('unavailable')).toBe(false);
      });
    }
  });

  it('sends no client header when the build has no package identity', async () => {
    await withIdentity({}, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      await checkIntent(INTENT, BASE_CONFIG);
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toBeUndefined();
    });
  });

  it('throws before any network call when the injected commit is malformed', async () => {
    await withIdentity({ ...IDENTITY, SIGIL_SOURCE_COMMIT: 'not-a-commit' }, async () => {
      await expect(checkIntent(INTENT, BASE_CONFIG)).rejects.toThrow(
        SigilClientIdentifierError,
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('sends the same header value the client identifier produces', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      await checkIntent(INTENT, BASE_CONFIG);
      // The grammar is fixed and validated upstream of the interceptor, so the
      // wire value is exactly the constructor's output and never a re-format.
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toMatch(
        /^name=[\w@/.-]+; version=\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?(?:; commit=[0-9a-f]{40})?$/,
      );
    });
  });
});

describe('inbound X-Sigil-Service-Commit', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('surfaces serviceCommit on an approved result', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(ALLOWED_BODY, {
          headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
        }),
      );
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(result.decision).toBe('ALLOWED');
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it('surfaces serviceCommit on a denied result', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(DENIED_BODY, {
          headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
        }),
      );
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).toBe('SIGIL_BASH_BLOCKED');
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it('surfaces serviceCommit on a pending result', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(
          { status: 'PENDING', holdId: 'hold_abc123' },
          { headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT } },
        ),
      );
      const result = await checkIntent(
        { action: 'email.send' },
        { ...BASE_CONFIG, onPending: () => undefined },
      );
      expect(result.decision).toBe('PENDING');
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it('leaves serviceCommit absent when Sign sends no header', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      const approved = await checkIntent(INTENT, BASE_CONFIG);
      expect(approved.serviceCommit).toBeUndefined();
      expect('serviceCommit' in approved).toBe(false);

      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(DENIED_BODY));
      const denied = await checkIntent(INTENT, BASE_CONFIG);
      expect(denied.serviceCommit).toBeUndefined();
      expect('serviceCommit' in denied).toBe(false);
    });
  });

  it('surfaces serviceCommit through strictResponse validation', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(DENIED_BODY, {
          headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
        }),
      );
      const result = await checkIntent(INTENT, { ...BASE_CONFIG, strictResponse: true });
      expect(result.decision).toBe('DENIED');
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it('surfaces serviceCommit on a protocol denial with a reached response', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
        }),
      );
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(result).toMatchObject({
        decision: 'DENIED',
        errorCode: 'SIGIL_RESPONSE_INVALID',
      });
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it.each([
    ['ordinary', 401, false, JSON.stringify({ message: 'unauthorized' })],
    ['strict', 401, true, JSON.stringify({ message: 'unauthorized' })],
    ['ordinary', 403, false, '<html>not a policy denial</html>'],
    ['strict', 403, true, '<html>not a policy denial</html>'],
  ])('surfaces serviceCommit on %s authentication denial HTTP %i', async (_mode, status, strictResponse, body) => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body, {
        status,
        headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
      }));
      const result = await checkIntent(INTENT, { ...BASE_CONFIG, strictResponse });
      expect(result).toMatchObject({
        decision: 'DENIED',
        errorCode: 'SIGIL_AUTH_FAILURE',
        serviceCommit: SERVICE_COMMIT,
      });
    });
  });
});

describe('observability fields never affect enforcement', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends request bytes that are identical with and without the client header', async () => {
    const identityCases: Array<Partial<Record<IdentityKey, string | undefined>>> = [
      IDENTITY,
      {},
    ];
    const bodies: string[] = [];
    for (const identity of identityCases) {
      await withIdentity(identity, async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
        await checkIntent(INTENT, { ...BASE_CONFIG, agentId: 'agent-a' });
        // The request nonce is deliberately fresh per call; every other byte is
        // pinned, including indentation and the trailing newline.
        bodies.push(sentBody().replace(/"request_nonce": "[^"]*",/, '"request_nonce": "-",'));
      });
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain(SIGIL_CLIENT_HEADER);
    expect(bodies[0].endsWith('\n')).toBe(true);
  });

  it('reaches the same decision with and without the service-commit header', async () => {
    const headerCases: Array<Record<string, string>> = [
      {},
      { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
    ];
    const results: SigilHookResult[] = [];
    for (const headers of headerCases) {
      await withIdentity(IDENTITY, async () => {
        vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(DENIED_BODY, { headers }));
        results.push(await checkIntent(INTENT, BASE_CONFIG));
      });
    }
    expect(results[0]?.decision).toBe('DENIED');
    const { serviceCommit, ...rest } = { ...results[1] };
    expect(serviceCommit).toBe(SERVICE_COMMIT);
    expect(rest).toEqual(results[0]);
  });

  it('reaches the same denial when the response header carries junk', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
    const base = await checkIntent(INTENT, BASE_CONFIG);
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(ALLOWED_BODY, {
          headers: { [SIGIL_SERVICE_COMMIT_HEADER]: '; name=fake; commit=' },
        }),
      );
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(result.decision).toBe(base.decision);
      expect(result.serviceCommit).toBe('; name=fake; commit=');
    });
  });

  it('works as an old client against a new server', async () => {
    // No build identity: the old client sends no client header at all, and the
    // new server's response header changes nothing about the decision.
    await withIdentity({}, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(ALLOWED_BODY, {
          headers: { [SIGIL_SERVICE_COMMIT_HEADER]: SERVICE_COMMIT },
        }),
      );
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toBeUndefined();
      expect(result.decision).toBe('ALLOWED');
      expect(result.serviceCommit).toBe(SERVICE_COMMIT);
    });
  });

  it('works as a new client against an old server', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      const result = await checkIntent(INTENT, BASE_CONFIG);
      expect(sentHeaders()[SIGIL_CLIENT_HEADER]).toBe(
        `name=@sigilcore/agent-hooks; version=0.10.0; commit=${COMMIT}`,
      );
      expect(result.decision).toBe('ALLOWED');
      expect(result.serviceCommit).toBeUndefined();
    });
  });

  it('does not let the client header change what the request body projects', async () => {
    await withIdentity(IDENTITY, async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ALLOWED_BODY));
      await checkIntent(INTENT, BASE_CONFIG);
      const wireBody = JSON.parse(sentBody()) as Record<string, unknown>;
      const projected = buildAuthorizeRequestBody(INTENT, BASE_CONFIG);
      delete projected.request_nonce;
      delete wireBody.request_nonce;
      expect(wireBody).toEqual(projected);
      expect(Object.keys(wireBody)).not.toContain('client');
      expect(Object.keys(wireBody)).not.toContain('clientVersion');
    });
  });
});
