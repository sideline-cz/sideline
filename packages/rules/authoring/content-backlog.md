# Content backlog — toward 200 situations

Standing instruction from the user: **keep batching, don't ask, until 200 situations.**
Currently at **109**.

## How to pick the next batch (and the trap in it)

The obvious method is to audit which rule numbers are not yet cited and write situations for
them. That is a good *starting* filter and a bad *stopping* one.

**Batch 10 was drafted that way and four of its nine situations came back near-clones.** The
audit said §2 Playing Field had zero citations, so "a foot on the goal line — is it a goal?"
looked like virgin ground. It wasn't: `gl1` already teaches exactly that, citing 14.1 and never
mentioning 2.4. Same for the seventy-second wound allowance — `ts1` teaches it off 19.2.1
without citing 19.2.1.2, so 19.2.1.2 looked unused. Casualties: `to4` (repeated `to3`'s whole
chain), `bw1` (two of `ts1`'s steps), `cz1` (one of `gl1`'s), `br1` (two of `s1`'s).

So the order of checks is:

1. Audit uncited rule numbers — a candidate list, nothing more.
2. For each candidate, ask **is this lesson already taught?** Grep the content for the
   *phrasing of the answer*, not the rule number. `ob5` already contained the exact words
   "not part of the playing field" while citing nothing from §2.
3. Run `node test/duplication.mjs`. It fails on a whole-chain clone and prints a WARN tier
   below that. **Read the WARN lines** — its known limit is partial overlap.
4. Only then author.

## Verified-unmined material for batch 11+

Checked against the citation index and grepped for the lesson, so these should be genuinely new.

### §1 Spirit of the Game — the richest remaining seam
- `1.3.x` the conduct list players must follow: be fair-minded and objective (1.3.2), truthful
  (1.3.3), explain your viewpoint clearly and briefly (1.3.4), allow opponents an opportunity to
  speak (1.3.5), listen and consider (1.3.6), respectful words and body language with
  consideration of cultural differences (1.3.7), resolve disputes efficiently (1.3.8), make calls
  consistently through the game (1.3.9).
- `1.4` highly competitive play is encouraged but must never sacrifice mutual respect, adherence
  to the rules, player safety or the basic joy of play.
- `1.5.x` examples of good Spirit — retracting a call you no longer believe (1.5.1), checking in
  with an opponent after a contentious interaction (1.5.2), complimenting good play (1.5.3),
  introducing yourself (1.5.4), reacting calmly to provocation (1.5.5).
- `1.6.x` clear violations — dangerous play and aggressive behaviour (1.6.1), intentional fouling
  (1.6.2), taunting or intimidating (1.6.3), celebrating disrespectfully after scoring (1.6.4),
  **making calls in retaliation to an opponent's call (1.6.5)**, other win-at-all-costs behaviour
  (1.6.7). (1.6.6 is used by `sg2`.)
- `1.7.1–1.7.3` teams as guardians: teaching their own team the rules, disciplining team-mates
  with poor Spirit, giving constructive feedback to other teams.
- `1.8` / `1.9` novice players — experienced players should assist to explain a breach; an
  experienced player may supervise games involving beginners and guide on-field arbitration.
- `1.10.1` a player not directly involved who thinks a team-mate made an incorrect call, or
  caused a foul, should tell their team-mate.

### Elsewhere
- `2.2` the perimeter lines: two sidelines along the length, two endlines along the width.
- `3.2` WFDF may maintain a list of approved discs. `3.3` uniform must distinguish the team.
- `6.1` / `6.2` the initial choice itself — receive-or-throw vs which end to defend, and the
  other team taking the remaining choice. (`hf1` covers only 6.3's switch.) `6.4` Mixed
  personnel match-ups. `5.4` the alternating 4:3 ratio in Mixed.
- `7.1.1` teams must prepare for the pull without unreasonable delay. `7.5.1` / `7.5.2` the
  false-start and offside remedies (offside → resume as if a brick had been called, **no check
  required** — a nice counterintuitive one).
- `10.4` before the check, the person checking in and the nearest opposition player must verify
  their own team-mates are ready and positioned per 10.2.
- `12.10` no player may physically assist another's movement, nor use equipment to contact the
  disc.
- `19.1.5` an injury stoppage counts as called at the time of the injury, unless the injured
  player chose to continue play first.
- **The appendix is still entirely unread** (`rules/WFDF-Rules-of-Ultimate-2025-2028-Appendix-v2.0.txt`,
  119 KB). Likely the largest single untouched source.

## Authoring reminders

- Content goes in `src/content/NN-*.json`; never touch `dist/` or the static repo by hand.
- A scenario's `level` must equal its package file's `level` (build guard), so new situations
  have to fit one of the nine existing packages.
- Exactly one `ok:true` per step, and **every** option needs `why` in both languages — the
  correct one too.
- `qAt` is required and must be `< dur`. Any fx with `t > qAt` belongs to the resolution, so put
  answer-revealing marks after `qAt` or the spoiler check fires.
- Every `rules:[]` chip needs an entry in `rules.json`, in the source's own wording.
- Field geometry: 100 × 37, end zones `x∈[0,18]` and `x∈[82,100]`, goal lines at `x=18` / `x=82`,
  brick marks at `x=36` / `x=64`, `y=18.5`.
- Czech stays AI-written and unreviewed — a standing caveat the user still needs to proofread.

## Phase 0 → Phase 1 carry-over: the 6 deleted zone fx

Phase 0 deleted 6 `fx` objects authored with a top-level `"type": "zone"` from `pl7`, `rf3`,
`sp5`, `ob2`, `gl1`, `gl2`. They rendered nothing in the source `app.js` — `buildFx` only ever
branched on `bubble | flash | mark | arrow` — so the deletion is zero-visual-change and provably
so; it was not a content judgement call.

**Reauthor them in Phase 1** as `{ "type": "mark", "kind": "zone", ... }` instead, once there is a
Playwright baseline to review the result against (a dashed zone circle will render for the first
time). Carry over the original coordinates:

- `pl7` — `x:9, y:18.5, r:8.6` ("your defending end zone")
- `rf3` — `x:91, y:18.5, r:8` ("your attacking end zone")
- `sp5` — `x:71.6, y:22.4, r:2.6` ("their lane")
- `ob2` — `x:9, y:18.5, r:9` ("your defending end zone")
- `gl1` — `x:91, y:18.5, r:8` ("attacking end zone")
- `gl2` — `x:91, y:18.5, r:8` ("attacking end zone")

While doing that: `ob6` already has a `mark`/`zone` fx at `x:81, y:-3.2, r:3` inside view
`[56,-6,48,48]` that pokes ~0.2 units outside its own view. The current G10 view-bounds guard only
checks the mark's centre point, so it does not catch this. A zone-*extent* guard (centre ± `r`
inside `view`, not just the centre) belongs together with this reauthoring work.
