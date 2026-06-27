import { clearReloadGuard, RELOAD_CAP, RELOAD_COUNT_KEY } from './reloadGuard.js';

export const WATCHDOG_MS = 10000;
export const MOUNTED_FLAG = '__SIDELINE_MOUNTED__';

declare global {
  interface Window {
    __SIDELINE_MOUNTED__: boolean;
    __SIDELINE_CRASHED__?: boolean;
    __SIDELINE_PENDING_ERRORS__: Array<{ message: string; stack?: string; ts: number }>;
    __SIDELINE_WATCHDOG_TIMER__?: number;
  }
}

function buildRecoveryHtml(): string {
  return (
    '<div style="' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'min-height:100dvh;padding:2rem;padding-top:max(2rem,env(safe-area-inset-top));' +
    'padding-bottom:max(2rem,env(safe-area-inset-bottom));' +
    'text-align:center;box-sizing:border-box;' +
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
    'background-color:#0a0a0a;color:#ffffff;' +
    '">' +
    '<div style="font-size:4rem;margin-bottom:1.5rem;">&#128305;</div>' +
    '<h1 style="font-size:1.75rem;font-weight:700;margin-bottom:0.75rem;">Something went wrong</h1>' +
    '<p style="font-size:1rem;color:#999;max-width:360px;line-height:1.5;margin-bottom:2rem;">' +
    'Don’t worry — your data is safe. The app hit an unexpected glitch.' +
    '</p>' +
    '<div style="display:flex;gap:0.75rem;flex-wrap:wrap;justify-content:center;">' +
    '<button type="button" id="__sideline_reload_btn" style="' +
    'background-color:#ffffff;color:#0a0a0a;border:none;border-radius:0.5rem;' +
    'padding:0.75rem 1.5rem;font-size:1rem;font-weight:500;cursor:pointer;min-height:44px;' +
    '">Reload</button>' +
    '<button type="button" id="__sideline_reset_btn" style="' +
    'background-color:transparent;color:#ffffff;border:1px solid rgba(255,255,255,0.25);' +
    'border-radius:0.5rem;padding:0.75rem 1.5rem;font-size:1rem;font-weight:500;cursor:pointer;min-height:44px;' +
    '">Reset app</button>' +
    '</div>' +
    '<p style="font-size:0.8125rem;color:#777;max-width:360px;margin-top:1rem;">' +
    'Still stuck? “Reset app” unregisters the service worker and reloads a fresh copy.' +
    '</p>' +
    '</div>'
  );
}

// Inline IIFE source — ES5-safe, no imports, eval()-able in jsdom
export const PRE_MOUNT_GUARD_SOURCE: string = `(function() {
  var MOUNTED_FLAG = '__SIDELINE_MOUNTED__';
  var RELOAD_COUNT_KEY = '${RELOAD_COUNT_KEY}';
  var RELOAD_CAP = ${RELOAD_CAP};
  var WATCHDOG_MS = ${WATCHDOG_MS};

  window[MOUNTED_FLAG] = false;
  window.__SIDELINE_PENDING_ERRORS__ = window.__SIDELINE_PENDING_ERRORS__ || [];

  function resolveTheme() {
    try {
      var stored = localStorage.getItem('sideline-theme');
      if (stored === 'dark') return 'dark';
      if (stored === 'light') return 'light';
    } catch (e) {}
    try {
      if (typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
    } catch (e) {}
    return 'dark';
  }

  function getReloadCount() {
    try {
      var val = sessionStorage.getItem(RELOAD_COUNT_KEY);
      if (!val) return 0;
      var n = parseInt(val, 10);
      return isNaN(n) ? 0 : n;
    } catch (e) {
      return 0;
    }
  }

  function incrementAndReload() {
    var count = getReloadCount();
    if (count >= RELOAD_CAP) return false;
    try {
      sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
    } catch (e) {}
    window.location.reload();
    return true;
  }

  function sendPreMountBeacon(msg, stack) {
    try {
      var endpoint = window.__SIDELINE_OTLP__;
      if (!endpoint) return;
      var payload = JSON.stringify({
        message: msg,
        stack: stack,
        phase: 'pre-mount',
        url: window.location.href,
        ts: Date.now()
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], {type: 'application/json'}));
      } else if (typeof fetch === 'function') {
        fetch(endpoint, { method: 'POST', body: payload, keepalive: true }).catch(function() {});
      }
    } catch (e) {}
  }

  function doReset() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        navigator.serviceWorker.getRegistrations().then(function(regs) {
          var ps = regs.map(function(r) { return r.unregister(); });
          return Promise.all(ps);
        }).catch(function() {}).then(function() {
          window.location.reload();
        });
      } else {
        window.location.reload();
      }
    } catch (e) {
      window.location.reload();
    }
  }

  function showRecovery() {
    try {
      var theme = resolveTheme();
      var bg = theme === 'dark' ? '#0a0a0a' : '#ffffff';
      var fg = theme === 'dark' ? '#ffffff' : '#0a0a0a';
      var muted = theme === 'dark' ? '#999' : '#666';
      var faint = theme === 'dark' ? '#777' : '#888';
      var primaryBg = theme === 'dark' ? '#ffffff' : '#0a0a0a';
      var primaryFg = theme === 'dark' ? '#0a0a0a' : '#ffffff';
      var outlineBorder = theme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(10,10,10,0.2)';
      document.documentElement.style.backgroundColor = bg;
      if (document.body) document.body.style.backgroundColor = bg;
      var div = document.createElement('div');
      div.innerHTML = ${JSON.stringify(buildRecoveryHtml())};
      var inner = div.firstChild;
      if (inner) {
        inner.style.backgroundColor = bg;
        inner.style.color = fg;
      }
      document.body.innerHTML = '';
      if (inner) document.body.appendChild(inner);
      var h1 = document.querySelector('h1');
      if (h1) h1.style.color = fg;
      var reloadBtn = document.getElementById('__sideline_reload_btn');
      var resetBtn = document.getElementById('__sideline_reset_btn');
      if (reloadBtn) {
        reloadBtn.style.backgroundColor = primaryBg;
        reloadBtn.style.color = primaryFg;
        reloadBtn.addEventListener('click', function() { window.location.reload(); });
      }
      if (resetBtn) {
        resetBtn.style.backgroundColor = 'transparent';
        resetBtn.style.color = fg;
        resetBtn.style.border = '1px solid ' + outlineBorder;
        resetBtn.addEventListener('click', doReset);
      }
      var muteEls = document.querySelectorAll('p');
      for (var i = 0; i < muteEls.length; i++) {
        muteEls[i].style.color = i === 0 ? muted : faint;
      }
    } catch (e) {}
  }

  var watchdogTimer = setTimeout(function() {
    if (window[MOUNTED_FLAG] || window.__SIDELINE_CRASHED__) return;
    showRecovery();
  }, WATCHDOG_MS);

  // Store timer id so markAppMounted can clear it
  window.__SIDELINE_WATCHDOG_TIMER__ = watchdogTimer;

  window.addEventListener('vite:preloadError', function(event) {
    event.preventDefault();
    var reloaded = incrementAndReload();
    if (!reloaded) {
      showRecovery();
    }
  });

  var _prevOnerror = window.onerror;
  window.onerror = function(msg, source, lineno, colno, error) {
    if (!window[MOUNTED_FLAG]) {
      var message = (error && error.message) ? error.message : String(msg);
      var stack = (error && error.stack) ? error.stack : undefined;
      window.__SIDELINE_PENDING_ERRORS__.push({ message: message, stack: stack, ts: Date.now() });
      sendPreMountBeacon(message, stack);
    }
    if (_prevOnerror) return _prevOnerror.apply(window, arguments);
  };

  var _prevOnUnhandledRejection = window.onunhandledrejection;
  window.onunhandledrejection = function(event) {
    if (!window[MOUNTED_FLAG]) {
      var reason = event.reason;
      var message = (reason && reason.message) ? reason.message : String(reason);
      var stack = (reason && reason.stack) ? reason.stack : undefined;
      window.__SIDELINE_PENDING_ERRORS__.push({ message: message, stack: stack, ts: Date.now() });
      sendPreMountBeacon(message, stack);
    }
    if (_prevOnUnhandledRejection) return _prevOnUnhandledRejection.apply(window, arguments);
  };
})();`;

/**
 * Called from RootComponent useEffect on successful commit.
 * Sets the mounted flag and clears the watchdog timer.
 * NOTE: clearReloadGuard is intentionally NOT called here — the reload guard
 * should only be cleared once a real route has rendered successfully, not
 * merely when RootComponent commits (which happens even when Outlet crashes).
 * Call markRouteHealthy() from a successful child route render instead.
 */
export function markAppMounted(): void {
  if (typeof window !== 'undefined') {
    window[MOUNTED_FLAG] = true;
    const timerId = window.__SIDELINE_WATCHDOG_TIMER__;
    if (typeof timerId === 'number') {
      clearTimeout(timerId);
    }
  }
}

/**
 * Called once a real route (child of RootComponent) has rendered successfully.
 * Clears the reload guard so a subsequent intentional reload is not counted
 * against the crash cap.
 */
export function markRouteHealthy(): void {
  clearReloadGuard();
}
