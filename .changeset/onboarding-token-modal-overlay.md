---
'@sideline/web': patch
---

Fix the onboarding-token admin page where generating a token left a dark overlay stuck on screen and the copy button could show an error page. The minted-link dialog is now always mounted and driven by its `open` prop (instead of being force-unmounted on close, which orphaned the Radix overlay), the one-time token is scrubbed from state on close, and the copy handler guards `navigator.clipboard` and swallows rejections.

The same hardening is applied app-wide: a shared `copyToClipboard()` helper now backs all clipboard-copy call sites (team invites, calendar subscription, invite dialog), and four more conditionally-mounted dialogs (activity-type form, cannot-delete, edit-built-in achievement sheet, custom-achievement) were refactored to the always-mounted pattern with reset-on-open to avoid the same overlay-leak and stale-state bugs.
