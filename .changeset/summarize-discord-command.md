---
"@sideline/domain": patch
"@sideline/server": patch
"@sideline/bot": patch
"@sideline/i18n": patch
---

Add a `/summarize` Discord command that summarizes the current channel or thread

Members can now run `/summarize` in any channel or thread to get an LLM-generated
summary of the recent conversation. Two optional parameters refine the scope:
`messages` (1–200, default 50) caps how many recent messages are summarized, and
`since` accepts either a relative duration (`24h`, `7d`, `3d12h`) or an ISO date
(`2026-06-20`) to summarize only messages from that point onward. When neither is
given, the last 50 messages are used.

The bot fetches and paginates the channel history (newest-first, up to 200),
filters out bot and empty messages, and sends a fenced, author-labeled transcript
to the server. The server reuses the existing OpenAI-compatible `LlmClient` via a
new `Summarize/SummarizeChannel` RPC, treating the transcript as untrusted content
(prompt-injection guard) and falling back to a deterministic summary when no LLM is
configured or the call fails. The response is an ephemeral embed with a footer that
honestly reports how many messages were summarized and flags when the window was
capped or truncated; `allowed_mentions` is cleared so an echoed `@mention` never
pings. Available in English and Czech.
