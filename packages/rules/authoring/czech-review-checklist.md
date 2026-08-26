# Czech review checklist

> **Status: the launch gate is lifted.** `/cs/rules` shipped ungated by owner sign-off — no
> `noindex`, no review notice. This checklist is **no longer blocking anything**, and is kept
> because the sign-off was a page-level judgement rather than a read of all 1182 options.
>
> It remains the tool for the deeper pass, and the risk it describes is unchanged: a dropped or
> inverted negation in a *wrong* option's `why` reads as fluent Czech and is invisible both to a
> glance and to `cz-audit.mjs`. Anyone working through a package should still tick its row.
>
> If a mistranslated ruling does turn up, re-gating is two lines in
> `applications/web/src/routes/cs.rules.tsx` — the banner and its i18n keys were kept for exactly
> that, and an e2e test asserts the notice is currently absent so it cannot creep back unnoticed.

Originally the deliverable that unblocked the gate: it splits ~3,800 EN/CS pairs into nine
independently clearable units, so the content could be cleared **one package at a time** rather
than waiting on a single 109-situation review.

## Why this gate exists

The Czech beyond roughly the first 23 situations is AI-written and was never read by a Czech
speaker. It is *already live that way* at rules.sideline.cz, so this is about **exposure, not a
new defect** — an SSR-indexed, Sideline-branded page teaching a mistranslated ruling to Czech
players is a different proposition from a side-project subdomain.

## What the mechanical audit already covers — and what it found

`node authoring/cz-audit.mjs` (from `packages/rules`) checks numeric values, rule citations, and
suspicious brevity across all 3,158 translatable pairs. Latest run: **zero genuine defects.**

| Section | Flags | Verdict |
|---|---|---|
| A — numeric value missing in Czech | 12 | All false positives, all in the classes the script's own header documents: Czech writes "oba"/"dvojka" where English writes "the two", and the marker's spoken calls ("ten", "stalling six") are deliberately kept in English. |
| B — rule citations differ | 1 | `ck1 · step1.opt2.why` — Czech adds a trailing "(10.7)" the English omits. **Not a defect:** 10.7 is the real parent rule of the 10.7.3/10.7.4 it cites, so the Czech is marginally more precise. Cosmetic asymmetry only. |
| C — Czech under 55% of English length | 5 | All legitimate. Czech is genuinely terser for these constructions. |

**So the mechanical checks are clean, and they cannot clear this gate.** What they cannot see is
whether a ruling is *semantically* correct in Czech — whether "contested" was rendered in a way a
Czech player would act on correctly, whether a conditional clause kept its direction, whether the
subject of a sentence survived. That needs a Czech-speaking ultimate player. Do not read a clean
audit as a cleared package.

Related, and deliberately NOT a defect: 47 distinct rule numbers are cited inline in prose without
appearing in `rules.json`. All 47 were verified against `reference/WFDF-Rules-of-Ultimate-2025-2028.txt`
and are real rules. `rules.json` holds only the 197 quotes the `§` chips need — prose may reference
any rule number. **Do not add a guard for inline citations**; it would flag 47 correct references.

## Per-package review units

Review in whatever order suits; there are no cross-package dependencies (guard G11 enforces that
every situation stands alone). Level 9 is the biggest single unit — consider splitting it.

| Done | Level | File | Situations | EN/CS pairs | Reviewer | Date |
|:---:|---|---|---:|---:|---|---|
| ☐ | 1 | `01-pull.json` | 13 | 451 | | |
| ☐ | 2 | `02-marking.json` | 9 | 340 | | |
| ☐ | 3 | `03-receiving.json` | 16 | 582 | | |
| ☐ | 4 | `04-thrower-marker.json` | 9 | 330 | | |
| ☐ | 5 | `05-travel.json` | 9 | 333 | | |
| ☐ | 6 | `06-picks.json` | 9 | 311 | | |
| ☐ | 7 | `07-stall-count.json` | 13 | 456 | | |
| ☐ | 8 | `08-out-of-bounds.json` | 11 | 373 | | |
| ☐ | 9 | `09-stoppages.json` | 20 | 666 | | |
| | | **Total** | **109** | **3842** | | |

Roughly the first 23 situations (`s1`–`s14`, `p3`, `p4`, `m3`, `m4`, `r4`, `r5`, `f4`, `t3`, `k3`)
were human-reviewed during the original project. They are spread across levels 1–6, so **no
package is fully pre-cleared** — but those situations can be read faster.

## What to check per situation

Priority order — a wrong ruling matters far more than clumsy phrasing:

1. **The correct option is still correct in Czech.** Highest stakes: a mistranslated `ok: true`
   option teaches the wrong rule. Check the option marked correct first.
2. **The `why` on each *wrong* option still explains why it is wrong.** A negation dropped or
   inverted here is the most likely AI failure and the hardest to spot.
3. **Conditionals kept their direction** — "before/during/after", "unless", "only if". These
   invert easily and change the ruling completely.
4. **`explain` matches the ruling** the steps arrived at.
5. **Terminology consistency** against `czech-terminology.md`. The audit's terminology section
   lists the currently mixed terms (`infraction`, `violation`, `stall count`, `sideline`,
   `contest`) with counts — deliberate English retention is fine and common in Czech ultimate;
   what matters is that one situation does not switch mid-explanation.
6. **The subject survived.** The audit caught `s12`'s "Odkud huck vypustil" (missing subject) this
   way; that class of error is invisible to every mechanical check.

Do not "fix" English-in-Czech terms reflexively — Czech ultimate players say "contest", "stall
count", "marker". `czech-terminology.md` records which terms are deliberately kept.

## Clearing a package

1. Review it against the list above; fix in place in `src/content/packages/NN-*.json`.
2. `pnpm --filter @sideline/rules test` — the guards must stay green (G9 both-languages, G11
   independence, and the rest).
3. Tick the row above with reviewer and date.
4. Remove that level from the noindex/under-review set on the `/cs/rules` route.

Once all nine are ticked, drop the `noindex` and the "translation under review" notice from
`/cs/rules` entirely, and delete this section of the gate from `docs/plans/rules-trainer.md`.
