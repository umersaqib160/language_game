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

// Every word is one concept with its English, Dutch and French form.
// The English text doubles as the id, so it must stay unique across all levels.
const WordBank = {
  words: [],

  add(level, text) {
    for (const line of text.trim().split('\n')) {
      const [theme, en, nl, fr] = line.split('|').map((s) => s.trim());
      this.words.push({ id: en, level, theme, en, nl, fr });
    }
  },

  inLevel(level) {
    return this.words.filter((w) => w.level === level);
  },

  themes() {
    return [...new Set(this.words.map((w) => w.theme))].sort();
  },
};
