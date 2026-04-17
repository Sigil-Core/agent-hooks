// tests/framework-registry.test.ts
import { describe, it, expect } from 'vitest';
import { FRAMEWORKS } from '../src/framework-registry.js';
import * as pkg from '../src/index.js';

describe('FRAMEWORKS registry', () => {
  it('exports the expected set of framework ids', () => {
    const ids = Object.keys(FRAMEWORKS).sort();
    expect(ids).toEqual(
      [
        'agent-hooks',
        'agentpay',
        'anthropic-sdk',
        'eliza',
        'ironclaw',
        'langchain',
        'nemoclaw',
        'openclaw',
      ].sort(),
    );
  });

  it('each entry has an id that matches its key', () => {
    for (const [key, descriptor] of Object.entries(FRAMEWORKS)) {
      expect(descriptor.id).toBe(key);
    }
  });

  it('adapter entries reference a symbol exported from the package index', () => {
    for (const descriptor of Object.values(FRAMEWORKS)) {
      if (descriptor.integrationType === 'adapter' && descriptor.adapterExport) {
        expect(pkg).toHaveProperty(descriptor.adapterExport);
        expect(typeof (pkg as Record<string, unknown>)[descriptor.adapterExport]).toBe(
          'function',
        );
      }
    }
  });

  it('documentation entries do not set adapterExport', () => {
    for (const descriptor of Object.values(FRAMEWORKS)) {
      if (descriptor.integrationType === 'documentation') {
        expect(descriptor.adapterExport).toBeUndefined();
      }
    }
  });

  it('openclaw and nemoclaw share the same adapterExport', () => {
    expect(FRAMEWORKS.openclaw!.adapterExport).toBe('createOpenclawSigilHandler');
    expect(FRAMEWORKS.nemoclaw!.adapterExport).toBe('createOpenclawSigilHandler');
  });

  it('ironclaw is marked as rust + documentation', () => {
    expect(FRAMEWORKS.ironclaw!.language).toBe('rust');
    expect(FRAMEWORKS.ironclaw!.integrationType).toBe('documentation');
  });
});
