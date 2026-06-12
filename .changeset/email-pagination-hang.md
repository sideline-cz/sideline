---
"@sideline/bot": patch
"@sideline/i18n": patch
---

Fix the original/detailed email preview buttons hanging on a perpetual "loading" state for very large emails. The ephemeral interaction is now always resolved even when fetching/rendering fails, and oversized email bodies are capped at 20 pages with a truncation notice (plus a Sideline deep link when configured).
