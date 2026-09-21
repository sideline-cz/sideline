# Design: AI assistant — read-only search

UI/UX specification for the in-app AI assistant. **Scope of this PR: read-only.** The user asks a
question in natural language, the assistant answers in prose, and every entity it mentions is
rendered as a real, navigable card or link built from server-held typed data.

**The write/confirmation surface is explicitly out of scope** and moves to a follow-up PR (§9).
Nothing in this document proposes, confirms or applies a change.

Scope: `applications/web` only. The wire contract is fixed (below) and is designed *against*, not
redesigned.

## Fixed wire contract

```
GET  /teams/:teamId/ai/capabilities  -> { enabled: boolean }

POST /teams/:teamId/ai/chat
  body: { messages: [{ role: 'user' | 'assistant', content: string }] }   // <=20 msgs, 1..2000 chars each
  -> { answer: string,                       // plain text, may contain [[ref:<token>]] markers
       generated: boolean,                   // false = degraded, always paired with degradedReason
       degradedReason: Option<DegradedReason> // 'not_configured' | 'disabled' | 'provider_error'
                                             //  | 'too_many_steps' | 'empty_answer'
       references: ReadonlyArray<EntityRef>  // each carries its own `token`; markers resolve
                                             //  to that entry's position in this array
     }
  errors: AiChatForbidden (403), AiChatRateLimited (429, carries retryAfterSeconds)
```

No streaming. No `usedTools`. `EntityRef` is a five-way discriminated union on `kind` — §3.2 states
exactly what each variant must carry, derived from the card anatomy in §3.4. `degradedReason` is a
**closed union of five machine-readable tokens**; the client turns it into copy (§2.5). It is present
exactly when `generated === false`.

**Reference markers are opaque per-turn tokens**, not indices: `[[ref:7f3a]]`, four characters from a
random alphabet, resolved server-side through a `Map<token, position>` that is rebuilt every turn.
Indices were rejected because a marker emitted in turn *n* survives into the assistant message the
client sends back as history, and would re-resolve against turn *n+1*'s `references` array — linking
to the wrong entity. A token from a previous turn simply does not exist in the current map.

**Security property this design leans on:** the server builds `references` only from entities its
tools actually returned, and strips any marker it cannot resolve — collapsing the surrounding
whitespace as it does so, so the client never has to. A marker that survives to the client is
therefore always resolvable. The parser still degrades gracefully if one is not (§3.3).

## Baseline facts (verified in the repo, not assumed)

- The app shell is `SidebarProvider` + `AppSidebar` (`collapsible='icon'`) + `SidebarInset`, with a
  sticky `h-16` header holding `SidebarTrigger` + breadcrumbs, and `<Outlet />` inside
  `div.flex.flex-1.flex-col.gap-4.p-4.pt-0` (`components/layouts/AuthenticatedLayout.tsx`).
- On mobile (`< 768px`, `useIsMobile`) the sidebar itself becomes a Radix `Sheet`. There is no
  second rail, no right-hand dock, no persistent overlay surface anywhere in the app.
- Available Shadcn primitives: `alert` (variants `default` / `destructive` / `warning`),
  `alert-dialog`, `avatar`, `badge` (variants `default` / `secondary` / `destructive` / `outline` /
  `success`, plus an exported `badgeVariants`), `breadcrumb`, `button`, `calendar`, `card`,
  `checkbox`, `date-picker`, `dialog`, `dropdown-menu`, `form`, `input`, `label`, `popover`,
  `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `switch`, `textarea`,
  `toggle`, `toggle-group`, `tooltip`.
  **There is no `command`/cmdk, no `tabs`, no `scroll-area`, and no markdown renderer in
  `package.json`.** Nothing in this spec requires installing one.
- All user-facing strings go through `tr('key')` from `~/lib/translations.js`. Importing
  `@sideline/i18n/messages` from web code fails lint. `tr()` on an unknown key does **not** throw —
  it `console.warn`s and returns the raw key (`lib/staticTrKeys.test.ts` exists precisely because of
  that failure mode), which is why §7 bans computed key names.
- Organisms may call `useRun()` but must not use TanStack Router hooks. Importing `<Link>` into an
  organism or molecule is allowed.
- Toasts are Sonner, mounted once at `top-right` with `richColors closeButton` in `RootDocument`.

---

## 1. Where the assistant lives

### Recommendation: a dedicated team-scoped route — `/teams/$teamId/assistant`

Not a persistent side panel, not a floating launcher + drawer. One route, reached from the sidebar
like every other feature.

**Why, against this specific shell:**

1. **There is no room for a persistent panel and no precedent for one.** `SidebarInset` owns the
   full remaining width and its width math is driven by the sidebar's `--sidebar-width` CSS vars. A
   second permanent rail would need new width vars, a second collapse state, and a second mobile
   behaviour — and below 768px it cannot exist at all, so the panel design would have to degrade
   into a drawer anyway. Designing the drawer first and the panel second is strictly more work for
   the same result.
2. **A floating launcher fights the surfaces that are already there.** Sonner sits top-right; the
   `PwaInstallPrompt` sits directly under the header; the mobile sidebar is a full-height `Sheet`
   with its own overlay. A bottom-right FAB plus a third overlay layer is the one thing in this app
   that would be pure new chrome, and on mobile it would cover the primary content of every list
   page. Nothing in the codebase renders a persistent floating control today.
3. **The assistant is a destination, not an inspector.** Its job is "answer a question about the
   whole team". That is not scoped to the page you happen to be on, and the result cards in §3 —
   avatar + roles, colour-coded event rows — want width, not a `sm:max-w-sm` (24rem) sheet.
4. **A route gets deep-linking, back/forward, breadcrumbs, refresh-survival and a loader for free**,
   all of which already work here. `useBreadcrumbs` keys off route ids; the sidebar keys off
   `useMatchRoute`. A panel or drawer gets none of that without inventing a URL scheme.
5. **Nothing is lost later.** `AssistantConversation` (§6) is an organism with no router hooks, so
   the identical organism can be dropped into a `Sheet` in a follow-up slice if usage data shows
   people want it on top of the events page. Shipping the route first does not close that door;
   shipping the drawer first forces the route to be rebuilt.

**Explicit non-goal for this slice:** a global launcher/hotkey. `Ctrl/Cmd+B` is already taken by
`SIDEBAR_KEYBOARD_SHORTCUT` in `components/ui/sidebar.tsx`; adding a second global chord without a
launcher UI to discover it is not worth it yet.

### Exact files

| File | Change |
|---|---|
| `applications/web/src/routes/(authenticated)/teams/$teamId/assistant.tsx` | **New.** Flat route file (no sub-routes, so no `.index.tsx` — same shape as `notifications.tsx` / `settings.tsx`). `ssr: false`. Loader returns `{ enabled }`. |
| `applications/web/src/components/pages/AssistantPage.tsx` | **New.** Page component, props only, no `Route.use*()`. |
| `applications/web/src/components/organisms/assistant/AssistantConversation.tsx` | **New.** |
| `applications/web/src/components/organisms/assistant/AssistantComposer.tsx` | **New.** |
| `applications/web/src/components/molecules/assistant/*.tsx` | **New.** Six molecules, §6. |
| `applications/web/src/components/atoms/AssistantEntityLink.tsx` | **New.** |
| `applications/web/src/lib/assistant/entityRoutes.ts` (+ `.test.ts`) | **New.** Pure route table. |
| `applications/web/src/lib/assistant/parseAnswer.ts` (+ `.test.ts`) | **New.** Pure parser. |
| `applications/web/src/lib/assistant/history.ts` (+ `.test.ts`) | **New.** Pure history budgeting. |
| `applications/web/src/hooks/useRetryCooldown.ts` | **New.** 429 retry window ticker. |
| `applications/web/src/components/layouts/AppSidebar.tsx` | **Edit.** Add nav item. |
| `applications/web/src/components/layouts/AuthenticatedLayout.tsx` | **Edit.** Add breadcrumb branch. |
| `packages/i18n/messages/en.json`, `cs.json` | **Edit.** Keys in §7. |

**Sidebar placement** — last item of the `team` group in `getTeamNavGroups`, next to the `rules`
entry, icon `Sparkles` (lucide, not yet used anywhere in the app so it reads as "the new thing"):

```ts
{ title: tr('assistant_navTitle'), icon: Sparkles, to: '/teams/$teamId/assistant', params: { teamId } }
```

No `requiredPermission` — every member may ask; the server decides what they may see. This mirrors
the comment already sitting on the `rules` nav item.

**The nav item does not depend on `enabled`.** `getTeamNavGroups` builds from `activeTeam`
(permissions only) and has no AI capability data; fetching capabilities for the sidebar would add a
request to every page in the app. The nav entry is always present and the *page* explains itself
when the assistant is off (§2.1). That is the right trade: a nav item that silently disappears
per-team is more confusing than a page that says why it is unavailable.

**Breadcrumb** — in `useBreadcrumbs`, inside the `/teams/$teamId/` branch, before the `/members`
case:

```ts
} else if (routeId.includes('/assistant')) {
  crumbs.push({ label: tr('assistant_navTitle'), to: pathname });
}
```

### Route file shape

```tsx
export const Route = createFileRoute('/(authenticated)/teams/$teamId/assistant')({
  ssr: false,
  component: AssistantRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.ai.getCapabilities({ params: { teamId } })),
      // Deliberately NOT `warnAndCatchAll`: that maps any failure to `NotFound`, and a 404 page
      // for a transient capabilities blip is a worse answer than the disabled state, whose copy
      // ("not available right now") is true in both cases.
      Effect.tapError((e) => Effect.logWarning('assistant capabilities failed', e)),
      Effect.catch(() => Effect.succeed({ enabled: false })),
      context.run,
    );
  },
});

function AssistantRoute() {
  const { teamId } = Route.useParams();
  const { enabled } = Route.useLoaderData();
  return <AssistantPage teamId={teamId} enabled={enabled} />;
}
```

There is no `onRefresh`. Nothing here mutates server state, so no other route's loader can go stale
because of this page. (The follow-up write PR reinstates it — §9.)

**Conversation persistence:** out of scope. The transcript is client state inside
`AssistantConversation` and is lost on navigation away. Two consequences the design carries: a
visible **New chat** control so the reset is deliberate rather than accidental, and a client-side
history budget (§2.6) so a long transcript degrades predictably instead of silently.

---

## 2. Chat surface

### 2.1 Page layout and the disabled state

`AssistantPage` renders inside the layout's `p-4 pt-0` flex column, so it can claim the remaining
viewport height:

```
<div className='flex flex-1 min-h-0 flex-col gap-4'>
  ├── header row (shrink-0)
  │     ├── <h1 className='text-2xl font-bold'>{tr('assistant_navTitle')}</h1>   ← matches GroupsListPage
  │     ├── <p className='text-sm text-muted-foreground hidden sm:block'>{tr('assistant_pageSubtitle')}</p>
  │     └── right: New chat button (ghost, RotateCcw icon) — only when turns.length > 0
  ├── message log      (flex-1 min-h-0 overflow-y-auto)
  └── composer         (shrink-0, sticky bottom of the column)
```

Content column: `mx-auto w-full max-w-3xl` on the log and composer both, so long answers do not run
to 1600px on a desktop monitor while the surrounding page chrome stays full-bleed.

**When `enabled === false`** the page renders the `h1` and then the disabled state *instead of* the
log and composer — no empty state, no suggestions, no textarea. Offering a disabled input box is
worse than offering none: it looks broken and invites a click that does nothing. This is ~6 lines of
static JSX taking no props, so it is **inlined into `AssistantPage`**, not componentised:

```tsx
<div className='flex flex-1 flex-col items-center justify-center gap-3 text-center'>
  <Sparkles className='size-8 text-muted-foreground' aria-hidden='true' />
  <h2 className='text-lg font-semibold'>{tr('assistant_disabled_title')}</h2>
  <p className='max-w-md text-sm text-muted-foreground'>{tr('assistant_disabled_body')}</p>
</div>
```

Copy is deliberately cause-agnostic ("The assistant isn't available for this team right now. Your
team admin can tell you more.") because `{ enabled: false }` collapses three server-side causes —
AI switched off, no LLM configured, and (per the loader above) a failed capabilities call. Naming a
cause we cannot distinguish would be a lie a third of the time. No retry button: the user has
nothing to retry, and page reload is the universal gesture that already works.

This is a **page-level** state. It is not the same thing as `generated: false` (§2.5), which is a
per-turn state on a page that is otherwise fully working.

### 2.2 Message list

The log is the single container for every turn:

```tsx
<div
  role='log'
  aria-live='polite'
  aria-relevant='additions text'
  aria-label={tr('assistant_logLabel')}
  className='flex-1 min-h-0 overflow-y-auto'
>
  <ol className='mx-auto flex w-full max-w-3xl flex-col gap-6 py-4'>…</ol>
</div>
```

**User turn** — right-aligned bubble, because the asymmetry is what makes a transcript scannable:

```
<li className='flex justify-end'>
  <div className='max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm
                  text-primary-foreground sm:max-w-[75%] whitespace-pre-wrap break-words'>
```

Preceded by an `sr-only` `{tr('assistant_youLabel')}` so a screen reader knows who spoke. No visible
label, no avatar — alignment and colour carry it for sighted users, the sr-only text for AT.

**Assistant turn** — left-aligned, **no bubble**, full column width:

```
<li className='flex flex-col gap-3'>
  ├── speaker row: <Sparkles className='size-4 text-primary' aria-hidden />
  │                <span className='text-xs font-medium'>{tr('assistant_assistantLabel')}</span>
  │                <span className='text-xs text-muted-foreground'>{formatRelative(turn.at)}</span>
  ├── degraded <Alert> (inline)    ← only when generated === false; copy from degradedReason (§2.5)
  ├── <AssistantAnswer …/>         ← prose + inline entity links; skipped when answer is empty
  └── <AssistantResultList …/>     ← optional, the uncited references as cards
```

The no-bubble treatment is load-bearing, not stylistic: result rows must be able to sit at full
width. Nesting a bordered row inside a coloured bubble looks broken and wastes ~48px of horizontal
room on a phone.

Timestamps use `useFormatDate().formatRelative` ("2 minutes ago"), `text-xs text-muted-foreground`.

**Auto-scroll: unconditional.** On every new turn, scroll the log to the newest one — a bottom
sentinel `<div>` plus `scrollIntoView` in an effect keyed on `turns.length`. Scroll behaviour is
`prefers-reduced-motion: reduce ? 'auto' : 'smooth'`.

A scroll-position guard ("only auto-scroll when the user is already near the bottom", with a
*Jump to latest* pill when they are not) is **deliberately cut**. It is the only stateful scroll
machinery the slice would contain — a scroll listener, a derived `isNearBottom` state, a floating
button, its mobile positioning and one translation key — and it only pays off in a transcript long
enough to scroll *while a request is in flight*, which a non-persisted conversation rarely reaches.
Ship without it; add it on the first complaint, where the shape above is the one to build.

### 2.3 Empty state

Shown when `turns.length === 0` and `enabled === true`. Centred in the log area:

```
<Sparkles className='size-8 text-muted-foreground' aria-hidden />
<h2 className='text-lg font-semibold'>{tr('assistant_empty_title')}</h2>
<p className='max-w-md text-center text-sm text-muted-foreground'>{tr('assistant_empty_body')}</p>
<p className='text-xs font-medium text-muted-foreground'>{tr('assistant_empty_suggestionsLabel')}</p>
<div className='grid w-full max-w-xl gap-2 sm:grid-cols-2'>
  … 4 × <Button variant='outline' className='h-auto justify-start whitespace-normal py-3 text-left text-sm'>
```

Four suggestions, **all read-only**, one per query shape the tools support:

1. `assistant_suggestion_rsvp` — "Who hasn't answered the RSVP for Thursday's training?" (filtered read)
2. `assistant_suggestion_filter` — "Which players in the U20 group are missing a jersey number?" (filtered read)
3. `assistant_suggestion_attendance` — "Show me the attendance for the last four trainings" (list read)
4. `assistant_suggestion_aggregate` — "How many trainings did we have last month?" (aggregate read)

There is no permission-dependent swap: every member can run every one of these, so the set is fixed
for everyone. (Suggestion #2 in the previous revision described a *create*; it is gone with the
write path.)

Clicking a suggestion **fills the composer and focuses it** — it does not send. The user sees what
they are about to ask, and can edit "Thursday" to the day they actually meant.

### 2.4 Loading / thinking indicator

No streaming. One request, one response. While in flight, a pending assistant turn is appended:

```tsx
<li role='status' className='flex items-center gap-2 text-sm text-muted-foreground'>
  <Loader2 className='size-4 animate-spin' aria-hidden='true' />
  {tr('assistant_thinking')}
</li>
```

Same shape as the existing `members_ratingSuggesting` indicator in `RatingFromDescription.tsx`.
Four lines of static JSX with no props — **inlined into `AssistantConversation`**, not a component.
The
user's own message is appended optimistically **before** the request goes out, so the transcript
never appears to swallow input. The composer is disabled while submitting and its send button swaps
to the spinner. No cancel button — the app has no request-abort pattern in organisms and inventing
one for this slice is out of proportion; the server's agent loop is bounded and never hangs
indefinitely.

### 2.5 The degraded turn — `generated: false` + `degradedReason`

`generated: false` is a **normal 200**. The assistant replied, but not with the model. The wire says
*why* in a separate, machine-readable field: `degradedReason` is a closed union of five tokens, and
it is present on exactly the paths where `generated` is `false`.

| `degradedReason` | What happened | Copy key |
|---|---|---|
| `not_configured` | No LLM credentials for this deployment | `assistant_degraded_notConfigured` |
| `disabled` | AI switched off for this team server-side | `assistant_degraded_disabled` |
| `provider_error` | The provider call failed mid-turn | `assistant_degraded_providerError` |
| `too_many_steps` | The agent loop hit its step cap before answering | `assistant_degraded_tooManySteps` |
| `empty_answer` | The model returned nothing usable | `assistant_degraded_emptyAnswer` |

It is rendered as an ordinary assistant turn whose body is replaced by a muted notice, so the
transcript stays chronologically honest — the question is still there, and so is the fact that it
did not get a real answer:

```tsx
<Alert>                                        {/* default variant — informational, not an error */}
  <Info className='size-4' aria-hidden='true' />
  <AlertTitle>{tr('assistant_degraded_title')}</AlertTitle>
  <AlertDescription>{degradedReasonLabels[reason]()}</AlertDescription>
</Alert>
```

That is ~6 lines of static JSX over one prop, so it is **inlined into the assistant-turn branch of
`AssistantConversation`**, not componentised.

Design rules for this state:

- **Resolve the reason through an explicit lookup, never a computed key.** `degradedReasonLabels` is
  a `Record<DegradedReason, () => string>` living beside `entityKindLabels` (§7), the same idiom as
  `event-labels.ts`. `` tr(`assistant_degraded_${reason}`) `` is exactly what
  `lib/staticTrKeys.test.ts` exists to catch, and `tr()` on a missing key prints the raw key to the
  user rather than throwing — the wire tokens are `snake_case` and the key names are not, so a
  template literal would be wrong on every branch anyway.

  ```ts
  export const degradedReasonLabels: Record<DegradedReason, () => string> = {
    not_configured: () => tr('assistant_degraded_notConfigured'),
    disabled:       () => tr('assistant_degraded_disabled'),
    provider_error: () => tr('assistant_degraded_providerError'),
    too_many_steps: () => tr('assistant_degraded_tooManySteps'),
    empty_answer:   () => tr('assistant_degraded_emptyAnswer'),
  };
  ```

- **`answer` is never a sentinel and is never suppressed.** The server no longer writes a fixed
  placeholder sentence into `answer` on degraded paths — the reason lives in `degradedReason` and the
  copy lives on the client (P2, §3.1). Whatever `answer` *does* carry is genuine tool-derived content,
  so it is rendered below the alert in the normal prose slot exactly as on a healthy turn, markers and
  all. When it is empty, only the alert shows. (The previous revision rendered `answer` unconditionally
  below the alert *and* accepted that it might be a server sentence whose locale we could not verify;
  with `degradedReason` that compromise is gone.)
- **It is not styled as an error.** `variant='default'`, not `destructive`. Nothing failed from the
  user's point of view — the feature is temporarily not thinking. Destructive-red for a 200 trains
  people to ignore red.
- **`references` are still rendered** if present, by the same §3 pipeline. Cards are built from
  typed data and are correct regardless of who wrote the prose. `too_many_steps` in particular is the
  case where tools ran and returned real entities before the loop was cut short.
- **No retry button**, on any reason. Two of the five (`not_configured`, `disabled`) can never
  succeed on a retry, and the composer stays enabled, so asking again is one keystroke away for the
  three that can. The per-reason copy is what tells them which situation they are in — that is the
  whole point of splitting the message five ways.
- **Distinguished from `enabled: false`** (§2.1) by placement: `enabled: false` replaces the whole
  page surface and never shows a composer; `generated: false` is one turn inside a working page.
  `degradedReason: 'disabled'` is the mid-session version of the same server state — the page was
  loaded while AI was on and it was switched off underneath — and its copy says so.

### 2.6 History budgeting — the truncation the server would otherwise do silently

The server caps client-supplied history at **8000 characters**, dropping whole messages oldest-first.
Nothing on the wire reports that it happened, so a long session would silently start losing its
earliest context with no user-visible cause.

**Decision: the client truncates first, and says so.** `lib/assistant/history.ts` (pure, tested):

```ts
export const HISTORY_CHAR_BUDGET = 8000;   // must equal the server's ChatAgent budget
export const HISTORY_MAX_MESSAGES = 20;    // wire schema cap

export const buildHistory = (
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): { messages: ReadonlyArray<ChatMessage>; droppedCount: number };
```

It keeps the newest messages that fit both caps, drops whole messages from the front, and reports how
many it dropped. Because the request is already inside the budget, the server's own truncation is a
no-op and the two rules can never disagree about *what* was sent. If the server later lowers its
budget, the worst case is that the client is briefly less strict than the server — the same silent
behaviour as today, not a regression.

When `droppedCount > 0`, a subtle divider is rendered in the log **above the oldest included turn**
(rendered inline by `AssistantConversation`, it is one line and does not earn a component):

```tsx
<li className='flex items-center gap-2 text-xs text-muted-foreground' role='note'>
  <Separator className='flex-1' /> {tr('assistant_historyTrimmed')} <Separator className='flex-1' />
</li>
```

Copy: "Earlier messages aren't included in what the assistant sees." — stated as a fact about the
assistant's view, not as an error, and positioned exactly where the cut is so its meaning is
self-evident. It moves down the log as the conversation grows. The older turns stay visible and
readable; only their inclusion in the request changes.

### 2.7 Error state

There are exactly **two** error tags on this endpoint, plus transport failures. `AssistantTimeout`
does not exist — the server's agent never fails, it degrades to `generated: false` with a 200 (§2.5)
— and `ProposalConflict` is gone with the write path.

Failures render **inline, in place of the assistant answer**, not only as a toast. Build the Effect
with `SilentClientError` (`lib/runtime.ts`) so `useRun`'s automatic `toast.error` is suppressed and
the transcript is the single place the failure is reported:

```tsx
<Alert variant='destructive'>
  <OctagonX className='size-4' aria-hidden='true' />
  <AlertTitle>{tr('assistant_turnFailedTitle')}</AlertTitle>
  <AlertDescription>
    {message}
    {retry !== null && (
      <Button size='sm' variant='outline' onClick={onRetry} disabled={retry.secondsLeft > 0}>
        <RotateCcw className='size-4' aria-hidden='true' />
        {retry.secondsLeft > 0 ? tr('assistant_turnFailedRetryIn', { seconds: retry.secondsLeft })
                               : tr('common_retry')}
      </Button>
    )}
  </AlertDescription>
</Alert>
```

`onRetry` resends the *same* user message and replaces the failed turn in place; it does not append
a duplicate user bubble.

| Server tag / cause | Key | Recovery offered |
|---|---|---|
| `AiChatRateLimited` (429) | `assistant_turnFailedRateLimited` | Retry, **disabled for `retryAfterSeconds`**, button label counts down via `useRetryCooldown(retryAfterSeconds)` |
| `AiChatForbidden` (403) | `assistant_turnFailedForbidden` | **No retry button.** Retrying an authorization failure cannot succeed; offering the button is a dead click. |
| transport / 5xx / decode | `assistant_turnFailedGeneric` | Retry, immediately |

`useRetryCooldown(seconds)` is a ~15-line hook: 1s interval, clears on unmount, stops at 0. It is the
only timer in this slice.

### 2.8 Input composer

React Hook Form + `effectTsResolver`, per the mandatory forms rule in `applications/web/AGENTS.md`
(the only sanctioned exception is `useCardForm`, which does not apply here).

```ts
const MAX = 2000;   // matches the wire's per-message cap exactly

const ComposerSchema = Schema.Struct({
  message: Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) => (s.trim().length > 0 ? true : tr('validation_required'))),
      Schema.makeFilter<string>((s) =>
        s.length <= MAX ? true : tr('assistant_composer_tooLong', { max: MAX }),
      ),
    ),
  ),
});
```

Anatomy — a bordered rounded container so it reads as one control, not two:

```
<form className='mx-auto w-full max-w-3xl'>
  <div className='flex items-end gap-2 rounded-xl border bg-background p-2
                  focus-within:ring-[3px] focus-within:ring-ring/50'>
    ├── <Textarea rows={1} className='min-h-0 max-h-40 resize-none border-0 shadow-none
    │              focus-visible:ring-0 overflow-y-auto' />
    └── <Button type='submit' size='icon' disabled={…}>
          <SendHorizontal aria-hidden /> <span className='sr-only'>{tr('assistant_composer_send')}</span>
  </div>
  <div className='flex items-center justify-between gap-2 px-1 pt-1'>
    ├── <p className='text-xs text-muted-foreground'>{hint}</p>
    └── counter (only at ≥ 80% of MAX, i.e. from 1600 chars)
  </div>
</form>
```

Decisions:

- **Multiline: yes.** `Textarea` already carries `field-sizing-content` in its base class, so it
  auto-grows with no JS. Cap at `max-h-40` (~6 lines) then scroll.
- **Enter submits on pointer devices; Shift+Enter inserts a newline.** On touch
  (`useIsMobile() === true`) Enter always inserts a newline and only the send button submits — the
  soft-keyboard return key is the newline key there, and hijacking it sends half-typed messages.
  The hint line states the active behaviour: `assistant_composer_hintDesktop` vs
  `assistant_composer_hintMobile`.
- **Character limit: 2000**, enforced by the schema **and** by `maxLength={MAX}` on the textarea, so
  the client can never build a request the wire schema would reject. The counter is hidden below
  1600 chars (pure noise) and appears as `tr('members_ratingDescCounter', { count, max: MAX })` — an
  existing key with exactly this value — in an `aria-live='polite'` element, copying
  `RatingFromDescription.tsx`. At 100% the counter turns `text-destructive` **and** the send button
  disables **and** `FormMessage` renders the error text (three channels, per the no-colour-alone
  rule).
- **Send is disabled** when the trimmed value is empty, when submitting, or when over the limit. A
  disabled send button with no explanation is the same defect as a dead click, so the hint line
  swaps to the reason.
- After a successful submit: `form.reset({ message: '' })` and refocus the textarea.
- `aria-describedby` on the textarea points at the hint and the counter.

### 2.9 Effect pattern — Pattern A (and it must match the plan)

Both Pattern A (organism builds and runs its own Effect) and Pattern B (Effect-as-prop) are
sanctioned at `applications/web/AGENTS.md:765-812`. **This design specifies Pattern A.**

Why A, specifically for the read-only slice: Pattern B exists for the case where "the parent owns
the API context (route params, router invalidation) but the child owns the UI state". With writes
cut there is **no router invalidation** — nothing this page does can stale another loader — so the
only thing the parent would contribute is `teamId`, which is already a plain prop the organism can
brand with `Schema.decodeSync(Team.TeamId)` itself. Pattern B here would add an indirection that
buys nothing, and it would couple the organism to a page wrapper, which is exactly what §1's
"drop it into a `Sheet` later" argument wants to avoid.

The implementation plan specifies Pattern A as well — the two documents agree, and `AssistantPage`
stays a props-only shell. When the write PR lands and `router.invalidate()` returns, revisiting B is
reasonable.

---

## 3. Search result rendering — the centrepiece

This is where the value of the feature lives. The prose is a summary; **the cards are the answer.**

### 3.1 Two principles that constrain everything below

**P1 — The card is the contract.** The model controls every character of `answer`. An injected
instruction in an event description or a member's display name can make the prose narrate something
that did not happen. Result cards therefore render **only** server-held typed data from
`references`, passed through the app's existing helpers. A card never renders model prose, never
takes a label the model wrote, and never derives a route from anything the model emitted. The
model's only influence over a card is *which* entity is in the list — and the server already
guarantees every entry is an entity its own tools returned for this caller. If the prose and the
cards disagree, the cards are right, and the user is one click from the real page.

**P2 — No localized text crosses the wire.** `packages/domain` depends only on `effect` and
`@sideline/effect-lib` (enforced by `pnpm lint`), so it cannot import the message catalogue. Every
variant in §3.2 carries **raw typed data**; every human-readable string in a card is produced on the
client by `tr()` or an existing label map. Concretely, none of these may come from the server:
status text, event-type names, role names rendered as labels, "N members", relative dates, "Team-wide",
"Active"/"Inactive", or any separator/format string.

### 3.2 `EntityRef` — the five variants, and exactly what each must carry

`EntityRef` is a discriminated union on `kind`. The architect owns the `Schema` definitions; this
section states the **field → consumer** mapping the UI requires, so the wire can be derived from it
without guesswork. Every `Option`-typed field below is `Schema.OptionFromNullOr` unless noted.

**One field is common to all five variants: `token: string`** — the opaque per-turn marker id from
the wire contract. It is what lets the client resolve `[[ref:7f3a]]` to a position without the server
sending a second lookup structure: `new Map(references.map((r, i) => [r.token, i]))`, built once per
turn inside `AssistantAnswer` with `React.useMemo` and handed to `parseAnswer` (§3.3). It is never
displayed and never routed on.

The five kinds are **`event | member | group | roster | trainingType`** and nothing else. There is no
activity-type variant: `list_activity_types` is cut from this PR, so no reference can ever carry that
kind and no card renders it.

**Strong recommendation: reuse the existing list projections verbatim** rather than minting bespoke
structs. Each is already the exact "row" shape the web renders today, already has decoders, and
already gets the `Option` handling right. Where a projection carries one or two fields a card does not
need, carrying them is cheaper than maintaining a parallel shape that drifts.

| Variant | Recommended payload | Existing projection |
|---|---|---|
| `event` | `EventApi.EventInfo` | `packages/domain/src/api/EventApi.ts:107` |
| `member` | **bespoke struct** — see below, *not* `RosterPlayer` | (`packages/domain/src/api/Roster.ts:34`, for reference only) |
| `group` | `GroupApi.GroupInfo` | `packages/domain/src/api/GroupApi.ts:12` |
| `roster` | `Roster.RosterInfo` | `packages/domain/src/api/Roster.ts:88` |
| `trainingType` | `TrainingTypeApi.TrainingTypeInfo` | `packages/domain/src/api/TrainingTypeApi.ts:9` |

`member` is the one exception to that recommendation, and it is a hard one: `Roster.RosterPlayer`
carries `discordId`, `userId`, `username`, `birthDate`, `gender` and `permissions`, **none of which
may reach the client through the assistant**. The member variant is an explicit projection of the
fields the card consumes and nothing more.

#### `kind: 'event'`

| Field | Type | Consumed by |
|---|---|---|
| `eventId` | `Event.EventId` | route param `eventId` |
| `title` | `string` | primary line |
| `eventType` | `Event.EventType` | `getEventColor(eventType, trainingTypeName, colorMap)` → leading colour bar; `eventTypeLabels[eventType]()` → secondary line |
| `trainingTypeName` | `Option<string>` | 2nd arg of `getEventColor`; also seeds `buildTrainingTypeColorMap` |
| `startAt` | `DateTime.Utc` (`Schemas.DateTimeFromIsoString`) | `formatEventDateRange` arg 1 |
| `endAt` | `Option<DateTime.Utc>` | `formatEventDateRange` arg 2 |
| `allDay` | `boolean` | `formatEventDateRange` arg 3; drives the `event_allDayLabel` chip |
| `startDate` | `Option<string>` (`OptionFromOptionalKey`, `YYYY-MM-DD`) | `formatEventDateRange` arg 4 — the server-derived **team-local** date |
| `endDate` | `Option<string>` (`OptionFromOptionalKey`) | `formatEventDateRange` arg 5 |
| `location` | `Option<string>` | secondary line tail |
| `status` | `Event.EventStatus` | `eventStatusLabels[status]()` + `eventStatusClasses[status]` |

`startDate`/`endDate` must be `OptionFromOptionalKey`, not a defaulted string — the reason is
documented on `EventInfo.startDate` and the all-day branch of `formatEventDateRange` depends on it.
Omitting them is not an option: without the team-local dates, all-day events render on the wrong day
for anyone whose browser is not in the team's timezone.

**Colour map note (verified):** `getEventColor` needs a `TrainingTypeColorMap`, and
`buildTrainingTypeColorMap` assigns each name a palette slot by `hashString(name) % 8` —
**independent of which other names are in the map**. Building the map from only the training-type
names present in this response therefore yields byte-identical colours to the events page. Build it
once per assistant turn with `React.useMemo` over the turn's event references; do not fetch the
team's training types to construct it.

#### `kind: 'member'`

| Field | Type | Consumed by |
|---|---|---|
| `memberId` | `TeamMemberId` | route param `memberId` |
| `displayName` | `string` | primary line; `AvatarFallback` initials (`.slice(0,2).toUpperCase()`) |
| `avatarUrl` | `Option<string>` | `AvatarImage src`; `None` → fallback initials only |
| `jerseyNumber` | `Option<number>` | secondary line `#12` |
| `roleNames` | `ReadonlyArray<string>` | `resolveEffectiveRoles({ roleNames, effectiveRoles })` |
| `effectiveRoles` | `ReadonlyArray<EffectiveRole>` with `withDecodingDefaultKey(() => [])` | same; carries `roleId`, `name`, `isBuiltIn`, `source`, `groupNames` |
| `active` | `boolean` | `false` → muted `Badge variant='outline'` with `roster_inactive` |

`roleNames` **and** `effectiveRoles` are both required: `resolveEffectiveRoles` takes the pair and
falls back to `roleNames` when `effectiveRoles` is empty. Role `name`s are team-authored catalogue
strings already rendered raw by `RoleBadge` — they are data, not localized text, so P2 holds.

**`avatarUrl` is built server-side and `discordId` never crosses the wire.** The client does not
assemble `https://cdn.discordapp.com/avatars/{discordId}/{hash}.png?size=32` itself, because doing so
requires shipping the member's Discord snowflake to the browser for every search hit — an identifier
the assistant has no reason to expose and which the rest of the app's read paths do not hand out for
arbitrary members. The server composes the finished URL (or `None`) and the card renders it verbatim.
A URL is not localized text, so P2 is untouched.

The web must **never** re-derive a display name from `name`/`username`; `displayName` is the resolved
value (profile name → Discord nickname → Discord display name → username) and is the only one that is
sent at all.

#### `kind: 'group'`

| Field | Type | Consumed by |
|---|---|---|
| `groupId` | `GroupId` | route param `groupId` |
| `name` | `string` | primary line |
| `emoji` | `Option<string>` | prefix on the primary line — `` `${emoji} ${name}` ``, the `GroupsListPage.tsx:93` idiom |
| `color` | `Option<HexColor>` | `<ColorDot color={…} />` in the trailing slot |
| `memberCount` | `number` | secondary line via `tr('group_memberCount', { count })` |

#### `kind: 'roster'`

| Field | Type | Consumed by |
|---|---|---|
| `rosterId` | `RosterId` | route param `rosterId` |
| `name` | `string` | primary line |
| `emoji` | `Option<string>` | primary-line prefix (`RostersListPage.tsx:196`) |
| `color` | `Option<HexColor>` | `<ColorDot>` in the trailing slot |
| `memberCount` | `number` | `tr('roster_memberCount', { count })` |
| `active` | `boolean` | `tr('roster_active')` / `tr('roster_inactive')` badge |

A roster has **no linked event** (that relationship lives in `EventRosterModel`); the previous
revision's "linked event title" was wrong and is removed.

#### `kind: 'trainingType'`

| Field | Type | Consumed by |
|---|---|---|
| `trainingTypeId` | `TrainingTypeId` | route param `trainingTypeId` |
| `name` | `string` | primary line |
| `ownerGroupName` | `Option<string>` | secondary, `Option.getOrElse(() => tr('trainingType_noGroup'))` |
| `memberGroupName` | `Option<string>` | secondary, same fallback, joined with `' / '` — the `TrainingTypesListPage.tsx:202-207` idiom |

A training type has **no duration and no description** in the domain; the previous revision's
"duration / one-line description" was invented and is removed.

### 3.3 The answer parser

`lib/assistant/parseAnswer.ts` — pure, no React, no `tr()`, no `ApiClient`, co-located Vitest test.

```ts
type AnswerSegment = { kind: 'text'; text: string } | { kind: 'ref'; index: number };
export const parseAnswer = (
  text: string,
  tokens: ReadonlyMap<string, number>,   // token -> position, from `references` (§3.2), per turn
): { paragraphs: ReadonlyArray<ReadonlyArray<AnswerSegment>>; cited: ReadonlySet<number> };
```

Grammar and rules:

- Marker: `/\[\[ref:([A-Za-z0-9]+)\]\]/g`. The capture is an **opaque token**, not a number and
  not an index — 4 characters from a random alphabet, minted per turn. The client's only job is to
  look it up in the turn's `tokens` map and get a position in `references`.
- **The token map is per-turn and is never carried forward.** It is derived from the response the
  same render produces the turn from, so a token that leaked into client-held history and came back
  in a later `answer` resolves to nothing and is dropped — the exact failure the token scheme exists
  to prevent, and the reason the parser takes a map rather than a `referenceCount`.
- Paragraphs split on `\n\n`; single `\n` is preserved inside a paragraph (`whitespace-pre-wrap`).
- **An unresolvable token → the marker is removed**, not printed. The user must never see
  `[[ref:7f3a]]`. This cannot happen in practice: the server strips markers it cannot resolve
  *before* sending, and collapses `\s*[[ref:…]]\s*` to a single space and trims when it does, so
  `parseAnswer` never receives one and owns no whitespace-repair rule of its own. The parser is
  defensive because the cost is two lines and the failure mode is user-visible garbage.
- Text that merely resembles a marker (`[[ref:]]`, `[[ref:a-b]]`, `[[ ref:7f3a ]]`) does not match the
  grammar and is rendered verbatim as text. No escaping, no unescaping.
- `cited` is the set of **positions** the resolved tokens pointed at — §3.5 uses it to decide what
  becomes a card. Two tokens resolving to the same position collapse to one entry, which is what the
  "cited references are not repeated as cards" rule wants.
- There is no index-alignment fixture to maintain any more. The previous revision needed a shared
  0-based/1-based test against the server's marker emitter; with opaque tokens there is no ordinal to
  agree on, and a mismatch degrades to a dropped marker instead of a link to the wrong entity. The
  parser's tests cover the grammar and the drop-on-miss path only.

**No markdown.** There is no markdown dependency in the web app; adding one to render model output is
a meaningful XSS-and-complexity surface for zero product value here. Prose is rendered as text nodes
inside `whitespace-pre-wrap break-words`, which is inherently injection-proof in React.

### 3.4 Card anatomy

Compact **rows**, not big cards — modelled on `PlayerCard.tsx` (`h-12 w-full rounded-md border px-2`),
the app's existing compact-entity idiom. The whole row is one `<Link>`: one tab stop, one large hit
target, `Enter` navigates. Hover `hover:bg-accent hover:border-accent-foreground/20`; focus copies
`PlayerCard`'s selectable branch (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1`).

Every kind shares one skeleton, implemented once in `AssistantResultRow`:

```
[ leading 32px ] [ primary   (truncate, text-sm font-medium leading-tight) ] ....... [ trailing ]
                 [ secondary (truncate, text-xs muted leading-tight)       ]
```

`min-w-0` on the text column and `shrink-0` on leading/trailing — without both, a long event title
pushes the status badge off the row instead of truncating.

| Kind | Leading | Primary | Secondary | Trailing |
|---|---|---|---|---|
| `event` | `Calendar` icon on a `w-1 self-stretch rounded-full` colour bar whose class comes from `getEventColor(...).dot` | `title` | `formatEventDateRange(...)` composed (below) · `eventTypeLabels[eventType]()` · `location` | status `<Badge variant='outline'>` with `eventStatusLabels[status]()` and `className={eventStatusClasses[status]}` |
| `member` | `<Avatar className='size-8'>` — `AvatarImage src={avatarUrl}` when `Some`, else initials | `displayName` | `#{jerseyNumber}` · up to 2 `RoleBadge`s + plain `+n` | `roster_inactive` badge when `active === false` |
| `group` | `UserCog` icon | `{emoji} {name}` | `tr('group_memberCount', { count })` | `<ColorDot>` |
| `roster` | `UsersRound` icon | `{emoji} {name}` | `tr('roster_memberCount', { count })` | `<ColorDot>` + active/inactive badge |
| `trainingType` | `Dumbbell` icon | `name` | `owner / member` group names with `trainingType_noGroup` fallback | — |

Icons are deliberately **the same lucide icons the sidebar already uses** for those sections
(`Calendar`, `Users`, `UserCog`, `UsersRound`, `Dumbbell`). A result row and its nav destination
should share a glyph — that is the whole payoff of having one icon language.

**Event secondary line, composed exactly.** `formatEventDateRange` returns
`{ startDate, startTime, end, sameDay }`, not a string, so the row composes it the same way
`EventDetailPage` does:

```
const { startDate, startTime, end, sameDay } = formatEventDateRange(
  startAt, endAt, allDay, startDateOpt, endDateOpt,
);
const start = allDay ? startDate : `${startDate} ${startTime}`;
const range = Option.match(end, { onNone: () => start, onSome: (e) => `${start} – ${e}` });
```

`allDay` additionally renders the existing `event_allDayLabel` chip after the range. The `·`
separators are punctuation, not translatable copy (same as `PlayerCard`); a missing part is dropped
along with its separator, never rendered as an empty gap.

**Hazard found — do not use `EffectiveRolesList` inside a result row.** It renders a Radix `Popover`
whose trigger is a real `<Button>` when roles overflow the limit. A `<button>` inside an `<a>` is
invalid HTML and produces a nested-interactive control that breaks keyboard and screen-reader
navigation. Member rows therefore render up to **2** `RoleBadge`s (which are `<span>`s) directly,
plus a plain non-interactive `<Badge variant='secondary'>+{n}</Badge>` for the remainder. The full
role list is one click away on the member page, which is where the row goes. Ordering is
`sortEffectiveRoles(resolveEffectiveRoles(ref))`, identical to `PlayerRow`, so the two badges shown
are the member's highest roles rather than an alphabetical accident.

**Missing / empty fields, per kind.** Every optional field is *omitted with its separator*, never
rendered as a placeholder — `members_fieldEmpty` ("—") is for table cells that must keep column
alignment, and a chat row has no columns to align.

| Situation | Rendering |
|---|---|
| `member.jerseyNumber` is `None` | secondary starts at the roles |
| `member` has no roles | secondary is the jersey alone; if there is no jersey either, the secondary line is **not rendered** and the primary line vertically centres |
| `event.location` is `None` | secondary ends after the type |
| `event` is `allDay` | no time is shown at all (`startTime` is `''` by construction) — never `00:00` |
| `group`/`roster` `emoji` is `None` | primary is the bare name, no leading space |
| `group`/`roster` `color` is `None` | `ColorDot` returns `null` — trailing slot collapses |
| `trainingType` has neither group | the whole secondary line is omitted (not two `Team-wide`s) |
| `member.avatarUrl` is `None` | initials fallback; `AvatarImage` is not rendered, so no broken-image request |

**Accessible name.** Each row's first child is an `sr-only` kind label so the link's accessible name
starts with its type: "Event, Tuesday training, 12 May 18:00, Active". Without it, a screen reader's
link list reads "Jan Novák, Tuesday training, Jan Novák" with no types.

### 3.5 Inline reference vs. result list — one rule

The wire has a single `references` array and markers in the prose. The rendering rule follows from
that, with no extra server field:

1. Parse the answer (§3.3). `cited` = the set of positions whose `token` appeared as
   `[[ref:<token>]]` in the prose.
2. **Cited references render inline**, in the prose, as `AssistantEntityLink` — and are **not**
   repeated as cards. The model put them in a sentence because the sentence is about them.
3. **Uncited references render as cards**, below the prose, in server order (which is tool order —
   the order the data actually came back in, not an order the model chose).
4. If every reference is cited, there is no card list. If none are cited — the common shape for
   "who hasn't RSVP'd", where the model writes a sentence and lets the data speak — the card list
   carries the whole answer.
5. **The one-result case follows the same rule, with no special casing.** "When is Thursday's
   training?" comes back through `list_events` (`get_event` is folded into it as an optional
   parameter, so there is no separate single-entity tool and no separate reference shape) with one
   `event` reference. If the model cited it — "Thursday's training is at [[ref:7f3a]]" — it renders
   inline in the sentence and there is no card. If it did not, it renders as a one-row card list:
   a single full-width row, no heading change, no "1 result" count. A lone row is a perfectly good
   answer surface — it is the same 48px row with the same colour bar, date range and status badge —
   and inventing a "detail card" layout for `n === 1` would mean two card designs per kind, each
   under-exercised, for no user gain.
6. If `references` is empty there is no list and no empty-list message. The prose already says
   whatever there is to say, and a "no results" box under a sentence that reads "I found nothing
   matching that" is redundant chrome. (This is why `assistant_results_none` from the previous
   revision is gone.)

**List layout.** `AssistantResultList`:

- `sr-only` heading `{tr('assistant_results_label')}` on a `<ul className='flex flex-col gap-1.5'>`.
- **Five rows visible.** Beyond that, a `Button variant='link' size='sm'` labelled
  `{tr('assistant_results_showMore', { count })}` expands the rest **in place** — no request, no
  navigation. The wire carries no `total`, so a "Show all N" link to a list route would be both
  unbackable and unable to reproduce the assistant's filter; expanding what we actually have is the
  honest affordance.
- Once expanded, the button unmounts and focus moves to the first newly revealed row.
- **Mixed kinds render as one flat list**, not grouped. Grouping implies a taxonomy the answer does
  not have ("the event *and* its roster" is one thought), and each row already carries its own glyph
  and sr-only kind label. A grouped list would also need per-group headings, which is five more
  translation keys for a case that is rare.

### 3.6 Inline entity links

Each resolved `[[ref:<token>]]` becomes an `<AssistantEntityLink>`: a real TanStack `<Link>` to the
entity's route, styled with `badgeVariants({ variant: 'outline' })` plus the entity's icon.

This respects the badge rule in `AGENTS.md` — the rule bans attaching click/keyboard handlers to
`<Badge>` (a bare `<span>`); it does not ban *styling an anchor* like a badge. `badgeVariants` ships
`[a&]:hover:` variants precisely for this, and `Link` renders an `<a>`, so the result is focusable,
in the tab order, announced as a link, and keyboard-activatable.

```tsx
<Link to={ENTITY_ROUTE.event} params={{ teamId, eventId: ref.eventId }}
      className={cn(badgeVariants({ variant: 'outline' }),
                    'gap-1 align-baseline hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50')}>
  <Calendar className='size-3' aria-hidden='true' />
  <span className='sr-only'>{entityKindLabels.event()}: </span>
  {ref.title}
</Link>
```

The visible label comes from the reference's typed data (`title` / `displayName` / `name`) — **never**
from the prose around the marker (P1).

### 3.7 Routing — cast-free, drift-free

`entityRouteFor(ref): { to: string }` does not type-check against TanStack's typed `<Link to>`: `to`
is a literal-union-typed prop and `params` is typed *per route*, so a widened `string` forces an
`as never` at the call site — the exact drift the helper was supposed to prevent.

The fix is a literal-typed table plus one exhaustive switch:

```ts
// lib/assistant/entityRoutes.ts — pure, no React
export const ENTITY_ROUTE = {
  event:        '/teams/$teamId/events/$eventId',
  member:       '/teams/$teamId/members/$memberId',
  group:        '/teams/$teamId/groups/$groupId',
  roster:       '/teams/$teamId/rosters/$rosterId',
  trainingType: '/teams/$teamId/training-types/$trainingTypeId',
} as const satisfies Record<EntityRef['kind'], string>;
```

- `as const` preserves each value's **literal** type, so `to={ENTITY_ROUTE.event}` type-checks
  exactly as an inline literal does — no cast anywhere.
- `satisfies Record<EntityRef['kind'], string>` makes a **missing kind a compile error**, which is
  the drift that actually matters when a sixth entity type is added.
- The five `params` objects live in the single `switch (ref.kind)` inside `AssistantEntityLink`
  (and the same switch is reused by `AssistantResultRow` via a shared `renderLink` local), so each
  branch's params are narrowed and typed by the router. Five `<Link>` call sites total, all in one
  file — not scattered across five components.
- If the app's `Register` augmentation later registers the router type, tighten the `satisfies` to
  `Record<EntityRef['kind'], NonNullable<LinkProps['to']>>` and typos become compile errors too.
  Until then, `entityRoutes.test.ts` asserts every key of `ENTITY_ROUTE` is present and that each
  value matches `/^\/teams\/\$teamId\//`.

All five destination routes exist today: `events.$eventId`, `members.$memberId`, `groups.$groupId`,
`rosters.$rosterId`, `training-types.$trainingTypeId`.

---

## 4. The confirmation UX — removed

Section number deliberately left empty. The write/confirmation surface is out of scope for this PR;
its design notes live in §9 so the section numbering of the reviewed revision stays stable.

---

## 5. Accessibility

### Keyboard flow

Tab order down the page: `SidebarTrigger` → breadcrumbs → `New chat` → (per turn) inline entity
links → result rows → `Show N more` → composer textarea → send.
The log container is **not** focusable — its content is, and adding `tabIndex={0}` to a live region
creates a dead tab stop that reads the whole transcript.

- Composer: `Enter` submits (pointer devices), `Shift+Enter` newline, `Escape` blurs back to the
  document flow. On touch, `Enter` is newline only.
- Suggested-prompt buttons are ordinary `<Button>`s — full keyboard support for free.
- Result rows are single `<Link>`s: one tab stop each, `Enter` navigates. **Nothing interactive is
  nested inside them** (see the `EffectiveRolesList` hazard in §3.4) — that is an accessibility
  constraint, not a styling one.
- `Show N more` moves focus to the first newly revealed row, so keyboard users are not dropped back
  at the top of the list.
- The retry button in a failed turn is reachable by `Tab` from the preceding turn; when it is
  disabled during a 429 cooldown it stays in the tab order (`disabled` buttons are skipped by
  browsers, so the countdown label is also mirrored in the alert body for AT).

### Focus management

**Focus is never moved when an answer arrives.** The user may be mid-sentence in the composer; the
polite live region carries the news. The log scrolls (§2.2) but focus does not follow it — scrolling
a container never moves focus, so a keyboard user who has tabbed into an older turn's links stays
exactly where they were. The only programmatic focus move in this slice is the `Show N more`
expansion described above.

### Screen-reader announcements

- **One live region for the conversation**: the log, `role='log' aria-live='polite'
  aria-relevant='additions text'`. Nested live regions double-announce, so no turn-level component
  carries an `aria-live` of its own.
- The thinking indicator is `role='status'`, announcing `assistant_thinking` once.
- The history-trimmed divider is `role='note'`, not a live region — it appears as a side effect of
  sending, and announcing it would step on the answer.
- Sonner already manages its own live region; nothing extra is needed.
- Every icon is `aria-hidden='true'`; every icon-only control carries `<span className='sr-only'>` —
  the rule already enforced across `PlayerCard`, `EventLocation`, `AppSidebar`.
- Each turn is an `<li>` preceded by an `sr-only` speaker label (`assistant_youLabel` /
  `assistant_assistantLabel`). Without it a transcript is an undifferentiated wall of text.
- Each result row starts with an `sr-only` kind label (§3.4).

### Contrast and hit targets

- **Theme tokens only** for chrome: `text-muted-foreground` / `bg-card` / `bg-primary` /
  `text-primary-foreground` / `Alert variant='destructive'` / `Badge variant='outline'|'secondary'`.
  The two sanctioned exceptions are the ones the app already ships and this design reuses verbatim:
  `event-colors.ts`'s palette classes (leading bar) and `eventStatusClasses` (status text).
- **Never encode state in colour alone.** The event status badge carries `eventStatusLabels` text,
  not just `eventStatusClasses` colour. The degraded turn carries an icon + a title + body copy. The
  inactive roster/member badge carries the word, not a grey dot.
- **Hit targets:** result rows are `h-12` (48px), comfortably above the 44px touch guideline. The
  composer send button is `size='icon'` (36×36). Suggested prompts are `h-auto py-3` so a two-line
  prompt stays tappable. Nothing in this slice uses `size='xs'` (24px), which exists for dense table
  rows.
- **Focus visibility** comes from the shared `focus-visible:ring-[3px] focus-visible:ring-ring/50`
  baked into `Button`/`Textarea`; the composer wrapper uses `focus-within:ring-[3px]` so the whole
  composer shows focus when the textarea has it.
- **Reduced motion:** the only animations are `animate-spin` on the thinking spinner (already used
  app-wide) and the log auto-scroll, which falls back to `behavior: 'auto'` under
  `prefers-reduced-motion: reduce`.
- **Forced colors:** the leading event colour bar is decorative; the row's `border` from the shared
  skeleton keeps it delimited when custom colours are dropped, and the status text survives because
  it is text.

---

## 6. Component inventory

**10 new components**, 3 pure lib modules, 1 hook.

Four candidates from the previous revision — `AssistantUserMessage`, `AssistantThinkingIndicator`,
`AssistantDegradedNotice` and `AssistantDisabledState` — are **not components**. Each is under ~20
lines of static JSX taking `{}` or a single prop, with no state, no branching beyond one ternary and
no reuse outside its one call site. The same reasoning already applied to the history-trimmed divider
in §2.6 ("it is one line and does not earn a component") applies verbatim: they are inlined into
`AssistantConversation` (the first three) and `AssistantPage` (the last). Extracting them would cost
four files, four import edges and four prop contracts to save nothing.

### `atoms/` (1)

| Component | Props | Reuses |
|---|---|---|
| `AssistantEntityLink.tsx` | `{ reference: EntityRef; teamId: string; className?: string }` | `Link`, `badgeVariants`, lucide icons, `ENTITY_ROUTE`, `entityKindLabels`, `cn` |

Pure presentational, no API calls — matching the atoms rule. Owns the five typed `<Link>` branches
(§3.7).

### `molecules/assistant/` (6)

| Component | Props | Reuses |
|---|---|---|
| `AssistantAnswer.tsx` | `{ text: string; references: ReadonlyArray<EntityRef>; teamId: string }` — derives the turn's `token → position` map from `references` with `useMemo`; returns `cited` to its parent so `AssistantResultList` can skip those entries | `parseAnswer`, `AssistantEntityLink` |
| `AssistantResultRow.tsx` | `{ leading: ReactNode; primary: ReactNode; secondary?: ReactNode; trailing?: ReactNode; kindLabel: string; to; params }` | `Link`, `cn` |
| `AssistantResultCard.tsx` | `{ reference: EntityRef; teamId: string; colorMap: TrainingTypeColorMap }` | `AssistantResultRow`, `Avatar`, `Badge`, `ColorDot`, `RoleBadge`, `resolveEffectiveRoles`, `sortEffectiveRoles`, `lib/datetime`, `lib/event-labels`, `lib/event-colors` |
| `AssistantResultList.tsx` | `{ references: ReadonlyArray<EntityRef>; teamId: string }` | `AssistantResultCard`, `Button`, `tr` |
| `AssistantEmptyState.tsx` | `{ onPickPrompt: (prompt: string) => void }` | `Button`, `Sparkles`, `useIsMobile`, `tr` |
| `AssistantTurnError.tsx` | `{ reason: 'rateLimited' \| 'forbidden' \| 'generic'; retryAfterSeconds?: number; onRetry: () => void }` | `Alert`, `Button`, `useRetryCooldown`, `tr` |

`AssistantTurnError` survives the cut where the degraded notice does not: it owns a hook
(`useRetryCooldown`), a three-way reason lookup, a conditional button and a countdown label — real
behaviour, not a shape.

`AssistantResultCard` holds the dispatcher plus the five per-kind branches (each ~20 lines over the
shared `AssistantResultRow`). If it passes ~200 lines, split the branches into
`molecules/assistant/results/*.tsx` — the dispatcher is the only thing that must stay in one place.

No molecule fetches. No molecule owns router hooks beyond importing `Link` (allowed).

### `organisms/assistant/` (2)

| Component | Props | Owns |
|---|---|---|
| `AssistantConversation.tsx` | `{ teamId: string }` | the `turns` state, `useRun()` for the chat call, optimistic user turn, retry, the `role='log'` region, unconditional auto-scroll, the history-trimmed divider, the per-turn training-type colour map, the `New chat` `AlertDialog`, and the four inlined fragments (user bubble, thinking indicator, degraded notice, trimmed divider). Renders `AssistantComposer`. |
| `AssistantComposer.tsx` | `{ onSend: (message: string) => Promise<void>; disabled: boolean; presetValue?: string }` | the RHF form, Enter/Shift+Enter policy, counter, hint line |

Per §2.9 (Pattern A) `AssistantConversation` builds and runs its own Effect and brands `teamId`
itself. It uses no router hooks; it needs no `onRefresh` because it mutates nothing.

The `New chat` `AlertDialog` is rendered **always-mounted, driven by `open`** (the "Dialogs Must Be
Always-Mounted" rule).

### `pages/` (1)

| Component | Props |
|---|---|
| `AssistantPage.tsx` | `{ teamId: string; enabled: boolean }` — renders the `h1`, subtitle, and either the inlined disabled state or `AssistantConversation`. No `Route.use*()`. |

### `lib/assistant/` (pure, co-located tests)

| Module | Export |
|---|---|
| `parseAnswer.ts` + `.test.ts` | `parseAnswer(text, tokens)` → paragraphs of segments + `cited` positions; unresolvable tokens dropped, near-misses left verbatim |
| `entityRoutes.ts` + `.test.ts` | `ENTITY_ROUTE` (+ `entityKindLabels` and `degradedReasonLabels`, the explicit `Record<…, () => string>` lookups from §7) |
| `history.ts` + `.test.ts` | `HISTORY_CHAR_BUDGET`, `HISTORY_MAX_MESSAGES`, `buildHistory(turns)` → `{ messages, droppedCount }` |

No React, no `ApiClient` in any of them. `entityKindLabels` and `degradedReasonLabels` call `tr()`
lazily inside each thunk, exactly like `event-labels.ts`, so the module stays import-safe.

### `hooks/` (1)

| Hook | Signature |
|---|---|
| `useRetryCooldown.ts` | `(seconds: number) => number` — remaining seconds; 1s interval, cleared on unmount, stops at 0 |

### Existing components reused unchanged

`ui/`: `alert`, `alert-dialog`, `avatar`, `badge` (+ exported `badgeVariants`), `button`, `form`,
`separator`, `skeleton`, `textarea`, `sonner`.
`atoms/`: `ColorDot`.
`molecules/`: `RoleBadge`.
`lib/`: `datetime` (`formatEventDateRange`), `event-labels` (`eventTypeLabels`, `eventStatusLabels`,
`eventStatusClasses`), `event-colors` (`getEventColor`, `buildTrainingTypeColorMap`),
`roles/resolveEffectiveRoles`, `roles/role-order` (`sortEffectiveRoles`), `runtime` (`useRun`,
`ApiClient`, `ClientError`, `SilentClientError`), `translations`.
`hooks/`: `useFormatDate`, `use-mobile`.

**Not reused, deliberately:** `EffectiveRolesList` (nested interactive inside a link — §3.4).

---

## 7. Translation keys

All keys added to **both** `packages/i18n/messages/en.json` and `packages/i18n/messages/cs.json`,
then `pnpm codegen && pnpm build` so `messagesByKey` picks them up. Called only via
`tr('key', params?)` **with a literal key**.

### No computed keys

`` tr(`assistant_result_${kind}`) `` is invisible to `lib/staticTrKeys.test.ts`, and `tr()` on a
missing key does not throw — it prints the raw key to the user. **Two** unions in this slice arrive
from the wire as runtime strings, and both get an explicit lookup instead, matching the
`event-labels.ts:13` idiom — the five entity kinds and the five `degradedReason` values:

```ts
// lib/assistant/entityRoutes.ts
export const entityKindLabels: Record<EntityRef['kind'], () => string> = {
  event:        () => tr('assistant_result_event'),
  member:       () => tr('assistant_result_member'),
  group:        () => tr('assistant_result_group'),
  roster:       () => tr('assistant_result_roster'),
  trainingType: () => tr('assistant_result_trainingType'),
};

export const degradedReasonLabels: Record<DegradedReason, () => string> = {
  not_configured: () => tr('assistant_degraded_notConfigured'),
  disabled:       () => tr('assistant_degraded_disabled'),
  provider_error: () => tr('assistant_degraded_providerError'),
  too_many_steps: () => tr('assistant_degraded_tooManySteps'),
  empty_answer:   () => tr('assistant_degraded_emptyAnswer'),
};
```

`degradedReasonLabels` is the one that would have been easiest to get wrong: the wire tokens are
`snake_case` and the key names are not, so `` tr(`assistant_degraded_${reason}`) `` produces five keys
that do not exist and prints `assistant_degraded_not_configured` verbatim into the transcript.

Same for the turn-error reasons in `AssistantTurnError` — a `Record<'rateLimited' | 'forbidden' |
'generic', () => string>`, never a template literal.

### Reused — do not mint duplicates

Verified with `grep -o '"<key>": "[^"]*"' packages/i18n/messages/en.json`:

| Key | Value (en) | Used for |
|---|---|---|
| `common_cancel` | Cancel | `AlertDialogCancel` on New chat |
| `common_listSeparator` | `, ` | joining group names in a `RoleBadge` aria-label (via `RoleBadge` itself) |
| `members_ratingDescCounter` | {count}/{max} | composer character counter |
| `group_memberCount` | {count} members | group result row |
| `roster_memberCount` | {count} members | roster result row |
| `roster_active` / `roster_inactive` | Active / Inactive | roster + member result rows |
| `trainingType_noGroup` | Team-wide | training-type result row |
| `event_allDayLabel` | All day | all-day event rows |
| `event_status_*`, `event_type_*` | — | via `eventStatusLabels` / `eventTypeLabels` |
| `validation_required` | This field is required. | empty composer submit |

### One generic key to mint + migrate

`challenges_retry` ("Retry" / "Zkusit znovu") already exists but is feature-scoped. Mint
`common_retry` with identical values and, in the same PR, point `challenges_retry`'s two call sites
at it and delete the old key — so no duplicate English string is introduced.

| Key | en | cs |
|---|---|---|
| `common_retry` | Retry | Zkusit znovu |

### New keys

#### Navigation and page chrome (6)

| Key | en | cs |
|---|---|---|
| `assistant_navTitle` | Assistant | Asistent |
| `assistant_pageSubtitle` | Ask about your team — events, members, groups, rosters and training types. | Zeptejte se na svůj tým — události, členy, skupiny, soupisky a typy tréninků. |
| `assistant_newChat` | New chat | Nový chat |
| `assistant_newChatConfirmTitle` | Start a new chat? | Začít nový chat? |
| `assistant_newChatConfirmDescription` | This clears the conversation on this page. It isn't saved anywhere, so it can't be brought back. | Tím se konverzace na této stránce smaže. Nikam se neukládá, takže ji nepůjde obnovit. |
| `assistant_newChatConfirmAction` | Clear | Vymazat |

#### Disabled page state (2)

| Key | en | cs |
|---|---|---|
| `assistant_disabled_title` | The assistant isn't available | Asistent není k dispozici |
| `assistant_disabled_body` | The assistant isn't available for this team right now. Your team admin can tell you more. | Asistent teď pro tento tým není k dispozici. Více vám řekne správce týmu. |

#### Conversation log (5)

| Key | en | cs |
|---|---|---|
| `assistant_logLabel` | Conversation with the assistant | Konverzace s asistentem |
| `assistant_youLabel` | You | Vy |
| `assistant_assistantLabel` | Assistant | Asistent |
| `assistant_thinking` | Thinking… | Přemýšlím… |
| `assistant_historyTrimmed` | Earlier messages aren't included in what the assistant sees | Starší zprávy už asistent nevidí |

(`assistant_jumpToLatest` is gone with the scroll-position guard — §2.2.)

#### Empty state and suggested prompts (7)

| Key | en | cs |
|---|---|---|
| `assistant_empty_title` | Ask me about your team | Zeptejte se mě na svůj tým |
| `assistant_empty_body` | I can look up events, members, groups, rosters and training types, and answer questions about them. | Umím vyhledat události, členy, skupiny, soupisky a typy tréninků a odpovídat na otázky o nich. |
| `assistant_empty_suggestionsLabel` | Try one of these | Zkuste například |
| `assistant_suggestion_rsvp` | Who hasn't answered the RSVP for Thursday's training? | Kdo zatím neodpověděl na docházku na čtvrteční trénink? |
| `assistant_suggestion_filter` | Which players in the U20 group are missing a jersey number? | Kterým hráčům ve skupině U20 chybí číslo dresu? |
| `assistant_suggestion_attendance` | Show me the attendance for the last four trainings | Ukaž mi docházku na posledních čtyřech trénincích |
| `assistant_suggestion_aggregate` | How many trainings did we have last month? | Kolik jsme měli minulý měsíc tréninků? |

#### Composer (6)

| Key | en | cs |
|---|---|---|
| `assistant_composer_label` | Message the assistant | Zpráva pro asistenta |
| `assistant_composer_placeholder` | Ask a question about your team… | Zeptejte se na cokoli o svém týmu… |
| `assistant_composer_send` | Send | Odeslat |
| `assistant_composer_hintDesktop` | Enter to send · Shift+Enter for a new line | Enter odešle · Shift+Enter vloží nový řádek |
| `assistant_composer_hintMobile` | Tap Send when you're ready | Až budete hotovi, klepněte na Odeslat |
| `assistant_composer_tooLong` | Keep your message under {max} characters. | Zpráva musí mít méně než {max} znaků. |

#### Degraded turn — `generated: false` (6)

One shared title, then one body per `degradedReason`. The title is deliberately reason-agnostic so it
reads correctly above all five bodies; the body is where the difference lives.

| Key | en | cs |
|---|---|---|
| `assistant_degraded_title` | I couldn't give you a full answer | Nedokázal jsem odpovědět naplno |
| `assistant_degraded_notConfigured` | The assistant isn't set up yet. Your team admin can turn it on. | Asistent zatím není nastavený. Může ho zapnout správce týmu. |
| `assistant_degraded_disabled` | The assistant is switched off for this team right now. | Asistent je teď pro tento tým vypnutý. |
| `assistant_degraded_providerError` | The assistant is having trouble right now. Try asking again in a moment. | Asistent má teď potíže. Zkuste se za chvíli zeptat znovu. |
| `assistant_degraded_tooManySteps` | That question needed too many steps to work through. Try asking something more specific. | Tahle otázka vyžadovala příliš mnoho kroků. Zkuste se zeptat konkrétněji. |
| `assistant_degraded_emptyAnswer` | The assistant didn't come back with anything. Try putting the question a different way. | Asistent nevrátil žádnou odpověď. Zkuste otázku formulovat jinak. |

`assistant_degraded_body` from the previous revision is **dropped** — it was the single
cause-agnostic sentence that existed only because the client could not tell the causes apart.
**No `turnFailed*` key is superseded**: those three cover 403, 429 and transport failures, which are
non-200 paths with different recovery (§2.7) and are unreachable from `degradedReason`.

#### Turn errors (5)

| Key | en | cs |
|---|---|---|
| `assistant_turnFailedTitle` | I couldn't answer that | Na tohle jsem nedokázal odpovědět |
| `assistant_turnFailedGeneric` | Something went wrong. Please try again. | Něco se pokazilo. Zkuste to prosím znovu. |
| `assistant_turnFailedRateLimited` | Too many questions in a short time. Wait a moment and try again. | Příliš mnoho dotazů v krátkém čase. Chvíli počkejte a zkuste to znovu. |
| `assistant_turnFailedForbidden` | You don't have access to the assistant for this team. | K asistentovi tohoto týmu nemáte přístup. |
| `assistant_turnFailedRetryIn` | Try again in {seconds}s | Zkusit znovu za {seconds} s |

#### Results (7)

| Key | en | cs |
|---|---|---|
| `assistant_results_label` | Results | Výsledky |
| `assistant_results_showMore` | Show {count} more | Zobrazit dalších {count} |
| `assistant_result_event` | Event | Událost |
| `assistant_result_member` | Member | Člen |
| `assistant_result_group` | Group | Skupina |
| `assistant_result_roster` | Roster | Soupiska |
| `assistant_result_trainingType` | Training type | Typ tréninku |

**Total: 44 new keys** (6 + 2 + 5 + 7 + 6 + 6 + 5 + 7) + 1 migrated (`common_retry`).

Net movement from the previous revision's 41: **+4** for the per-reason degraded bodies (five minted,
one dropped) and **−1** for `assistant_jumpToLatest`.

Czech copy follows the app's existing register: **vykání** toward the user ("Zkuste to prosím
znovu"), informal imperative in the *suggested prompts* only, because there the user is addressing
the assistant, not the other way round.

---

## 8. Mobile (< 768px)

The breakpoint that matters is `useIsMobile()`'s 768px — the same one the sidebar uses, so the
assistant switches behaviour at exactly the moment the nav does.

**Layout**

- The page is already inside `SidebarInset`; the sidebar is a `Sheet` and not on screen, so the
  assistant gets the full viewport width. The `max-w-3xl` content column has no effect below 768px.
- `flex-1 min-h-0` + the log's `overflow-y-auto` means the **log scrolls, the composer does not**.
  The composer stays pinned above the fold with `pb-[env(safe-area-inset-bottom)]`, matching the
  header's existing `pt-[env(safe-area-inset-top)]` treatment.
- The subtitle is `hidden sm:block` to buy back a line of chat on a phone.
- The sticky app header is `h-16` (`h-12` when the sidebar is in icon mode); the log's available
  height is `100dvh` minus that, minus the composer. Use `dvh`, not `vh`, so the mobile URL bar
  collapsing does not clip the composer.

**Keyboard**

- The soft keyboard shrinks the visual viewport. The log scrolls to the bottom when the textarea
  receives focus so the last message stays visible above the keyboard.
- `Enter` is a newline, never a send (§2.8). The send button is the only submit path — 36×36 with the
  standard `gap-2` separation from the textarea, comfortably tappable.

**Message list**

- User bubble max-width goes to `85%` (from `75%` at `sm:`), so short replies do not look stranded.
- Timestamps are relative-only (they already are).

**Result rows at narrow widths** — the part that actually needs care, because five different
trailing elements compete with a truncating two-line text block:

- Rows keep their `h-12` (48px) height at every width and rely on `truncate` + `min-w-0` for the
  primary and secondary lines. The row never wraps to a third line.
- **`event`**: below `sm` the status badge moves out of the trailing slot and onto the **end of the
  secondary line**, where it is allowed to be the thing that truncates. A 12-character status badge
  on a 360px screen otherwise leaves ~140px for the event title. The leading colour bar and
  `Calendar` icon stay — they are 32px total and carry the type at a glance.
- **`member`**: the role badge limit drops from 2 to **1** below `sm` (the `+n` badge absorbs the
  rest), matching `PlayerRow`'s `limit={1}` on its mobile branch. Avatar stays at `size-8`; when
  `avatarUrl` is `None` the initials fallback is the same size, so the row never reflows.
- **`group` / `roster`**: `ColorDot` is 12px and always stays. The roster active/inactive badge drops
  to the secondary line below `sm`, same rule as the event status.
- **`trainingType`**: the `owner / member` pair truncates as one string; it never splits across lines.
- Inline entity links in prose wrap with the text (`align-baseline`, no `whitespace-nowrap` on the
  container) — a long event title as a badge-styled link must be allowed to break rather than force
  a horizontal scrollbar. Use `break-words` on the prose container.

**Empty state**

- The suggestion grid collapses from `sm:grid-cols-2` to a single column. Show **3** suggestions on
  mobile instead of 4 (drop `assistant_suggestion_aggregate`) so the empty state plus composer fit on
  a 667px-tall screen without scrolling.

**Result list**

- `Show N more` is a full-width `Button variant='link'` at the end of the list below `sm`, so it is a
  thumb-sized target rather than a 60px text link.

**Disabled / degraded states**

- The disabled state centres in the available height and needs no change.
- The degraded `Alert` and the error `Alert` are already full-width block elements; the retry button
  goes `w-full sm:w-auto`. The five degraded bodies are all one or two short sentences, so none of
  them pushes the alert past three lines at 360px.

---

## 9. Deferred to the follow-up PR (write path)

Design work that exists and was deliberately cut from this slice. The next author should not
re-derive it from scratch — these are notes, not specs.

- **`AssistantProposalCard` and its eight-state machine** (`pending` → `confirming` → `applied` /
  `failed` / `stale` / `expired` / `discarded` / `superseded`). The central rule was: a user must be
  able to verify exactly what will change *before* it changes, without reading prose — the same P1
  ("the card is the contract") that governs result cards here.
- **A field-by-field `<dl>` diff** (`ProposalFieldList`) with before → after pairs, `<s>` on the old
  value and `→` to the new, a "fields not listed stay unchanged" note, and an impacts list. Stacks to
  one column below `sm`, with `→` becoming `↓`.
- **A second confirmation for destructive actions** via `AlertDialog`, always-mounted and `open`-driven,
  with the proposal frozen in a `useRef` so the content does not blank during the close animation.
  Radix's default focus on `AlertDialogCancel` is kept.
- **Confirm must be the last focusable control in the card**, after Discard, so a stray `Enter` never
  lands on a write; and no path from the composer may trigger one. On mobile, `CardFooter` becomes
  `flex-col-reverse` so Confirm is visually on top but still last in DOM order.
- **Expiry** — `ExpiryCountdownBadge` + `useExpiryCountdown`, an expired state that explains nothing
  was changed and offers "Ask again", and which must **not** steal focus when it fires.
- **`canWrite`** — the capabilities endpoint returns only `{ enabled }` today. A write slice needs a
  permission signal, and the empty state should then swap one read suggestion for a create example so
  members are never taught a gesture they cannot use. A read-only `Alert` explains the difference.
- **`onRefresh`/`router.invalidate()`** returns to the page and route (§1), because after a confirmed
  write other routes' loaders hold stale data and the user usually navigates straight to the new
  entity.
- **Proposal-specific errors** (`ProposalConflict`, forbidden-on-confirm) and the
  `assistant_proposal_*` / `assistant_*_update` / `_delete` / `destructive*` key families — roughly
  36 further translation keys, none of which are minted here.
