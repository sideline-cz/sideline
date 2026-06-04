// Tests for the MintedLinkDialog component exported from AdminOnboardingTokensPage.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      admin_onboarding_copyLink: 'Copy link',
      admin_onboarding_copied: 'Copied!',
      admin_onboarding_done: 'Done',
      admin_onboarding_mintSuccessTitle: 'Onboarding link created',
      admin_onboarding_mintSuccessDescription: 'Share this link with the new team.',
      admin_onboarding_oneTimeWarning: 'This link can only be viewed once.',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Dynamic import AFTER mocks — will fail until MintedLinkDialog is exported
const { MintedLinkDialog } = await import('~/components/pages/AdminOnboardingTokensPage.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  url: 'https://x/onboarding/abc',
  proposedName: 'FC Test',
  discordId: '123456789012345678',
};

function renderDialog(overrides: Partial<typeof DEFAULT_PROPS> = {}) {
  const props = { ...DEFAULT_PROPS, onOpenChange: vi.fn(), ...overrides };
  return render(<MintedLinkDialog {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MintedLinkDialog', () => {
  describe('Test 1 — renders success content when open', () => {
    it('shows the URL in a readonly input when open=true', () => {
      renderDialog({ open: true });
      // Radix renders dialog content into a portal on document.body
      const input = screen.getByDisplayValue('https://x/onboarding/abc') as HTMLInputElement;
      expect(input).not.toBeNull();
    });
  });

  describe('Test 2 — clipboard.writeText rejection does not cause unhandled rejection', () => {
    let originalClipboard: Clipboard;
    const unhandledRejections: PromiseRejectionEvent[] = [];

    let rejectionHandler: (e: PromiseRejectionEvent) => void;

    beforeEach(() => {
      originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
        writable: true,
      });
      unhandledRejections.length = 0;
      rejectionHandler = (e) => {
        unhandledRejections.push(e);
      };
      window.addEventListener('unhandledrejection', rejectionHandler);
    });

    afterEach(() => {
      window.removeEventListener('unhandledrejection', rejectionHandler);
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('clicking Copy when writeText rejects does not throw and produces no unhandled rejection', async () => {
      renderDialog({ open: true });
      const copyButton = screen.getByRole('button', { name: /Copy link/i });

      // Click must not throw synchronously
      expect(() => fireEvent.click(copyButton)).not.toThrow();

      // Wait for writeText to have been called
      await waitFor(() => {
        expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalled();
      });

      // Flush microtasks / macrotasks so the rejection propagates if unhandled
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandledRejections).toHaveLength(0);
    });
  });

  describe('Test 3 — navigator.clipboard undefined does not throw', () => {
    let originalClipboard: Clipboard;

    beforeEach(() => {
      originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('clicking Copy when clipboard is undefined does not throw', () => {
      renderDialog({ open: true });
      const copyButton = screen.getByRole('button', { name: /Copy link/i });
      expect(() => fireEvent.click(copyButton)).not.toThrow();
    });
  });

  describe('Test 4 — "Copied!" renders outside the copy button', () => {
    let originalClipboard: Clipboard;

    beforeEach(() => {
      originalClipboard = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('"Copied!" text appears but is NOT inside the copy button', async () => {
      renderDialog({ open: true });
      const copyButton = screen.getByRole('button', { name: /Copy link/i });

      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(screen.getByText('Copied!')).not.toBeNull();
      });

      // "Copied!" must not be inside the copy button's text content
      expect(copyButton.textContent).not.toContain('Copied!');
    });
  });

  describe('Test 5 — overlay teardown when dialog closes', () => {
    it('overlay is present when open=true and removed when open=false', async () => {
      const { rerender } = render(
        <MintedLinkDialog
          open={true}
          onOpenChange={vi.fn()}
          url='https://x/onboarding/abc'
          proposedName='FC Test'
          discordId='123456789012345678'
        />,
      );

      // Overlay should be present when open
      expect(document.body.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();

      // Close the dialog
      rerender(
        <MintedLinkDialog
          open={false}
          onOpenChange={vi.fn()}
          url='https://x/onboarding/abc'
          proposedName='FC Test'
          discordId='123456789012345678'
        />,
      );

      // Overlay should be gone after closing
      await waitFor(() => {
        expect(document.body.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      });
    });
  });

  describe('Test 6 — empty URL guard prevents clipboard write', () => {
    let originalClipboard: Clipboard;
    let writeTextMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalClipboard = navigator.clipboard;
      writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    });

    it('clicking Copy when url="" does not call clipboard.writeText and does not show "Copied!"', async () => {
      renderDialog({ open: true, url: '' });
      const copyButton = screen.getByRole('button', { name: /Copy link/i });

      fireEvent.click(copyButton);

      // Give microtasks time to settle
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(writeTextMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Copied!')).toBeNull();
    });
  });
});
