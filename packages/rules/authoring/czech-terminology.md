# Czech terminology — the decision table

The Czech content is AI-written and was inconsistent: `házeč` 71% vs `thrower` 29%, `foul` 81% vs
`faul` 19%, `goal line` untranslated 46 times. Policy, chosen by the user: **translate to Czech
wherever a good Czech term exists.**

**Status: the terminology pass is complete.** `node scripts/cz-audit.mjs` heading **D** now shows
a single rendering for every concept in the Translate table, and each remaining MIXED flag is
explained rather than a defect (quoted calls for `foul`, the idiomatic `porušení pravidel` for
breach, the bench sense of `sideline`, the verb `nesouhlasit` for contest).

Two rules qualify that, both from evidence in the content itself.

## Rule 1 — a spoken call stays in English, always

You shout `„Foul“`, `„Travel“`, `„Pick“`, `„Violation“`, `„Contact“`, `„Brick“`, `„Disc in“`,
`„Delay of Game“`, `„Stalling one“` on the field. The trainer teaches players what to *say*, so a
translated call would teach the wrong thing. Anything inside `„ “` is left alone; the surrounding
prose is translated.

So: the call is `„Foul“`, but the concept in prose is `uznaný faul`.

## Rule 2 — a naturalised loanword *is* the good Czech term

Some English terms are fully inflected as Czech nouns and verbs throughout the content, which is
exactly how Czech ultimate players speak. For these, "a good Czech term" already exists and it is
the loanword. Inventing `ztráta disku` for `turnover` would read like a textbook, not the sport.

| Term | Evidence it is naturalised |
|---|---|
| `turnover` | `turnoveru` 30 · `turnovery` 4 · `turnoverům` 1 · `turnoverem` 1 · `turnoverech` 1 |
| `marker` | `markera` 37 · `markerem` 5 · `markerovi` 3 · `markerova` · `markerův` |
| `pivot` | `pivotu` 53 · `pivotem` 2 · `pivotovou` 2 · `pivotování` · `pivotovat` |
| `contest` | verbified: `contestovaný` 32 · `contestuje` 15 · `contestovat` 5 · `contestované` 8 |
| `travel`, `pick`, `huck`, `brick`, `pull`, `check`, `stall-out`, `cutter` | standard on-field jargon with no single-word Czech equivalent |

## Translate

| Concept | Czech | Notes |
|---|---|---|
| thrower | **házeč** | Already dominant (176 vs 71). Case map: `thrower`→`házeč`, `throwera`→`házeče`, `throwerovi`→`házeči` |
| foul | **faul** | Clean stem swap across every inflection (`foulu`→`faulu`, `fouly`→`fauly`, `foulem`→`faulem`). The call `„Foul“` is exempt |
| ~~infraction~~ | **stays `infraction`** | User's call, and the source-anchored audit shows it is already consistent: 100 of 105 pairs render it `infraction`. **My first audit wrongly claimed three renderings** — see the correction below |
| ~~violation~~ | **stays `violation`** | Already consistent: 71 of 77. The 5 `porušení` cases are all "violation *of the Spirit of the Game*", which is correct Czech, not the call category |
| ~~stall count~~ | **stays `stall count`** | Already consistent: 30 of 32. My first audit wrongly flagged this too |
| breach | **prohřešek** | Distinct from *infraction* — do not merge them. **Done** for the ambiguous case: `porušení obrany/útoku` read as a breach OF the defence where the English means BY it, so those 12 became `prohřešek obrany/útoku` (masculine, so the adjectives moved too). Plain `porušení pravidel` is idiomatic and stays |
| end zone | **endzóna** | Naturalised and dominant (76 vs 9). **Done** — now 85/85. The 9 `koncová zóna` uses were introduced by batch 10, i.e. by me. The formal `koncová zóna` is deliberately kept in `rules.json` rule quotes: formal register for citations, colloquial for play description |
| goal line | **branková čára** | **Done, 54/54.** Was an uninflected foreign phrase (`na goal line`). Case follows the preposition AND the verb: `na brankové čáře` for a static location, `posune se na brankovou čáru` for motion, `od každé brankové čáry` genitive, `před svou brankovou čárou` instrumental |
| perimeter line | **obvodová čára** | **Done, 17/17.** Beware: `pomezní čára` was a hidden THIRD rendering — a football term — that the audit had been quietly bucketing as "reworded" |
| sideline | **postranní čára** | **Done, 16/17.** The exception is `ts1`, where "talk tactics with the sideline" means the BENCH, not the line — `se sidelinem` stays |
| central zone | **centrální zóna** | Already consistent |
| out of bounds | **aut** | Already dominant (129 vs 3). `aut` *is* the Czech term |

## How to check

`node scripts/cz-audit.mjs` prints the terminology spread under heading **D**. After the pass,
every concept in the *Translate* table should show a single form at 100%, and the naturalised
terms should show only themselves.

## Compound terms of art stay English — including the §17 fouls

Per the user: `marking infraction`, `travel infraction`, `marking violation` keep the rulebook's
own label, because a player looking up 18.1.1 will find the English term. The same logic covers
§17's foul families: **`offensive throwing foul`** (17.7) and **`defensive throwing foul`** (17.6).

My blanket `foul`→`faul` pass broke exactly these, producing hybrids like "Offensive throwing
faul" and "throwing fauly". Fixed: the compound keeps `foul`, and only the standalone concept is
`faul`. Descriptive Czech glosses (`faul obrany na házeče`, `faul házeče`) are deliberately kept
where they read better than the English compound — they are descriptions, not citations.

**`infraction` takes masculine agreement**: `každý marking infraction`, `ten infraction`,
`tentýž infraction`. It was split 7 masculine to 2 feminine. Note that `Je to infraction` /
`Není to infraction` are NOT agreement — `to` there is the demonstrative subject ("that is an
infraction"), which is correct Czech and was left alone.

## Correction: two findings in the first audit were my own artifacts

The first version of `scripts/cz-audit.mjs` counted Czech words and grouped them by my guess at
which were synonyms. It reported, confidently, that *infraction* had three Czech renderings and
that *stall count* was inconsistent. Both were wrong, and I raised both with the user as
decisions to make.

- **110 of 112 `prohřešek` uses translate "breach", not "infraction."** Breach and infraction are
  distinct rulebook categories that this content deliberately teaches apart. Normalising them
  would have destroyed a real distinction.
- **`počítání` mostly renders "the count" / "counting"**, not the term "stall count".

The check is now **source-anchored**: for each English term it looks only at pairs whose English
side contains that term, and reports which Czech renderings appear there. That answers "is this
concept rendered consistently" rather than "do these Czech words co-occur".

And the bucket it was hiding things in matters: **"(neither — reworded)" is not benign.** It means
the Czech used a rendering the script does not know about, which is exactly how `pomezní čára`
survived several runs. The script now prints a concrete example whenever that bucket is non-empty.

**The line-by-line fluency read is complete** — all 109 scenarios, both languages, compared field
by field. It is what caught everything the tooling could not:

| Found by reading | Where |
|---|---|
| `pomezní čára` — a football term hiding as a third rendering of perimeter line | pull, rules.json |
| `braněné` / `braněnou` — missing the long á in the participle of *bránit* | batch 10 (mine) |
| `ze předběhnutí` — wrong preposition form before a `př-` cluster | pull |
| `brick značka` vs `brick mark`, and my own `Z brick marky` case slip | pull |
| Every §17 foul-family compound broken into a hybrid by the `foul`→`faul` pass | throughout |
| `infraction` taking both masculine and feminine agreement | marking, thrower-marker |
| Three general rule statements mixing present and past tense (`nezačne … spáchal`) | travel, stall-count, receiving |
| `receiving foulsm` — a corruption my own replacement introduced | receiving |
| `Odkud huck vypustil` — a sentence missing its subject | travel |

Packages 3, 7, 8 and 9 came back clean; the defects were concentrated in 1, 2, 4, 5 and 6.

The lesson worth carrying: **more than half of these were introduced by my own bulk replacements,
not present in the original content.** Every mechanical pass over inflected Czech needs its output
read back, because a search string that is a prefix of a longer inflected form will silently
corrupt it — that failure happened twice, in `Z brick marky` and `receiving foulsm`.
