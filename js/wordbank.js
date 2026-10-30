'use strict';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];

const LEVEL_NAMES = {
  A1: 'Beginner',
  A2: 'Elementary',
  B1: 'Intermediate',
  B2: 'Upper intermediate',
  C1: 'Advanced',
};

const LANGS = {
  nl: { name: 'Nederlands', english: 'Dutch', code: 'NL', voices: ['nl-BE', 'nl-NL'] },
  fr: { name: 'Français', english: 'French', code: 'FR', voices: ['fr-BE', 'fr-FR'] },
};

// Reduces a word to a comparable stem: no article, "to", accents or notes,
// so "la responsabilité" compares as "responsabilite".
function stem(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/^(to |the |de |het |le |la |les |l'|un |une )/, '')
    .replace(/[^a-z ]/g, '')
    .trim();
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// True when an English speaker can guess the word without knowing the language,
// e.g. la négociation ↔ negotiation or de familie ↔ family. Compares the first
// seven letters so different endings (-ité/-ity, -ie/-y) don't hide the match.
function looksLikeEnglish(en, other) {
  const a = stem(en);
  const b = stem(other);
  const k = Math.min(a.length, b.length, 7);
  if (!k) return false;
  return 1 - editDistance(a.slice(0, k), b.slice(0, k)) / k >= 0.6;
}

// Every word is one concept with its English, Dutch and French form.
// The English text doubles as the id, so it must stay unique across all levels.
const WordBank = {
  words: [],

  add(level, text) {
    for (const line of text.trim().split('\n')) {
      const [theme, en, nl, fr] = line.split('|').map((s) => s.trim());
      const lookalike = { nl: looksLikeEnglish(en, nl), fr: looksLikeEnglish(en, fr) };
      this.words.push({ id: en, level, theme, en, nl, fr, lookalike });
    }
  },

  inLevel(level) {
    return this.words.filter((w) => w.level === level);
  },

  // Words the level test asks about: the ones you can't guess from English.
  testable(level, lang) {
    return this.inLevel(level).filter((w) => !w.lookalike[lang]);
  },

  themes() {
    return [...new Set(this.words.map((w) => w.theme))].sort();
  },
};
