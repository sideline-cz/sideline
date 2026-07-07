import type React from 'react';
import { resolveStoredTheme } from '~/lib/resolveStoredTheme.js';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif';

/**
 * Minimal, theme-aware placeholder shown for the brief moment between a crash and
 * the automatic one-shot reload (see AppErrorBoundary). Rendering this instead of
 * the full crash screen avoids flashing "Something went wrong" when the app is
 * about to reload itself anyway.
 */
export function AppReloadingScreen(): React.JSX.Element {
  // Use the stored app theme, not the OS preference, to match AppCrashFallback.
  const isDark = resolveStoredTheme() === 'dark';
  const bg = isDark ? '#0a0a0a' : '#ffffff';
  const fg = isDark ? '#999' : '#666';
  const track = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(10,10,10,0.15)';
  const head = isDark ? '#ffffff' : '#0a0a0a';

  return (
    <div
      role='status'
      aria-live='polite'
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100dvh',
        gap: '1rem',
        backgroundColor: bg,
        color: fg,
        fontFamily: FONT_STACK,
      }}
    >
      <div
        style={{
          width: '2rem',
          height: '2rem',
          border: `3px solid ${track}`,
          borderTopColor: head,
          borderRadius: '50%',
          animation: 'sideline-reload-spin 0.8s linear infinite',
        }}
      />
      <p style={{ fontSize: '0.9375rem', margin: 0 }}>Reloading…</p>
      <style>{'@keyframes sideline-reload-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}
