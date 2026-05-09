# Template Renderer Package (`@sideline/template-renderer`)

Pure rendering utilities for the Discord welcome flow. **No Effect runtime, no I/O.** Consumed by both the server (renders `welcome_message_template` inside the `Guild/RegisterMember` RPC handler) and the web app (live preview in the team-settings welcome editor).

## Architecture

```
src/
├── index.ts        — Re-exports applyTemplate, color, sanitize
├── applyTemplate.ts — Placeholder substitution
├── color.ts         — Hex color sanitization
└── sanitize.ts      — Mention neutering + length truncation
test/
└── *.test.ts        — Pure unit tests (vitest, no @effect/vitest helpers)
```

## Constraints

1. **No Effect imports.** This package must remain runtime-agnostic so the web preview can call `applyTemplate` synchronously inside React render. Do not add `effect` to `dependencies` or `peerDependencies`.
2. **No I/O.** All exported functions are pure and synchronous (`string -> string` or `string -> number`).
3. **Schema lives in `@sideline/domain`.** This package does not own the `welcome_message_template` schema — only the substitution logic.

## Public API

### `applyTemplate(template, vars): string`

Replaces known `{placeholders}` from `vars`. Unknown placeholders are left intact (not erased) — this lets users escape literal braces.

| Placeholder | Source |
|-------------|--------|
| `{memberMention}` | `<@discord_id>` of the joining member |
| `{memberName}` | Member's display_name, falling back to username |
| `{inviterMention}` | `<@discord_id>` of the inviter, or `''` if unknown |
| `{inviterName}` | Inviter's username |
| `{groupName}` | Invite's group name, or `''` if the invite has no group |
| `{teamName}` | Team name |

The exhaustive list is defined as `TEMPLATE_KEYS` in `applyTemplate.ts`. When adding a new placeholder, add it to both `TemplateVars` and `TEMPLATE_KEYS`.

### `sanitizeRendered(rendered): string`

Post-processes a rendered string before sending to Discord:

1. Replaces `@everyone` with `@<ZWSP>everyone` and `@here` with `@<ZWSP>here` (zero-width space breaks the mention parser).
2. Hard-truncates to `DISCORD_EMBED_DESCRIPTION_MAX = 4096` characters (Discord embed description limit).

Always call `sanitizeRendered(applyTemplate(...))` — never send raw user templates to Discord.

### `sanitizeHexColor(hex): number`

Validates against `^#[0-9a-fA-F]{6}$`, parses to a Discord integer color. Falls back to `DISCORD_BLURPLE = 0x5865f2` for null, undefined, or invalid input.

## Testing

Pure vitest tests in `test/`. Do not import `@effect/vitest` — these functions are synchronous and have no Effect dependencies.

```bash
pnpm --filter @sideline/template-renderer test
```
