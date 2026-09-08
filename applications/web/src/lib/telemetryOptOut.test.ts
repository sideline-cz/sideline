// Telemetry runs on legitimate interest (privacy policy §3), so this module is
// the *objection* mechanism Art. 21 requires and §6 promises — not a consent
// gate. These tests pin the precedence, because getting it wrong either keeps
// sending after someone objected or silently disables monitoring for everyone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserSignalsOptOut,
  isTelemetryAllowed,
  setTelemetryOptOut,
  TELEMETRY_OPT_OUT_STORAGE_KEY,
} from './telemetryOptOut.js';

const defineNav = (prop: string, value: unknown) => {
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true });
};

beforeEach(() => {
  localStorage.clear();
  defineNav('globalPrivacyControl', undefined);
  defineNav('doNotTrack', null);
  defineNav('msDoNotTrack', undefined);
  Object.defineProperty(window, 'doNotTrack', {
    value: undefined,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('isTelemetryAllowed', () => {
  it('allows telemetry by default — legitimate interest needs no opt-in', () => {
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('honours a stored objection', () => {
    setTelemetryOptOut(true);
    expect(isTelemetryAllowed()).toBe(false);
  });

  it('allows again once the objection is withdrawn', () => {
    setTelemetryOptOut(true);
    setTelemetryOptOut(false);
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('treats Global Privacy Control as an objection, with no stored preference', () => {
    defineNav('globalPrivacyControl', true);
    expect(isTelemetryAllowed()).toBe(false);
  });

  it('treats Do Not Track as an objection', () => {
    defineNav('doNotTrack', '1');
    expect(isTelemetryAllowed()).toBe(false);
  });

  it("ignores Do Not Track's explicit opt-in value, which is not an objection", () => {
    defineNav('doNotTrack', '0');
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('lets the browser signal win over a stored allow', () => {
    setTelemetryOptOut(false);
    defineNav('globalPrivacyControl', true);
    expect(isTelemetryAllowed()).toBe(false);
  });

  it('allows when localStorage throws — an unreadable store holds no objection', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: site data blocked');
    });
    expect(isTelemetryAllowed()).toBe(true);
  });

  it('does not throw when navigator is hostile', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', {
      get() {
        throw new Error('nope');
      },
      configurable: true,
    });
    expect(() => isTelemetryAllowed()).not.toThrow();
  });
});

describe('setTelemetryOptOut', () => {
  it('stores the objection under the key the inline guard interpolates', () => {
    setTelemetryOptOut(true);
    expect(localStorage.getItem(TELEMETRY_OPT_OUT_STORAGE_KEY)).toBe('true');
  });

  it('removes the key rather than storing false, so default-on stays the default', () => {
    setTelemetryOptOut(true);
    setTelemetryOptOut(false);
    expect(localStorage.getItem(TELEMETRY_OPT_OUT_STORAGE_KEY)).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setTelemetryOptOut(true)).not.toThrow();
  });
});

describe('browserSignalsOptOut', () => {
  it('is false with no signal, so the UI switch stays operable', () => {
    expect(browserSignalsOptOut()).toBe(false);
  });

  it('is true under GPC, which is what disables the UI switch', () => {
    defineNav('globalPrivacyControl', true);
    expect(browserSignalsOptOut()).toBe(true);
  });

  it('does not confuse a stored objection for a browser signal', () => {
    setTelemetryOptOut(true);
    expect(browserSignalsOptOut()).toBe(false);
  });
});
