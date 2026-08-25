# Rules sources (drop them here)

Put the WFDF source documents in this folder so scenario rulings can be verified
against the actual wording instead of from memory:

| File | Why it is needed |
|---|---|
| `WFDFRulesofUltimate20252028.pdf` | **The authority.** Every ruling, stall-resumption number and restart spot is checked against this. |
| `WFDFRulesofUltimate20252028DecisionDiagrams.pdf` | The 8 flowcharts the scenarios are built on (text extraction is jumbled — reconstruct branches from the rulebook). |
| `WFDFRulesofUltimate20252028HandSignals1page.pdf` | Signal names + numbers for the `SIGNALS` db. |

A plain-text export (`rules.txt`) is equally good. PDFs can be read directly.

## Numbering caution (2025–28 edition)

Stall-count resumptions are **9.5.1** accepted defence breach → “stalling 1”;
**9.5.2** accepted offence breach → max 9; **9.5.3** contested stall-out → 8;
**9.5.4** continuation per 16.3.2 → 1; **9.5.5** all other calls incl. pick → max 6.
The decision-diagrams PDF still prints the old 2021–24 number (“9.5.4”) for max 6 —
this project cites the 2025 rulebook.

## Working with them

`pdftotext -layout` extractions sit beside each PDF — grep the `.txt`, it is far faster
than re-rendering pages:

```sh
grep -n -A4 "^ *13\.11\." rules/WFDF-Rules-of-Ultimate-2025-2028.txt
```

## Verification status

The blind batch (`st1 st2 st3 ob1 ob2 ob3 of1 sp1 tk1 tk2`) was retro-checked on
2026-08-20. `tk1`'s max-9 time-out is correct (20.3.6). Two real errors were found and
fixed: `ob1`'s out-of-bounds restart spot (13.8 — central zone, not the perimeter line) and
`st1`'s stall-out trigger (13.2.2 — when the marker *starts* saying "ten"). See CLAUDE.md.
