#!/usr/bin/env node
/**
 * A local, dev-only Czech review tool for the scenario content.
 *
 * `node packages/rules/authoring/review-server.mjs` then open the printed URL.
 *
 * **Why a standalone server and not a route in `applications/web`:** this
 * writes to source files. Putting a content editor behind an app route means
 * reasoning about who can reach it in a deployed build; a script that only
 * exists on a developer's machine cannot be reached at all. It also needs no
 * build step, no framework and no new dependency — plain `node:http` plus one
 * inlined HTML page.
 *
 * **What it is for.** 86 of the 109 situations are AI-written Czech that no
 * rules-literate Czech speaker has read. The failure mode is not garbled text —
 * it is fluent Czech that says the wrong thing, or a literal calque of the
 * English ("pull falls short" → "pull dopadne krátce", where a Czech player
 * would say "pull je krátký"). `cz-audit.mjs` cannot detect either, which is
 * exactly why this is a human-in-the-loop tool rather than another check.
 *
 * **Saving is surgical.** A save rewrites only that scenario's Czech strings
 * and re-serialises the file the same way biome does, so `git diff` shows the
 * translation change and nothing else. The content was normalised in a
 * preceding commit specifically so this holds.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, '../src/content/packages');
const STATE_FILE = join(HERE, 'review-state.json');
const PORT = Number(process.env.PORT ?? 4321);

const packageFiles = () =>
  readdirSync(PACKAGES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

const readPackage = (file) => JSON.parse(readFileSync(join(PACKAGES_DIR, file), 'utf8'));

/**
 * Writes the file and then hands it to biome.
 *
 * Reproducing biome's array formatting by hand looked easy and was not — it
 * keeps SHORT numeric arrays inline but expands nested ones like `kf`, and a
 * regex that got that wrong turned a one-line translation fix into a 567-line
 * diff. Shelling out costs ~200 ms per save, which is nothing for a tool a
 * human drives, and it is exact by construction rather than by approximation.
 */
const writePackage = (file, data) => {
  const full = join(PACKAGES_DIR, file);
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
  execFileSync(join(HERE, '../../../node_modules/.bin/biome'), ['check', '--write', full], {
    stdio: 'ignore',
  });
};

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { reviewed: [] };
  }
};
const writeState = (state) => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

/**
 * Every translatable string on a scenario, as a flat list of addressable
 * fields. `path` is a JSON pointer-ish array the save handler walks back down,
 * so adding a field to the content shape needs a change in exactly one place.
 */
const fieldsOf = (scenario) => {
  const out = [];
  const push = (path, label, node) => {
    if (node && typeof node.en === 'string') {
      out.push({ path, label, en: node.en, cs: node.cs ?? '' });
    }
  };
  push(['topic'], 'topic', scenario.topic);
  push(['title'], 'title', scenario.title);
  push(['role'], 'your role', scenario.role);
  push(['situation'], 'situation', scenario.situation);
  push(['question'], 'question', scenario.question);
  push(['explain'], 'explanation', scenario.explain);
  push(['note'], 'note', scenario.note);
  (scenario.fx ?? []).forEach((fx, i) => {
    push(['fx', i, 'text'], `fx ${i + 1} bubble`, fx.text);
  });
  (scenario.steps ?? []).forEach((step, si) => {
    push(['steps', si, 'q'], `step ${si + 1} question`, step.q);
    (step.opts ?? []).forEach((opt, oi) => {
      const letter = ['A', 'B', 'C', 'D'][oi] ?? String(oi + 1);
      const ok = opt.ok === true ? ' ✓' : '';
      push(['steps', si, 'opts', oi, 't'], `step ${si + 1} ${letter}${ok}`, opt.t);
      push(['steps', si, 'opts', oi, 'why'], `step ${si + 1} ${letter}${ok} why`, opt.why);
    });
  });
  return out;
};

const setAtPath = (root, path, cs) => {
  let node = root;
  for (const key of path) node = node[key];
  node.cs = cs;
};

const loadAll = () => {
  const scenarios = [];
  for (const file of packageFiles()) {
    const pkg = readPackage(file);
    for (const scenario of pkg.scenarios) {
      scenarios.push({
        id: scenario.id,
        file,
        level: pkg.level,
        packageName: pkg.name,
        fields: fieldsOf(scenario),
      });
    }
  }
  return scenarios;
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/content') {
    json(res, 200, { scenarios: loadAll(), state: readState() });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/scenario') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        const { id, file, edits } = JSON.parse(raw);
        const pkg = readPackage(file);
        const scenario = pkg.scenarios.find((s) => s.id === id);
        if (!scenario) return json(res, 404, { error: `no scenario ${id} in ${file}` });
        for (const edit of edits) setAtPath(scenario, edit.path, edit.cs);
        writePackage(file, pkg);
        json(res, 200, { ok: true, saved: edits.length });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/reviewed') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const { id, reviewed } = JSON.parse(raw);
      const state = readState();
      const set = new Set(state.reviewed);
      if (reviewed) set.add(id);
      else set.delete(id);
      state.reviewed = [...set].sort();
      writeState(state);
      json(res, 200, { ok: true, count: state.reviewed.length });
    });
    return;
  }

  res.writeHead(404).end('not found');
});

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8">
<title>Czech review — rules content</title>
<style>
  :root { color-scheme: dark; --bg:#16181d; --card:#1e2129; --line:#2c313c; --mut:#9aa3b2; --acc:#5865f2; --ok:#3ba55d; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:#e6e9ef; }
  header { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line);
           padding:12px 20px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header b { font-size:15px; }
  .sp { flex:1 }
  button { background:var(--card); color:inherit; border:1px solid var(--line); border-radius:7px;
           padding:7px 13px; cursor:pointer; font:inherit; }
  button:hover:not(:disabled) { border-color:var(--acc); }
  button:disabled { opacity:.45; cursor:default; }
  button.primary { background:var(--acc); border-color:var(--acc); }
  button.done { background:var(--ok); border-color:var(--ok); }
  main { padding:20px; max-width:1200px; margin:0 auto; }
  .row { background:var(--card); border:1px solid var(--line); border-radius:9px;
         padding:12px 14px; margin-bottom:10px; }
  .lbl { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--mut); margin-bottom:6px; }
  .en { color:#c6ccd8; margin-bottom:8px; white-space:pre-wrap; }
  textarea { width:100%; background:#12141a; color:#fff; border:1px solid var(--line);
             border-radius:6px; padding:8px 10px; font:inherit; resize:vertical; }
  textarea:focus { outline:none; border-color:var(--acc); }
  textarea.changed { border-color:#e3a008; }
  .meta { color:var(--mut); font-size:12px; }
  .jump { background:#12141a; color:inherit; border:1px solid var(--line); border-radius:7px; padding:7px; }
  #status { color:var(--mut); font-size:12px; min-width:150px; }
</style>
<header>
  <b id="title">loading…</b>
  <span class="meta" id="pos"></span>
  <span class="sp"></span>
  <select class="jump" id="jump"></select>
  <span id="status"></span>
  <button id="prev">← prev</button>
  <button id="next">next →</button>
  <button id="review"></button>
  <button class="primary" id="save">Save</button>
</header>
<main id="fields"></main>
<script>
const $ = (s) => document.querySelector(s);
let scenarios = [], reviewed = new Set(), i = 0, dirty = new Map();

const load = async () => {
  const r = await (await fetch('/api/content')).json();
  scenarios = r.scenarios; reviewed = new Set(r.state.reviewed);
  $('#jump').innerHTML = scenarios.map((s,n) =>
    '<option value="'+n+'">'+(reviewed.has(s.id)?'✓ ':'')+s.id+' · '+s.fields.find(f=>f.label==='title').en+'</option>').join('');
  render();
};

const render = () => {
  const s = scenarios[i];
  dirty = new Map();
  $('#title').textContent = s.id + ' · ' + s.packageName;
  $('#pos').textContent = (i+1) + ' of ' + scenarios.length + ' · ' + reviewed.size + ' reviewed';
  $('#jump').value = String(i);
  $('#prev').disabled = i === 0;
  $('#next').disabled = i === scenarios.length - 1;
  const isDone = reviewed.has(s.id);
  $('#review').textContent = isDone ? '✓ reviewed' : 'mark reviewed';
  $('#review').className = isDone ? 'done' : '';
  $('#fields').innerHTML = s.fields.map((f, n) =>
    '<div class="row"><div class="lbl">'+f.label+'</div>' +
    '<div class="en">'+esc(f.en)+'</div>' +
    '<textarea rows="'+rows(f.cs)+'" data-n="'+n+'">'+esc(f.cs)+'</textarea></div>').join('');
  for (const ta of document.querySelectorAll('textarea')) {
    ta.addEventListener('input', () => {
      const n = Number(ta.dataset.n);
      const orig = s.fields[n].cs;
      if (ta.value === orig) { dirty.delete(n); ta.classList.remove('changed'); }
      else { dirty.set(n, ta.value); ta.classList.add('changed'); }
      $('#status').textContent = dirty.size ? dirty.size + ' unsaved' : '';
    });
  }
  $('#status').textContent = '';
  window.scrollTo(0, 0);
};

const rows = (t) => Math.min(6, Math.max(1, Math.ceil((t||'').length / 90)));
const esc = (t) => (t||'').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const save = async () => {
  const s = scenarios[i];
  if (!dirty.size) return true;
  const edits = [...dirty].map(([n, cs]) => ({ path: s.fields[n].path, cs }));
  const res = await fetch('/api/scenario', { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: s.id, file: s.file, edits }) });
  if (!res.ok) { $('#status').textContent = 'SAVE FAILED'; return false; }
  for (const [n, cs] of dirty) s.fields[n].cs = cs;
  dirty.clear();
  for (const ta of document.querySelectorAll('textarea')) ta.classList.remove('changed');
  $('#status').textContent = 'saved';
  return true;
};

// Navigating away with unsaved edits silently loses them, so every move saves
// first — this tool is used in long sittings and that is a bad thing to learn
// the hard way.
const go = async (n) => { if (await save()) { i = n; render(); } };

$('#save').onclick = save;
$('#prev').onclick = () => go(i - 1);
$('#next').onclick = () => go(i + 1);
$('#jump').onchange = (e) => go(Number(e.target.value));
$('#review').onclick = async () => {
  const s = scenarios[i];
  const now = !reviewed.has(s.id);
  await fetch('/api/reviewed', { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: s.id, reviewed: now }) });
  if (now) reviewed.add(s.id); else reviewed.delete(s.id);
  const o = $('#jump').options[i];
  o.textContent = (now?'✓ ':'') + o.textContent.replace(/^✓ /,'');
  render();
};
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA') {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    return;
  }
  if (e.key === 'ArrowLeft' && i > 0) go(i - 1);
  if (e.key === 'ArrowRight' && i < scenarios.length - 1) go(i + 1);
});
window.addEventListener('beforeunload', (e) => { if (dirty.size) e.preventDefault(); });
load();
</script>`;

server.listen(PORT, () => {
  const total = loadAll().length;
  const done = readState().reviewed.length;
  console.log(`Czech review — ${total} scenarios, ${done} marked reviewed`);
  console.log(`  http://localhost:${PORT}`);
  console.log('  edits write straight into packages/rules/src/content/packages/*.json');
});
