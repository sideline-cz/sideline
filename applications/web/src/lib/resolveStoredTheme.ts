/**
 * Tiny self-contained theme resolver for crash surfaces.
 *
 * Rules:
 *  1. Read `localStorage['sideline-theme']` (matches theme.tsx STORAGE_KEY).
 *  2. If stored value is 'dark'  → dark.
 *  3. If stored value is 'light' → light.
 *  4. For 'system' or unset → fall back to matchMedia.
 *
 * NEVER throws and has NO imports from the app runtime.
 */
export function resolveStoredTheme(): 'dark' | 'light' {
  try {
    const stored =
      typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
        ? localStorage.getItem('sideline-theme')
        : null;
    if (stored === 'dark') return 'dark';
    if (stored === 'light') return 'light';
  } catch {
    // localStorage unavailable (privacy/quota) — fall through to matchMedia
  }
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    // matchMedia unavailable — default to dark (app default)
  }
  return 'dark';
}

/**
 * Re-asserts the resolved theme on <html> and <body> so that crash UIs are
 * never rendered on a white background even when ThemeProvider has unmounted.
 *
 * Safe to call multiple times / from inside getDerivedStateFromError.
 */
export function reassertThemeOnDocument(): void {
  try {
    if (typeof document === 'undefined') return;
    const resolved = resolveStoredTheme();
    const html = document.documentElement;
    const body = document.body;
    if (resolved === 'dark') {
      html.classList.add('dark');
      html.style.colorScheme = 'dark';
      html.style.backgroundColor = '#0a0a0a';
      if (body) body.style.backgroundColor = '#0a0a0a';
    } else {
      html.classList.remove('dark');
      html.style.colorScheme = 'light';
      html.style.backgroundColor = '#ffffff';
      if (body) body.style.backgroundColor = '#ffffff';
    }
  } catch {
    // Never throw from a crash surface
  }
}
