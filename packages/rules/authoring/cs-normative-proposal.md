# Proposed Czech edits — NORMATIVE fields, awaiting approval

`why`, `explain` and `note` state **rulings**, each cited to a rulebook
sub-number. Improving their Czech while shifting their meaning teaches a wrong
rule, fluently — which is the exact failure the Czech review gate was raised
against. So nothing here is applied. `apply-cs-edits.mjs` refuses these paths
unless run with `--allow-normative`.

**None of these change a ruling.** Every one is terminology alignment, chosen
by counting what the content already does rather than by taste. Counts are
over all 3,715 strings.

To apply after review:

```
node packages/rules/authoring/apply-cs-edits.mjs \
  packages/rules/authoring/cs-normative-proposal.json --allow-normative
```

---

## 1. `non-minor` → `nezanedbatelný` (2 edits) — **highest confidence**

`nezanedbatelný` **30** · `výrazný` **2**. "Non-minor" is a *defined term* in the
rulebook, so a second rendering inside a ruling is worse than elsewhere — a
reader cannot tell whether a different word means a different threshold. The
descriptive uses are already aligned; these two are what remain.

| id | field | change |
|----|-------|--------|
| `s5` | explain | `iniciuje výrazný kontakt` → `iniciuje nezanedbatelný kontakt` |
| `s10` | explain | `odpovědný za výrazný kontakt` → `odpovědný za nezanedbatelný kontakt` |

## 2. `follow-through` → `dohmat` (1 edit) — **high confidence**

`dohmat` **13** · `dotažení` **2**.

⚠️ I originally had this backwards. `dohmat` looked wrong to me and I changed
two descriptive fields to `dotažení` — then counted, found `dohmat` is what the
content uses throughout, and reverted my own edits. Recording it because the
same instinct will strike whoever reviews this.

| id | field | change |
|----|-------|--------|
| `s10` | note | `kontakt při dotažení hodu` → `kontakt při dohmatu` |

## 3. `receiver` → `receiver` (1 edit) — **high confidence**

`receiver` **64** · `příjemce` **8**. The descriptive uses are already aligned.

| id | field | change |
|----|-------|--------|
| `pl6` | `steps.0.opts.0.why` | `který volají příjemci proti obraně` → `který volají receiveři proti obraně` |

## 4. `call` → `call` (10 edits) — **consistency only, lowest priority**

`call` **232** · `hláška` **14**. `hláška` is perfectly good Czech; this is
purely about the content speaking with one voice. Reasonable to decline.

`p3` explain ×2, `p3` note, `s4` note ×2, `m3` note ×2, `m4` explain ×3,
`s9` note, `f4` explain ×2, `s13` explain, `k3` explain, `s14` explain.

## 5. `spojka` for a completed pass (3 edits) — ⚠️ **needs a Czech player's call**

| id | field | current |
|----|-------|---------|
| `k3` | explain | `takže spojka platí` |
| `s14` | explain | `spojka platí` |
| `ob3` | `steps.2.opts.0.why` | `dělají běžnou spojku` |

`spojka` normally means *connection / conjunction / clutch*. It may well be
real Czech ultimate slang for a completed pass between thrower and receiver —
in which case leave it, and it is the better word. If it is not, `dokončená
přihrávka` matches how the rest of the content says it.

**I cannot settle this one by counting, and it is a judgement about how players
actually speak.** The proposed replacements are in the JSON; drop them from the
batch if `spojka` is genuine jargon.

---

## What this review did NOT cover

Pattern-matching found the above. It did **not** read all ~1,500 normative
strings for meaning. The failure mode that matters most — a dropped or
inverted negation inside a wrong option's `why`, which reads as fluent Czech
and cites a real rule — is invisible to every check here and to
`cz-audit.mjs`.

That needs a rules-literate Czech speaker reading them, which is what
`pnpm --filter @sideline/rules review:cs` exists for. The descriptive pass is
done; this is the half that cannot be automated.
