# Bug Fix Plan — Onboarding Token Modal Overlay & Copy Error

**Bug:** When generating an onboarding token, (1) the overlay darkens everything when the modal opens, and (2) clicking copy copies the token but then shows an error page.

**Branch:** `fix/onboarding-token-modal-overlay`
**Scope:** Website only — single file + one new test file. No `dialog.tsx`, translation, domain, or migration changes.

---

## Root Cause (evidence-based)

`MintedLinkDialog` diverges from the proven, working `CreateInviteDialog` (which uses the **same** dialog primitives and works fine in production):

1. **Overlay stays dark / "swapped":** `MintedLinkDialog` is mounted conditionally (`{mintedUrl !== null && ...}`) and **force-unmounted on close** (`setMintedUrl(null)`), tearing down Radix's portal abruptly and orphaning the dark overlay in `document.body`. `CreateInviteDialog` instead stays mounted and just resets state. → The shared `z-50` tie is **NOT** the cause (otherwise every dialog would be dark), so `dialog.tsx` is left untouched.

2. **Copy shows error page:** `handleCopy` has no `if (!url) return` guard, no `navigator.clipboard` existence guard (undefined on insecure contexts → synchronous `TypeError`), and no `.catch()` (rejection on permission denial). Also "Copied!" text is swapped *inside* a square `size='icon'` button, clipping it.

---

## Changes

### `applications/web/src/components/pages/AdminOnboardingTokensPage.tsx`

1. **Export** `MintedLinkDialog` (for testing).
2. **Harden `handleCopy`:** add `if (!url) return;`, `if (!navigator.clipboard) return;`, and a non-rethrowing `.catch()`.
3. **Move "Copied!"** to a separate green text line below the input; keep the copy button as icon + `sr-only` label (matches `CreateInviteDialog`).
4. **Render `MintedLinkDialog` unconditionally**, passing `url={mintedUrl ?? ''}` (always mounted, visibility driven by `open`).
5. **Simplify `handleMintDialogClose`** to just `setMintDialogOpen(open)` — drop the synchronous `setMintedUrl(null)`. The existing `useEffect` already resets `copied` on close.

**Rejected (over-engineering / blast radius):** z-index change in shared `dialog.tsx`; a 3-state idle/copied/error machine; a new `admin_onboarding_copyFailed` translation key.

---

## Tests — `applications/web/test/MintedLinkDialog.test.tsx` (new)

Follows `RecordPaymentDialog.test.tsx` conventions (mock `~/lib/translations.js`, dynamic import, Testing Library).

1. Renders success content (title + URL) when `open=true`.
2. **Failing-first:** `clipboard.writeText` rejects → no throw, no unhandled rejection.
3. **Failing-first:** `navigator.clipboard` undefined → click does not throw.
4. "Copied!" renders as a separate line, **not** inside the copy button.
5. **Overlay teardown:** re-render `open=false` → no `[data-slot='dialog-overlay']` left in `document.body`.
6. `url=''` guard → copy is a no-op.

Tests 2 & 3 fail against current code and pass after the fix.
