import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildMyStatusQr } from '~/rpc/finance/index.js';

const BASE = {
  iban: Option.some('CZ6508000000192000145399'),
  recipientName: Option.some('TJ Sideline'),
  variableSymbol: '12345',
  currency: 'CZK',
};

const run = (overrides: Partial<Parameters<typeof buildMyStatusQr>[0]>) =>
  Effect.runPromise(buildMyStatusQr({ ...BASE, netOutstandingMinor: 0, ...overrides }));

describe('buildMyStatusQr', () => {
  it('carries the net outstanding sum as AM when the member owes something', async () => {
    const qr = await run({ netOutstandingMinor: 50000 });
    expect(qr).not.toBeNull();
    const spayd = qr?.spayd ?? '';
    expect(spayd).toContain('AM:500.00');
    expect(spayd).toContain('X-VS:12345');
  });

  it('omits AM entirely when the net is zero — the standing "any amount" code', async () => {
    const qr = await run({ netOutstandingMinor: 0 });
    expect(qr).not.toBeNull();
    const spayd = qr?.spayd ?? '';
    expect(spayd).not.toContain('AM:');
    // Still a usable top-up code: the account and the member's symbol are what make it match.
    expect(spayd).toContain('X-VS:12345');
  });

  it('renders a PNG for both states', async () => {
    for (const netOutstandingMinor of [0, 50000]) {
      const qr = await run({ netOutstandingMinor });
      expect((qr?.png_base64 ?? '').length).toBeGreaterThan(0);
      expect(qr?.filename).toBe('qr-finance-status.png');
    }
  });

  it('is null without an IBAN or without a variable symbol — the command degrades, never fails', async () => {
    expect(await run({ iban: Option.none(), netOutstandingMinor: 50000 })).toBeNull();
    expect(await run({ variableSymbol: null })).toBeNull();
    // A symbol that normalises away (all zeroes) is no symbol at all.
    expect(await run({ variableSymbol: '000' })).toBeNull();
  });

  it('normalises the variable symbol the same way the payment matcher does', async () => {
    const qr = await run({ variableSymbol: ' 007 ' });
    expect(qr?.spayd).toContain('X-VS:7');
  });
});
