---
"@sideline/bot": patch
---

Adopt dfx `UI.*` builders (`UI.row`, `UI.button`, `UI.textInput`, `UI.userSelect`) for Discord message component construction across the bot, replacing hand-built component JSON. Behaviour-preserving refactor — the emitted component payloads (custom ids, styles, labels, disabled flags, urls, placeholders, min/max, required) are unchanged.
