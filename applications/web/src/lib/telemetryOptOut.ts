/**
 * Whether this browser may send telemetry.
 *
 * Telemetry runs on **legitimate interest** (GDPR Art. 6(1)(f)), which the
 * privacy policy states in §3 — it is not consent, so there is no banner and
 * nothing to opt *in* to. What Art. 21 does require, and what §6 of the policy
 * promises, is a way to **object**. This module is that mechanism.
 *
 * Precedence, strongest first:
 *
 * 1. **A browser privacy signal** — Global Privacy Control or Do Not Track.
 *    These are a machine-readable objection, so they win over the stored
 *    preference and the UI shows the switch as forced off.
 * 2. **The stored preference** for this browser.
 * 3. **On by default**, which is what legitimate interest permits.
 *
 * Deliberately self-contained and never throwing, in the shape of
 * `resolveStoredTheme.ts`: `beaconCrash` calls this from a crashed or
 * not-yet-initialised page, so it must not import anything from the app
 * runtime and must not be able to add a second failure to the first.
 *
 * The preference is per-browser rather than per-account because the objection
 * is about what this device transmits, and because the crash beacon has to
 * consult it before any account is known. §7 of the policy already discloses
 * that local storage holds device preferences.
 */

/** Matches the `sideline-` prefix used by the theme key. */
const STORAGE_KEY = 'sideline-telemetry-opt-out';

declare global {
  interface Navigator {
    /** https://globalprivacycontrol.github.io/gpc-spec/ — not in lib.dom yet. */
    readonly globalPrivacyControl?: boolean;
    readonly msDoNotTrack?: string;
  }
  interface Window {
    readonly doNotTrack?: string;
  }
}

/**
 * True when the browser itself signals an objection. Checked before the stored
 * preference so a privacy-configured browser is honoured even on first visit.
 */
export function browserSignalsOptOut(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    if (navigator.globalPrivacyControl === true) return true;
    // DNT is deprecated but still emitted, and it is unambiguous when '1'.
    const dnt = navigator.doNotTrack ?? window.doNotTrack ?? navigator.msDoNotTrack;
    return dnt === '1' || dnt === 'yes';
  } catch {
    return false;
  }
}

/** True when this browser has stored an objection. */
function storedOptOut(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // Unreadable storage (private window, quota, blocked site data) means this
    // browser holds no objection we can see — not that one was made. Default
    // to what legitimate interest allows rather than guessing either way.
    return false;
  }
}

/**
 * The single gate for every telemetry send path.
 *
 * Returns `true` off the browser (SSR, tests): the opt-out governs what a
 * *user's device* transmits, not the web server's own instrumentation, and the
 * server has no `navigator` to consult.
 */
export function isTelemetryAllowed(): boolean {
  if (typeof window === 'undefined') return true;
  if (browserSignalsOptOut()) return false;
  return !storedOptOut();
}

/** Records or clears this browser's objection. Never throws. */
export function setTelemetryOptOut(optOut: boolean): void {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
    if (optOut) {
      localStorage.setItem(STORAGE_KEY, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // A browser that cannot store the objection still honours it for this
    // page's lifetime via the caller's own state; nothing else we can do.
  }
}

export const TELEMETRY_OPT_OUT_STORAGE_KEY = STORAGE_KEY;
