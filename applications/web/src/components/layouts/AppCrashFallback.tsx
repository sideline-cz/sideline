import React from 'react';
import { requestReload } from '~/lib/reloadGuard.js';
import { resolveStoredTheme } from '~/lib/resolveStoredTheme.js';
import { resetApp } from '~/lib/sw-recovery.js';

export interface AppCrashFallbackProps {
  onReload?: () => void;
  onReset?: () => void | Promise<void>;
}

export function AppCrashFallback(props: AppCrashFallbackProps): React.JSX.Element {
  const [resetting, setResetting] = React.useState(false);

  // Use the stored app theme (localStorage['sideline-theme']) rather than
  // the raw OS preference — a user who chose dark mode in the app but whose
  // OS is set to light would otherwise get a white crash screen.
  const isDark = resolveStoredTheme() === 'dark';

  const bg = isDark ? '#0a0a0a' : '#ffffff';
  const fg = isDark ? '#ffffff' : '#0a0a0a';
  const muted = isDark ? '#999' : '#666';
  const faint = isDark ? '#777' : '#888';
  const primaryBg = isDark ? '#ffffff' : '#0a0a0a';
  const primaryText = isDark ? '#0a0a0a' : '#ffffff';
  const outlineBorder = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(10,10,10,0.2)';

  const handleReload = () => {
    if (props.onReload) {
      props.onReload();
    } else {
      requestReload('crash-fallback');
    }
  };

  const handleReset = async () => {
    const fn = props.onReset ?? resetApp;
    setResetting(true);
    try {
      await Promise.resolve(fn());
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100dvh',
        padding: '2rem',
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
        textAlign: 'center',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
        backgroundColor: bg,
        color: fg,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>🛟</div>

      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.75rem' }}>
        Something went wrong
      </h1>

      <p
        style={{
          fontSize: '1rem',
          color: muted,
          maxWidth: '360px',
          lineHeight: 1.5,
          marginBottom: '2rem',
        }}
      >
        Don&apos;t worry — your data is safe. The app hit an unexpected glitch. Reloading usually
        fixes it.
      </p>

      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <button
          type='button'
          onClick={handleReload}
          disabled={resetting}
          style={{
            backgroundColor: primaryBg,
            color: primaryText,
            border: 'none',
            borderRadius: '0.5rem',
            padding: '0.75rem 1.5rem',
            fontSize: '1rem',
            fontWeight: 500,
            cursor: 'pointer',
            minHeight: '44px',
            opacity: resetting ? 0.5 : 1,
          }}
        >
          Reload
        </button>

        <button
          type='button'
          onClick={handleReset}
          disabled={resetting}
          style={{
            backgroundColor: 'transparent',
            color: fg,
            border: `1px solid ${outlineBorder}`,
            borderRadius: '0.5rem',
            padding: '0.75rem 1.5rem',
            fontSize: '1rem',
            fontWeight: 500,
            cursor: 'pointer',
            minHeight: '44px',
            opacity: resetting ? 0.5 : 1,
          }}
        >
          {resetting ? 'Resetting…' : 'Reset app'}
        </button>
      </div>

      <p
        style={{
          fontSize: '0.8125rem',
          color: faint,
          maxWidth: '360px',
          marginTop: '1rem',
        }}
      >
        Still stuck? &ldquo;Reset app&rdquo; clears Sideline&apos;s saved offline data and reloads a
        fresh copy. You won&apos;t lose your account — you&apos;ll just need to be online.
      </p>
    </div>
  );
}
