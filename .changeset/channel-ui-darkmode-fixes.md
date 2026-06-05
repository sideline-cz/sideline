---
"@sideline/web": patch
---

Fix two dark-mode/UX issues in the channel management dialogs

- The destructive confirm button (Adopt / Archive / Bulk archive / Remove access)
  rendered white-on-white in dark mode because a `className` override lost to the
  AlertDialogAction's default button variant; it now uses the `destructive`
  button variant for correct contrast.
- The access-level select showed its option description in the collapsed trigger,
  causing overflow; the trigger now shows only the level label.
