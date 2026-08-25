/*
 * Czech translation audit — ADVISORY, not a pass/fail test.
 *
 * The Czech is AI-written and unreviewed beyond the first ~23 situations. A human read of every
 * string is 3158 EN/CS pairs, so this narrows where to look. It does NOT certify the Czech.
 *
 * Three mechanical checks (numbers, rule citations, suspicious brevity) and one judgement aid
 * (terminology consistency). Run: `node scripts/cz-audit.mjs`
 *
 * ON FALSE POSITIVES — read before acting on output. When this was first run over 109 situations
 * it produced 18 numeric flags and every one was a false positive:
 *   - Czech renders quantities as words where English uses digits ("maximum 6" / "maximum šest").
 *   - Czech says "oba" (both) where English says "the two".
 *   - The trainer deliberately keeps the marker's spoken call in English, so „ten" and
 *     „stalling six" appear verbatim in Czech text and are correct.
 * The checks below compare numeric VALUES rather than surface forms to suppress most of that,
 * but treat every flag as "look at this", never as "this is wrong".
 *
 * It did earn its keep twice: it found `s12`'s "Odkud huck vypustil" (missing subject — reads
 * "from where the huck released") and the terminology spread below.
 */
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/content/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d\d-/.test(f))
  .sort();

/** Every translatable EN/CS pair in the content, tagged with where it came from. */
const pairs = [];
for (const f of files) {
  for (const sc of JSON.parse(readFileSync(new URL(f, dir), 'utf8')).scenarios) {
    for (const fld of ['situation', 'question', 'explain', 'note']) {
      if (sc[fld]) pairs.push({ id: sc.id, field: fld, en: sc[fld].en, cs: sc[fld].cs });
    }
    for (const [i, st] of (sc.steps ?? []).entries()) {
      pairs.push({ id: sc.id, field: `step${i + 1}.q`, en: st.q.en, cs: st.q.cs });
      for (const [j, o] of st.opts.entries()) {
        const tag = o.ok ? 'ok' : `opt${j + 1}`;
        pairs.push({ id: sc.id, field: `step${i + 1}.${tag}`, en: o.t.en, cs: o.t.cs });
        pairs.push({ id: sc.id, field: `step${i + 1}.${tag}.why`, en: o.why.en, cs: o.why.cs });
      }
    }
  }
}

const RULE = /\b\d{1,2}(?:\.\d{1,2}){1,3}\b/g;
const CZ = 'a-záčďéěíňóřšťúůýž';

const EN_WORDS = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fifteen: 15,
  twenty: 20,
};
/* Czech is inflected, so these are stems, longest first — 'osmi' must be consumed before 'osm'. */
const CZ_WORDS = [
  ['sedmdesátipěti', 75],
  ['sedmdesát pět', 75],
  ['sedmdesát', 70],
  ['patnáct', 15],
  ['třinác', 13],
  ['dvacet', 20],
  ['desít', 10],
  ['deseti', 10],
  ['deset', 10],
  ['devít', 9],
  ['devíti', 9],
  ['devět', 9],
  ['osmič', 8],
  ['osmi', 8],
  ['osm', 8],
  ['sedmi', 7],
  ['sedm', 7],
  ['šestk', 6],
  ['šesti', 6],
  ['šest', 6],
  ['pěti', 5],
  ['pět', 5],
  ['čtyř', 4],
  ['třemi', 3],
  ['tří', 3],
  ['třech', 3],
  ['tři', 3],
  ['dvou', 2],
  ['dvě', 2],
  ['dva', 2],
];

const digits = (s) => {
  const out = [];
  for (const m of s.replace(RULE, ' ').matchAll(/(?<![\d.])(\d{1,3})(?![\d])/g)) out.push(+m[1]);
  return out;
};

const valuesEn = (t) => {
  const bag = new Map();
  const add = (n, k = 1) => bag.set(n, (bag.get(n) ?? 0) + k);
  for (const d of digits(t)) add(d);
  let low = t.replace(RULE, ' ').toLowerCase();
  for (const _ of low.matchAll(/\bseventy[- ]five\b/g)) add(75);
  low = low.replace(/\bseventy[- ]five\b/g, ' ');
  for (const _ of low.matchAll(/\bseventy\b/g)) add(70);
  for (const [w, n] of Object.entries(EN_WORDS)) {
    for (const _ of low.matchAll(new RegExp(`\\b${w}\\b`, 'g'))) add(n);
  }
  return bag;
};

const valuesCs = (t) => {
  const bag = new Map();
  const add = (n, k = 1) => bag.set(n, (bag.get(n) ?? 0) + k);
  for (const d of digits(t)) add(d);
  let low = t.replace(RULE, ' ').toLowerCase();
  for (const [stem, n] of CZ_WORDS) {
    const re = new RegExp(`(?<![0-9${CZ}])${stem}`, 'g');
    const hits = [...low.matchAll(re)];
    if (hits.length) {
      add(n, hits.length);
      low = low.replace(re, ' ');
    }
  }
  return bag;
};

const numeric = [],
  citations = [],
  brief = [];
for (const p of pairs) {
  const a = valuesEn(p.en),
    b = valuesCs(p.cs);
  // value 1 is excluded: English "one" is usually the pronoun, not a quantity.
  const missing = [...a].filter(([k, n]) => k !== 1 && (b.get(k) ?? 0) < n);
  if (missing.length) numeric.push({ ...p, missing });
  const ra = (p.en.match(RULE) ?? []).sort(),
    rb = (p.cs.match(RULE) ?? []).sort();
  if (ra.join() !== rb.join()) citations.push({ ...p, ra, rb });
  if (p.en.length > 40 && p.cs.length / p.en.length < 0.55) brief.push(p);
}

/* Terminology — SOURCE-ANCHORED, and it must stay that way.
 *
 * The first version of this check counted Czech words and grouped them by my own guess at which
 * ones were synonyms. That produced two confident, wrong findings: it reported that "infraction"
 * had three Czech renderings and that "stall count" was inconsistent. Both were artifacts.
 *   - 110 of 112 'prohřešek' uses translate BREACH, not infraction. Breach and infraction are
 *     distinct rulebook categories that the content deliberately teaches apart, so "normalising"
 *     them would have destroyed a real distinction.
 *   - 'počítání' mostly renders "the count" / "counting", not the term "stall count".
 *
 * So: for each ENGLISH term, look only at pairs whose English side contains it, and report which
 * Czech renderings show up there. That answers "is this concept rendered consistently?" instead
 * of "do these Czech words co-occur?".
 *
 * Czech ultimate also genuinely borrows English jargon (marker, pivot, travel, pick, turnover,
 * endzóna), so an English term surviving in Czech is not itself a defect — two renderings of one
 * concept is. See czech-terminology.md. */
const CONCEPTS = {
  thrower: ['házeč', 'thrower'],
  foul: ['faul', 'foul'],
  breach: ['prohřeš', 'porušení', 'přestupek'],
  infraction: ['infraction', 'prohřeš', 'přestupek'],
  violation: ['violation', 'porušení'],
  'stall count': ['stall count', 'počítání'],
  'end zone': ['endzón', 'koncov'],
  'goal line': ['goal line', 'brankov'],
  'perimeter line': ['perimeter line', 'obvodov'],
  sideline: ['sideline', 'postranní'],
  'out of bounds': ['aut', 'mimo hřiště', 'out of bounds'],
  contest: ['contest', 'nesouhlas', 'rozporov'],
};

console.log(`scanned ${pairs.length} EN/CS pairs\n`);
console.log(`A. numeric value missing in Czech — ${numeric.length} (expect false positives)`);
for (const n of numeric) {
  console.log(`   ${n.id} · ${n.field}  missing ${JSON.stringify(n.missing)}`);
  console.log(`      EN ${n.en.slice(0, 150)}`);
  console.log(`      CS ${n.cs.slice(0, 150)}`);
}
console.log(`\nB. rule citations differ — ${citations.length}`);
for (const c of citations) console.log(`   ${c.id} · ${c.field}  EN [${c.ra}] CS [${c.rb}]`);
console.log(
  `\nC. Czech under 55% of English length — ${brief.length} (Czech is legitimately terser)`,
);
for (const b of brief) {
  console.log(`   ${b.id} · ${b.field}`);
  console.log(`      EN ${b.en}`);
  console.log(`      CS ${b.cs}`);
}
console.log('\nD. terminology consistency — for each ENGLISH term, how the Czech renders it');
for (const [concept, variants] of Object.entries(CONCEPTS)) {
  const re = new RegExp(`(?<![a-z])${concept.replace(/ /g, '\\s+')}`, 'i');
  const relevant = pairs.filter((p) => re.test(p.en));
  if (!relevant.length) continue;
  const tally = new Map();
  for (const p of relevant) {
    const low = p.cs.toLowerCase();
    const found = variants.filter((v) => low.includes(v)).sort();
    const key = found.length ? found.join(' + ') : '(neither — reworded)';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const rows = [...tally].sort((a, b) => b[1] - a[1]);
  const flag = rows.filter(([k]) => !k.startsWith('(')).length > 1 ? '  <-- MIXED' : '';
  console.log(`   ${concept} — ${relevant.length} pairs${flag}`);
  for (const [k, n] of rows.slice(0, 4)) {
    console.log(`      ${String(n).padStart(4)}  ${k}`);
  }
  /* "(neither)" is NOT benign — it means the Czech used a rendering this script does not know
   * about. That is exactly how `pomezní čára` (a football term) hid as a third rendering of
   * perimeter line through several runs: it was counted here and waved through. So print an
   * example whenever the bucket is non-empty, to make it inspectable rather than dismissable. */
  const unknown = relevant.filter((p) => !variants.some((v) => p.cs.toLowerCase().includes(v)));
  if (unknown.length) {
    const ex = unknown[0];
    console.log(`        ^ inspect: ${ex.id} · ${ex.field}`);
    console.log(`          EN ${ex.en.slice(0, 100)}`);
    console.log(`          CS ${ex.cs.slice(0, 100)}`);
  }
}
