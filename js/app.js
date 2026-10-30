'use strict';

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MIN = 60e3;
const DAY = 86400e3;

/* ------------------------------------------------------------------ *
 * Storage — everything lives in localStorage on this device
 * ------------------------------------------------------------------ */

const Store = {
  KEY: 'taalspel.v1',
  data: null,

  defaults() {
    return {
      lang: 'nl',
      settings: { autoSpeak: true, rate: 0.9 },
      progress: { nl: {}, fr: {} },
      placement: { nl: null, fr: null },
      days: [],
    };
  },

  load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(this.KEY));
    } catch {
      saved = null;
    }
    this.data = this.merge(saved);
  },

  merge(saved) {
    const d = this.defaults();
    if (!saved || typeof saved !== 'object') return d;
    return {
      lang: LANGS[saved.lang] ? saved.lang : d.lang,
      settings: { ...d.settings, ...saved.settings },
      progress: { ...d.progress, ...saved.progress },
      placement: { ...d.placement, ...saved.placement },
      days: Array.isArray(saved.days) ? saved.days : [],
    };
  },

  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this.data));
    } catch {
      // Private mode or storage full: the session still works, it just won't persist.
    }
  },

  markActive() {
    const d = localDate();
    const days = this.data.days;
    if (days[days.length - 1] !== d) {
      days.push(d);
      this.data.days = days.slice(-400);
    }
  },

  streak() {
    const days = new Set(this.data.days);
    const d = new Date();
    if (!days.has(localDate(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(localDate(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  },
};

/* ------------------------------------------------------------------ *
 * Spaced repetition (Leitner boxes)
 *   box 0–2 learning · box 3–4 known · box 5 mastered
 * A word only moves up a box when it is due, so drilling the same
 * word ten times in one sitting doesn't fake long-term memory.
 * ------------------------------------------------------------------ */

const INTERVALS = [0, 10 * MIN, DAY, 3 * DAY, 7 * DAY, 21 * DAY];
const KNOWN_BOX = 3;
const MAX_BOX = 5;

const SRS = {
  progress(lang = Store.data.lang) {
    return Store.data.progress[lang];
  },

  status(rec) {
    if (!rec) return 'new';
    if (rec.b >= MAX_BOX) return 'mastered';
    if (rec.b >= KNOWN_BOX) return 'known';
    return 'learning';
  },

  isDue(rec, now = Date.now()) {
    return !!rec && rec.b < MAX_BOX && rec.d <= now;
  },

  record(lang, id) {
    const p = this.progress(lang);
    if (!p[id]) p[id] = { b: 0, d: 0, c: 0, w: 0 };
    return p[id];
  },

  correct(lang, id) {
    const r = this.record(lang, id);
    const now = Date.now();
    r.c++;
    if (r.d <= now) {
      r.b = Math.min(MAX_BOX, r.b + 1);
      r.d = now + INTERVALS[r.b];
    }
    r.t = now;
  },

  wrong(lang, id) {
    const r = this.record(lang, id);
    const now = Date.now();
    r.w++;
    r.b = Math.max(1, r.b - 2);
    r.d = now;
    r.t = now;
  },

  // Level test: a correct answer counts as known (checked again in a week);
  // a miss queues the word for learning straight away.
  placementCorrect(lang, id) {
    const r = this.record(lang, id);
    if (r.b < KNOWN_BOX) {
      r.b = KNOWN_BOX;
      r.d = Date.now() + INTERVALS[KNOWN_BOX + 1];
    }
    r.c++;
  },

  setKnown(lang, id) {
    const r = this.record(lang, id);
    r.b = KNOWN_BOX + 1;
    r.d = Date.now() + INTERVALS[KNOWN_BOX + 1];
  },

  reset(lang, id) {
    delete this.progress(lang)[id];
  },
};

function stats(lang = Store.data.lang) {
  const p = SRS.progress(lang);
  const now = Date.now();
  const s = { total: 0, known: 0, mastered: 0, learning: 0, due: 0, levels: {} };
  for (const L of LEVELS) s.levels[L] = { total: 0, known: 0, mastered: 0, learning: 0 };
  for (const w of WordBank.words) {
    const r = p[w.id];
    const st = SRS.status(r);
    const lv = s.levels[w.level];
    s.total++;
    lv.total++;
    if (st === 'mastered') { s.mastered++; lv.mastered++; }
    if (st === 'known' || st === 'mastered') { s.known++; lv.known++; }
    if (st === 'learning') { s.learning++; lv.learning++; }
    if (SRS.isDue(r, now)) s.due++;
  }
  return s;
}

// The first level where less than 80% of the words are known.
function currentLevel(lang = Store.data.lang) {
  const s = stats(lang);
  return LEVELS.find((L) => s.levels[L].known / s.levels[L].total < 0.8) || LEVELS[LEVELS.length - 1];
}

/* ------------------------------------------------------------------ *
 * Choosing words for a round
 * ------------------------------------------------------------------ */

// Collects up to n words, skipping any whose Dutch/French or English text
// is already on the board so every pair has exactly one right answer.
function picker(lang, n) {
  const chosen = [];
  const usedT = new Set();
  const usedE = new Set();
  return {
    chosen,
    full: () => chosen.length >= n,
    add(w) {
      if (chosen.length >= n || usedT.has(w[lang]) || usedE.has(w.en)) return;
      chosen.push(w);
      usedT.add(w[lang]);
      usedE.add(w.en);
    },
  };
}

function wordPool(level, theme) {
  return WordBank.words.filter(
    (w) => (level === 'auto' || w.level === level) && (theme === 'all' || w.theme === theme),
  );
}

// Learning rounds: words due for review first, then new words from your
// current level, then anything else so a round is always full.
function pickLearnWords(lang, level, theme, n = 6) {
  const p = SRS.progress(lang);
  const now = Date.now();
  const pool = wordPool(level, theme);
  const pick = picker(lang, n);

  const due = pool.filter((w) => SRS.isDue(p[w.id], now)).sort((a, b) => p[a.id].d - p[b.id].d);
  due.slice(0, Math.ceil(n * 0.6)).forEach(pick.add);

  const cur = level === 'auto' ? currentLevel(lang) : level;
  const i = LEVELS.indexOf(cur);
  const order = [cur, ...LEVELS.slice(0, i), ...LEVELS.slice(i + 1)];
  for (const L of order) {
    if (pick.full()) break;
    shuffle(pool.filter((w) => w.level === L && !p[w.id])).forEach(pick.add);
  }

  due.forEach(pick.add);
  shuffle(pool.filter((w) => p[w.id] && p[w.id].b < MAX_BOX)).forEach(pick.add);
  shuffle(pool).forEach(pick.add);
  return pick.chosen;
}

// Memory game: favour words you're still learning.
function pickMemoryWords(lang, level, theme, n = 6) {
  const p = SRS.progress(lang);
  const pick = picker(lang, n);
  shuffle(wordPool(level, theme).filter((w) => p[w.id] && p[w.id].b < MAX_BOX)).forEach(pick.add);
  pickLearnWords(lang, level, theme, n * 2).forEach(pick.add);
  return pick.chosen;
}

/* ------------------------------------------------------------------ *
 * Pronunciation (browser speech synthesis)
 * ------------------------------------------------------------------ */

const Speech = {
  voices: [],

  init() {
    if (!('speechSynthesis' in window)) return;
    const load = () => { this.voices = speechSynthesis.getVoices(); };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
  },

  supported() {
    return 'speechSynthesis' in window;
  },

  voiceFor(lang) {
    const norm = (v) => v.lang.replace('_', '-').toLowerCase();
    for (const pref of LANGS[lang].voices) {
      const v = this.voices.find((x) => norm(x) === pref.toLowerCase());
      if (v) return v;
    }
    return this.voices.find((x) => norm(x).startsWith(lang)) || null;
  },

  speak(text, lang = Store.data.lang) {
    if (!this.supported()) return;
    const clean = text.replace(/\(.*?\)/g, '').replace('…', '').trim();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = LANGS[lang].voices[LANGS[lang].voices.length - 1];
    const v = this.voiceFor(lang);
    if (v) u.voice = v;
    u.rate = Store.data.settings.rate;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },

  auto(text) {
    if (Store.data.settings.autoSpeak) this.speak(text);
  },
};

/* ------------------------------------------------------------------ *
 * Shared UI pieces
 * ------------------------------------------------------------------ */

const view = () => $('#view');
const lang = () => Store.data.lang;
const langName = () => LANGS[lang()].english;

const ICON_SPEAKER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';

function speakButton(text, label = 'Play pronunciation') {
  if (!Speech.supported()) return '';
  return `<button type="button" class="speak" data-speak="${esc(text)}" aria-label="${esc(label)}">${ICON_SPEAKER}</button>`;
}

function levelChips(selected, name, includeAuto = true) {
  const opts = (includeAuto ? ['auto'] : []).concat(LEVELS);
  return `<div class="chips" role="radiogroup" aria-label="Level">${opts
    .map((L) => `<button type="button" class="chip${L === selected ? ' on' : ''}" data-${name}="${L}" role="radio" aria-checked="${L === selected}">${L === 'auto' ? 'Auto' : L}</button>`)
    .join('')}</div>`;
}

function themeSelect(selected, name) {
  return `<label class="select"><span class="sr-only">Theme</span><select data-${name}>
    <option value="all">All themes</option>
    ${WordBank.themes().map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${themeLabel(t)}</option>`).join('')}
  </select></label>`;
}

function themeLabel(t) {
  return t === 'it' ? 'IT' : t.charAt(0).toUpperCase() + t.slice(1);
}

function sizeClass(text) {
  if (text.length > 34) return ' xlong';
  if (text.length > 18) return ' long';
  return '';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */

function renderHome() {
  const s = stats();
  const pl = Store.data.placement[lang()];
  const streak = Store.streak();
  const cur = currentLevel();

  const bars = LEVELS.map((L) => {
    const lv = s.levels[L];
    const pct = (n) => ((n / lv.total) * 100).toFixed(1);
    return `<div class="lvl-row">
      <div class="lvl-label"><b>${L}</b><span>${LEVEL_NAMES[L]}</span></div>
      <div class="bar" role="img" aria-label="${L}: ${lv.known} of ${lv.total} known, ${lv.learning} learning">
        <span class="seg mastered" style="width:${pct(lv.mastered)}%"></span>
        <span class="seg known" style="width:${pct(lv.known - lv.mastered)}%"></span>
        <span class="seg learning" style="width:${pct(lv.learning)}%"></span>
      </div>
      <div class="lvl-count">${lv.known}<span>/${lv.total}</span></div>
    </div>`;
  }).join('');

  const placement = pl
    ? `<div class="card placement-done">
        <div>
          <div class="eyebrow">Level test · ${fmtDate(pl.date)}</div>
          <div class="placement-line"><b>${pl.level}</b> · about <b>${pl.estimate.toLocaleString()}</b> words</div>
          ${pl.v === TEST_VERSION ? '' : '<div class="muted small">The test has been made fairer. Retake it for an up-to-date score.</div>'}
        </div>
        <a href="#/test" class="btn ghost small">Retake</a>
      </div>`
    : `<a href="#/test" class="card cta-test">
        <div>
          <div class="eyebrow">Start here</div>
          <div class="cta-title">How many ${langName()} words do you know?</div>
          <div class="muted">A 3–5 minute adaptive test from A1 up to C1.</div>
        </div>
        <span class="arrow" aria-hidden="true">→</span>
      </a>`;

  view().innerHTML = `
    <section class="card hero">
      <div class="eyebrow">${LANGS[lang()].name} ↔ English</div>
      <div class="hero-number">${s.known.toLocaleString()}<span> / ${s.total.toLocaleString()} words known</span></div>
      <div class="hero-meta">
        <span><i class="dot learning"></i>${s.learning} learning</span>
        <span><i class="dot due"></i>${s.due} due for review</span>
        <span>🔥 ${streak} day${streak === 1 ? '' : 's'}</span>
      </div>
    </section>

    ${placement}

    <section class="actions">
      <a href="#/match" class="action primary">
        <span class="action-title">Match cards</span>
        <span class="action-sub">${s.due ? `${s.due} to review · ` : ''}learning at ${cur}</span>
      </a>
      <a href="#/memory" class="action">
        <span class="action-title">Memory game</span>
        <span class="action-sub">Flip & find pairs</span>
      </a>
      <a href="#/test" class="action">
        <span class="action-title">Level test</span>
        <span class="action-sub">${pl ? 'Measure again' : 'Find your level'}</span>
      </a>
      <a href="#/words" class="action">
        <span class="action-title">Dictionary</span>
        <span class="action-sub">Browse all ${s.total.toLocaleString()} words</span>
      </a>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Progress by level</h2>
        <div class="legend">
          <span><i class="dot mastered"></i>Mastered</span>
          <span><i class="dot known"></i>Known</span>
          <span><i class="dot learning"></i>Learning</span>
        </div>
      </div>
      ${bars}
    </section>
  `;
}

/* ------------------------------------------------------------------ *
 * Match cards
 * ------------------------------------------------------------------ */

const match = { level: 'auto', theme: 'all', words: [], done: new Set(), missed: new Set(), sel: { left: null, right: null }, busy: false, round: 0 };

function renderMatch() {
  view().innerHTML = `
    <div class="page-head">
      <h1>Match cards</h1>
      <p class="muted">Tap a ${langName()} word, then its English meaning.</p>
    </div>
    <div class="toolbar">
      ${levelChips(match.level, 'match-level')}
      ${themeSelect(match.theme, 'match-theme')}
    </div>
    <div id="match-area"></div>
  `;
  newMatchRound();
}

function newMatchRound() {
  match.words = pickLearnWords(lang(), match.level, match.theme);
  match.done = new Set();
  match.missed = new Set();
  match.sel = { left: null, right: null };
  match.busy = false;
  match.round++;

  if (match.words.length < 2) {
    $('#match-area').innerHTML = '<div class="card empty">Not enough words for this filter. Try another theme or level.</div>';
    return;
  }

  const left = shuffle(match.words);
  const right = shuffle(match.words);
  const p = SRS.progress();
  const tag = (w) => (p[w.id] ? '' : '<span class="new-tag">new</span>');

  $('#match-area').innerHTML = `
    <div class="match-board">
      <div class="col">${left.map((w) => `<button type="button" class="tile target${sizeClass(w[lang()])}" data-side="left" data-id="${esc(w.id)}">${tag(w)}${esc(w[lang()])}</button>`).join('')}</div>
      <div class="col">${right.map((w) => `<button type="button" class="tile${sizeClass(w.en)}" data-side="right" data-id="${esc(w.id)}">${esc(w.en)}</button>`).join('')}</div>
    </div>
    <div id="match-result"></div>
  `;
}

function onMatchTile(tile) {
  if (match.busy || tile.classList.contains('matched')) return;
  const side = tile.dataset.side;
  const id = tile.dataset.id;

  $$(`.tile[data-side="${side}"].selected`).forEach((t) => t.classList.remove('selected'));
  tile.classList.add('selected');
  match.sel[side] = id;
  if (side === 'left') Speech.auto(WordBank.words.find((w) => w.id === id)[lang()]);

  const { left, right } = match.sel;
  if (left === null || right === null) return;

  const lt = $(`.tile[data-side="left"][data-id="${CSS.escape(left)}"]`);
  const rt = $(`.tile[data-side="right"][data-id="${CSS.escape(right)}"]`);
  match.sel = { left: null, right: null };
  Store.markActive();

  if (left === right) {
    lt.classList.replace('selected', 'matched');
    rt.classList.replace('selected', 'matched');
    lt.disabled = rt.disabled = true;
    match.done.add(left);
    if (match.missed.has(left)) SRS.wrong(lang(), left);
    else SRS.correct(lang(), left);
    Store.save();
    if (match.done.size === match.words.length) finishMatch();
  } else {
    match.missed.add(left);
    match.busy = true;
    lt.classList.add('wrong');
    rt.classList.add('wrong');
    setTimeout(() => {
      lt.classList.remove('wrong', 'selected');
      rt.classList.remove('wrong', 'selected');
      match.busy = false;
    }, 550);
  }
}

function finishMatch() {
  const p = SRS.progress();
  const firstTry = match.words.length - match.missed.size;
  const s = stats();
  const rows = match.words.map((w) => {
    const ok = !match.missed.has(w.id);
    const st = SRS.status(p[w.id]);
    return `<li class="${ok ? 'ok' : 'miss'}">
      <span class="mark" aria-hidden="true">${ok ? '✓' : '✗'}</span>
      <span class="rw-t">${esc(w[lang()])}</span>
      <span class="rw-e">${esc(w.en)}</span>
      <span class="status-pill ${st}">${st}</span>
      ${speakButton(w[lang()])}
    </li>`;
  }).join('');

  $('#match-result').innerHTML = `
    <div class="card result">
      <div class="result-head">
        <div>
          <div class="result-score">${firstTry}/${match.words.length}</div>
          <div class="muted">right on the first try</div>
        </div>
        <div class="result-total"><b>${s.known.toLocaleString()}</b> words known<br><span class="muted">${s.due} due for review</span></div>
      </div>
      <ul class="round-words">${rows}</ul>
      <button type="button" class="btn primary block" data-action="next-match">Next round →</button>
    </div>
  `;
  $('#match-result [data-action="next-match"]').focus({ preventScroll: true });
  $('#match-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * Memory game
 * ------------------------------------------------------------------ */

const memory = { level: 'auto', theme: 'all', cards: [], open: [], matched: 0, moves: 0, busy: false, started: 0 };

function renderMemory() {
  view().innerHTML = `
    <div class="page-head">
      <h1>Memory game</h1>
      <p class="muted">Flip two cards to find a ${langName()}–English pair. Practice only, so it doesn't change your progress.</p>
    </div>
    <div class="toolbar">
      ${levelChips(memory.level, 'mem-level')}
      ${themeSelect(memory.theme, 'mem-theme')}
    </div>
    <div class="mem-status"><span id="mem-moves">0 moves</span><button type="button" class="btn ghost small" data-action="new-memory">New game</button></div>
    <div id="mem-area"></div>
  `;
  newMemoryGame();
}

function newMemoryGame() {
  const words = pickMemoryWords(lang(), memory.level, memory.theme);
  memory.cards = shuffle(words.flatMap((w) => [
    { id: w.id, kind: 't', text: w[lang()] },
    { id: w.id, kind: 'e', text: w.en },
  ]));
  memory.open = [];
  memory.matched = 0;
  memory.moves = 0;
  memory.busy = false;
  memory.started = Date.now();
  $('#mem-moves').textContent = '0 moves';

  if (words.length < 2) {
    $('#mem-area').innerHTML = '<div class="card empty">Not enough words for this filter. Try another theme or level.</div>';
    return;
  }

  $('#mem-area').innerHTML = `<div class="mem-grid">${memory.cards.map((c, i) => `
    <button type="button" class="mem-card ${c.kind === 't' ? 'target' : 'english'}" data-mem="${i}" aria-label="Hidden card">
      <span class="mem-inner">
        <span class="mem-back" aria-hidden="true"></span>
        <span class="mem-front${sizeClass(c.text)}"><small>${c.kind === 't' ? LANGS[lang()].code : 'EN'}</small>${esc(c.text)}</span>
      </span>
    </button>`).join('')}</div>`;
}

function onMemoryCard(el) {
  const i = Number(el.dataset.mem);
  const card = memory.cards[i];
  if (memory.busy || el.classList.contains('flipped')) return;

  el.classList.add('flipped');
  el.setAttribute('aria-label', card.text);
  if (card.kind === 't') Speech.auto(card.text);
  memory.open.push(i);
  if (memory.open.length < 2) return;

  memory.moves++;
  $('#mem-moves').textContent = `${memory.moves} move${memory.moves === 1 ? '' : 's'}`;
  Store.markActive();

  const [a, b] = memory.open;
  memory.open = [];
  const ea = $(`[data-mem="${a}"]`);
  const eb = $(`[data-mem="${b}"]`);

  if (memory.cards[a].id === memory.cards[b].id) {
    ea.classList.add('matched');
    eb.classList.add('matched');
    memory.matched++;
    if (memory.matched * 2 === memory.cards.length) finishMemory();
  } else {
    memory.busy = true;
    setTimeout(() => {
      for (const e of [ea, eb]) {
        e.classList.remove('flipped');
        e.setAttribute('aria-label', 'Hidden card');
      }
      memory.busy = false;
    }, 1000);
  }
  Store.save();
}

function finishMemory() {
  const secs = Math.round((Date.now() - memory.started) / 1000);
  const pairs = memory.cards.length / 2;
  const area = $('#mem-area');
  area.insertAdjacentHTML('beforeend', `
    <div class="card result">
      <div class="result-head">
        <div>
          <div class="result-score">${memory.moves} moves</div>
          <div class="muted">${pairs} pairs in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}${memory.moves === pairs ? ' · perfect!' : ''}</div>
        </div>
      </div>
      <button type="button" class="btn primary block" data-action="new-memory">Play again →</button>
    </div>
  `);
  $('.result', area).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * Level test (adaptive placement)
 * 10 words per level, multiple choice. Keeps climbing while you get at
 * least half right, then estimates your vocabulary from the scores.
 * Only words you can't guess from English are asked: French shares far
 * more look-alikes with English (la négociation, la majorité) than Dutch
 * does, which otherwise inflates the French score.
 * ------------------------------------------------------------------ */

const TEST_PER_LEVEL = 10;
const TEST_PASS = 5;
const TEST_VERSION = 2;
const test = { phase: 'intro', levelIdx: 0, q: 0, questions: [], results: {}, busy: false, lang: null };

function renderTest() {
  if (test.phase === 'question') return renderTestQuestion();
  if (test.phase === 'done') return renderTestResult();

  const pl = Store.data.placement[lang()];
  view().innerHTML = `
    <div class="page-head">
      <h1>Level test</h1>
      <p class="muted">${LANGS[lang()].name} → English</p>
    </div>
    <div class="card intro">
      <ul class="intro-list">
        <li><b>${TEST_PER_LEVEL} words per level</b>, starting at A1 and climbing to C1.</li>
        <li>Pick the English meaning. <b>Don't guess:</b> tap “I don't know”. Guesses make the estimate less accurate.</li>
        <li>Words that look like English (<i>${lang() === 'fr' ? 'la solution, le progrès' : 'de familie, het water'}</i>) are left out because you could guess them, so Dutch and French scores are comparable.</li>
        <li>The test stops when a level gets too hard, so it takes 3–5 minutes.</li>
        <li>Words you get right count as known. Words you miss go straight into your Match practice.</li>
      </ul>
      ${pl ? `<p class="muted">Last result: <b>${pl.level}</b>, about ${pl.estimate.toLocaleString()} words (${fmtDate(pl.date)})${pl.v === TEST_VERSION ? '' : ', scored with the old test'}.</p>` : ''}
      <button type="button" class="btn primary block" data-action="start-test">Start the test</button>
    </div>
  `;
}

function startTest() {
  Object.assign(test, { phase: 'question', levelIdx: 0, q: 0, results: {}, lang: lang() });
  buildTestLevel();
  renderTestQuestion();
}

function buildTestLevel() {
  const L = LEVELS[test.levelIdx];
  const pool = WordBank.inLevel(L);
  const isVerb = (w) => w.en.startsWith('to ');
  const pick = picker(test.lang, TEST_PER_LEVEL);
  shuffle(WordBank.testable(L, test.lang)).forEach(pick.add);

  test.questions = pick.chosen.map((w) => {
    // Distractors of the same kind (verb vs. not) so the answer can't be spotted by shape.
    const same = shuffle(pool.filter((x) => x.en !== w.en && x[test.lang] !== w[test.lang] && isVerb(x) === isVerb(w)));
    const opts = [w.en];
    for (const x of same) {
      if (opts.length === 4) break;
      if (!opts.includes(x.en)) opts.push(x.en);
    }
    return { word: w, options: shuffle(opts) };
  });
  test.q = 0;
  test.results[L] = { c: 0, w: 0, s: 0, n: test.questions.length };
}

function renderTestQuestion() {
  const L = LEVELS[test.levelIdx];
  const { word, options } = test.questions[test.q];
  const done = test.levelIdx * TEST_PER_LEVEL + test.q;
  const total = LEVELS.length * TEST_PER_LEVEL;
  const text = word[test.lang];

  view().innerHTML = `
    <div class="test-progress">
      <div class="test-meta"><span class="level-badge">${L}</span><span class="muted">${LEVEL_NAMES[L]} · ${test.q + 1}/${TEST_PER_LEVEL}</span><button type="button" class="link" data-action="quit-test">Quit</button></div>
      <div class="bar thin"><span class="seg known" style="width:${(done / total) * 100}%"></span></div>
    </div>
    <div class="card question">
      <div class="q-word${sizeClass(text)}">${esc(text)}</div>
      ${speakButton(text)}
      <div class="q-hint muted">What does this mean?</div>
    </div>
    <div class="options">
      ${options.map((o, i) => `<button type="button" class="option" data-answer="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}
      <button type="button" class="option dunno" data-answer=""><kbd>0</kbd>I don't know</button>
    </div>
  `;
  test.busy = false;
}

function answerTest(btn) {
  if (test.busy) return;
  test.busy = true;
  const L = LEVELS[test.levelIdx];
  const { word } = test.questions[test.q];
  const answer = btn.dataset.answer;
  const r = test.results[L];
  Store.markActive();

  let delay = 650;
  if (answer === word.en) {
    r.c++;
    btn.classList.add('right');
    SRS.placementCorrect(test.lang, word.id);
  } else {
    if (answer === '') r.s++;
    else r.w++;
    btn.classList.add(answer === '' ? 'skipped' : 'wrong');
    $$('.option').forEach((o) => { if (o.dataset.answer === word.en) o.classList.add('right'); });
    SRS.wrong(test.lang, word.id);
    delay = 1400;
  }
  Store.save();

  setTimeout(() => {
    if (test.q + 1 < test.questions.length) {
      test.q++;
      return renderTestQuestion();
    }
    if (r.c >= TEST_PASS && test.levelIdx + 1 < LEVELS.length) {
      test.levelIdx++;
      buildTestLevel();
      return renderTestQuestion();
    }
    finishTest();
  }, delay);
}

// Share of a level you know, corrected for lucky guesses on 4 options.
function levelShare(r) {
  if (!r || !r.n) return 0;
  return Math.max(0, Math.min(1, (r.c - r.w / 3) / r.n));
}

function finishTest() {
  let estimate = 0;
  let level = null;
  let climbing = true;
  for (const L of LEVELS) {
    const share = levelShare(test.results[L]);
    estimate += Math.round(share * WordBank.inLevel(L).length);
    if (climbing && share >= 0.6) level = L;
    else climbing = false;
  }
  Store.data.placement[test.lang] = {
    v: TEST_VERSION,
    date: Date.now(),
    estimate,
    level: level || 'Pre-A1',
    results: test.results,
  };
  Store.save();
  test.phase = 'done';
  renderTestResult();
}

function renderTestResult() {
  const l = test.lang || lang();
  const pl = Store.data.placement[l];
  if (!pl) {
    test.phase = 'intro';
    return renderTest();
  }
  const rows = LEVELS.map((L) => {
    const r = pl.results[L];
    const size = WordBank.inLevel(L).length;
    const share = levelShare(r);
    return `<div class="lvl-row">
      <div class="lvl-label"><b>${L}</b><span>${r ? `${r.c}/${r.n} right` : 'not reached'}</span></div>
      <div class="bar"><span class="seg known" style="width:${(share * 100).toFixed(1)}%"></span></div>
      <div class="lvl-count">≈${Math.round(share * size)}<span>/${size}</span></div>
    </div>`;
  }).join('');

  const msg = pl.level === 'Pre-A1'
    ? 'A clean slate. Match cards will start you at A1.'
    : `Solid through <b>${pl.level}</b> (${LEVEL_NAMES[pl.level]}). Match cards will pick up where your gaps start.`;

  view().innerHTML = `
    <div class="page-head"><h1>Your result</h1><p class="muted">${LANGS[l].name} → English</p></div>
    <section class="card hero">
      <div class="eyebrow">Estimated vocabulary</div>
      <div class="hero-number">≈${pl.estimate.toLocaleString()}<span> of ${WordBank.words.length.toLocaleString()} words</span></div>
      <p class="hero-msg">${msg}</p>
      <p class="hero-msg small">Words that look like English weren't asked, so guessing from English doesn't inflate this score.</p>
    </section>
    <section class="card">${rows}</section>
    <div class="btn-row">
      <a href="#/match" class="btn primary">Start learning →</a>
      <button type="button" class="btn ghost" data-action="start-test">Retake</button>
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * Dictionary
 * ------------------------------------------------------------------ */

const dict = { q: '', level: 'all', status: 'all', theme: 'all', limit: 150 };
const STATUS_FILTERS = [['all', 'All'], ['new', 'New'], ['learning', 'Learning'], ['known', 'Known']];

function renderWords() {
  view().innerHTML = `
    <div class="page-head">
      <h1>Dictionary</h1>
      <p class="muted">Tap a status to mark a word you already know.</p>
    </div>
    <div class="dict-filters">
      <input type="search" class="search" placeholder="Search ${langName()} or English…" value="${esc(dict.q)}" data-dict-q aria-label="Search words">
      <div class="toolbar">
        <div class="chips">${['all', ...LEVELS].map((L) => `<button type="button" class="chip${dict.level === L ? ' on' : ''}" data-dict-level="${L}">${L === 'all' ? 'All' : L}</button>`).join('')}</div>
      </div>
      <div class="toolbar">
        <div class="chips">${STATUS_FILTERS.map(([k, label]) => `<button type="button" class="chip${dict.status === k ? ' on' : ''}" data-dict-status="${k}">${label}</button>`).join('')}</div>
        ${themeSelect(dict.theme, 'dict-theme')}
      </div>
    </div>
    <div id="dict-list"></div>
  `;
  renderWordList();
}

function renderWordList() {
  const p = SRS.progress();
  const q = dict.q.trim().toLowerCase();
  const matches = WordBank.words.filter((w) => {
    if (dict.level !== 'all' && w.level !== dict.level) return false;
    if (dict.theme !== 'all' && w.theme !== dict.theme) return false;
    const st = SRS.status(p[w.id]);
    if (dict.status === 'known' && st !== 'known' && st !== 'mastered') return false;
    if (dict.status === 'new' && st !== 'new') return false;
    if (dict.status === 'learning' && st !== 'learning') return false;
    return !q || w.en.toLowerCase().includes(q) || w[lang()].toLowerCase().includes(q);
  });

  const rows = matches.slice(0, dict.limit).map((w) => {
    const st = SRS.status(p[w.id]);
    return `<li class="dict-row">
      ${speakButton(w[lang()])}
      <div class="dict-words"><span class="dt">${esc(w[lang()])}</span><span class="de">${esc(w.en)}</span></div>
      <span class="level-badge">${w.level}</span>
      <button type="button" class="status-pill ${st}" data-toggle-known="${esc(w.id)}" aria-label="${st === 'new' || st === 'learning' ? 'Mark as known' : 'Reset to new'}">${st}</button>
    </li>`;
  }).join('');

  $('#dict-list').innerHTML = `
    <div class="muted count">${matches.length.toLocaleString()} word${matches.length === 1 ? '' : 's'}</div>
    <ul class="dict">${rows || '<li class="empty">No words match.</li>'}</ul>
    ${matches.length > dict.limit ? `<button type="button" class="btn ghost block" data-action="more-words">Show more</button>` : ''}
  `;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function renderSettings() {
  const st = Store.data.settings;
  view().innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <section class="card settings">
      <h2>Pronunciation</h2>
      ${Speech.supported() ? `
        <label class="row-toggle"><span>Say ${langName()} words out loud when tapped</span><input type="checkbox" data-setting="autoSpeak"${st.autoSpeak ? ' checked' : ''}></label>
        <label class="row-range"><span>Speed</span><input type="range" min="0.6" max="1.2" step="0.1" value="${st.rate}" data-setting="rate"></label>
        <button type="button" class="btn ghost small" data-action="test-voice">Test voice</button>
        <p class="muted small">The voice comes from your device. If it sounds wrong, install a ${langName()} voice in your phone or computer's speech settings.</p>
      ` : '<p class="muted">This browser doesn\'t support speech.</p>'}
    </section>
    <section class="card settings">
      <h2>Your progress</h2>
      <p class="muted small">Progress is saved in this browser only. Export it to move to another device or keep a backup.</p>
      <div class="btn-row">
        <button type="button" class="btn ghost small" data-action="export">Export backup</button>
        <label class="btn ghost small file-btn">Import backup<input type="file" accept="application/json,.json" data-import hidden></label>
      </div>
      <button type="button" class="btn danger small" data-action="reset-lang">Reset ${langName()} progress</button>
    </section>
    <section class="card settings">
      <h2>About</h2>
      <p class="muted small">${WordBank.words.length.toLocaleString()} words per language across CEFR levels A1–C1, grouped into ${WordBank.themes().length} themes. Levels are a practical guide, not an official list. Spaced repetition brings words back after 10 minutes, 1, 3, 7 and 21 days. A word counts as <b>known</b> after 3 successful reviews and <b>mastered</b> after 5.</p>
    </section>
  `;
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(Store.data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `taalspel-backup-${localDate()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importProgress(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed.progress !== 'object') throw new Error('bad file');
      Store.data = Store.merge(parsed);
      Store.save();
      toast('Backup imported');
      route();
    } catch {
      toast('That file is not a Taalspel backup');
    }
  };
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ *
 * Router & events
 * ------------------------------------------------------------------ */

const ROUTES = {
  '': ['home', renderHome],
  match: ['match', renderMatch],
  memory: ['memory', renderMemory],
  test: ['test', renderTest],
  words: ['words', renderWords],
  settings: ['', renderSettings],
};

function route() {
  const key = location.hash.replace(/^#\/?/, '');
  const [tab, render] = ROUTES[key] || ROUTES[''];
  document.body.dataset.lang = lang();
  $$('[data-set-lang]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.setLang === lang()));
  $$('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  test.phase = 'intro'; // navigating away (or switching language) abandons a test in progress
  render();
}

function setLang(l) {
  if (l === lang()) return;
  Store.data.lang = l;
  Store.save();
  route();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;

  if (d.speak !== undefined) return Speech.speak(d.speak);
  if (d.setLang) return setLang(d.setLang);
  if (d.side) return onMatchTile(t);
  if (d.mem !== undefined) return onMemoryCard(t);
  if (d.answer !== undefined) return answerTest(t);

  if (d.matchLevel) { match.level = d.matchLevel; return renderMatch(); }
  if (d.memLevel) { memory.level = d.memLevel; return renderMemory(); }
  if (d.dictLevel) { dict.level = d.dictLevel; dict.limit = 150; return renderWords(); }
  if (d.dictStatus) { dict.status = d.dictStatus; dict.limit = 150; return renderWords(); }

  if (d.toggleKnown) {
    const st = SRS.status(SRS.progress()[d.toggleKnown]);
    if (st === 'new' || st === 'learning') SRS.setKnown(lang(), d.toggleKnown);
    else SRS.reset(lang(), d.toggleKnown);
    Store.save();
    return renderWordList();
  }

  switch (d.action) {
    case 'next-match': return newMatchRound();
    case 'new-memory': return newMemoryGame();
    case 'start-test': return startTest();
    case 'quit-test': test.phase = 'intro'; return renderTest();
    case 'more-words': dict.limit += 300; return renderWordList();
    case 'test-voice': return Speech.speak(lang() === 'nl' ? 'Goedemorgen! Hoe gaat het met je?' : 'Bonjour ! Comment allez-vous ?');
    case 'export': return exportProgress();
    case 'reset-lang':
      if (confirm(`Erase all ${langName()} progress on this device? This can't be undone.`)) {
        Store.data.progress[lang()] = {};
        Store.data.placement[lang()] = null;
        Store.save();
        toast(`${langName()} progress reset`);
      }
      return undefined;
    default: return undefined;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-match-theme]')) { match.theme = t.value; renderMatch(); }
  if (t.matches('[data-mem-theme]')) { memory.theme = t.value; renderMemory(); }
  if (t.matches('[data-dict-theme]')) { dict.theme = t.value; dict.limit = 150; renderWordList(); }
  if (t.matches('[data-setting="autoSpeak"]')) { Store.data.settings.autoSpeak = t.checked; Store.save(); }
  if (t.matches('[data-setting="rate"]')) { Store.data.settings.rate = Number(t.value); Store.save(); }
  if (t.matches('[data-import]') && t.files[0]) importProgress(t.files[0]);
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-dict-q]')) {
    dict.q = e.target.value;
    dict.limit = 150;
    renderWordList();
  }
});

// Keyboard: 1–4 pick an answer in the level test, 0 is "I don't know".
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (test.phase === 'question' && /^[0-4]$/.test(e.key)) {
    const btn = e.key === '0' ? $('.option.dunno') : $$('.option:not(.dunno)')[Number(e.key) - 1];
    if (btn) btn.click();
  }
});

window.addEventListener('hashchange', route);

Store.load();
Speech.init();
route();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
