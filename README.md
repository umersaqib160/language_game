# Taalspel: Dutch & French words

A small, phone-friendly web app for learning and testing **Dutch ↔ English** and **French ↔ English** vocabulary, from **A1 (beginner) to C1 (advanced)**.

## What's inside

- **Level test.** An adaptive test that asks 8 words per level and stops when a level gets too hard. It estimates how many of the words you already know and your vocabulary level. Words you get right count as known; words you miss go straight into practice.
- **Match cards.** Tap a Dutch or French word, then its English meaning, 6 pairs per round. Spaced repetition brings back words due for review (after 10 minutes, then 1, 3, 7 and 21 days) and mixes in new words from your current level.
- **Memory game.** Flip cards to find pairs. It's practice only and doesn't change your progress.
- **Dictionary.** Search and filter all words by level, theme and status, hear the pronunciation, and mark words you already know.
- **Pronunciation.** Uses your device's built-in Dutch and French voices.
- **Works offline.** Can be added to your phone's home screen.

The word bank has 1,155 concepts, each with Dutch and French, across 34 themes. It includes kitchen vocabulary, Belgian property terms and IT terms.

## Run it

It's static HTML, CSS and JavaScript with no build step.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Publish on GitHub Pages

1. On GitHub, go to **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
3. After a minute the app is live at `https://<your-username>.github.io/language_game/`.

On your phone, open that link and choose **Add to Home Screen**.

## Your progress

Progress is saved in the browser on each device. Use **Settings → Export backup / Import backup** to move it between devices.

## Adding words

Words live in `js/data/a1.js` … `c1.js`, one per line:

```
theme|English|Dutch|French
kitchen|knife|het mes|le couteau
```

The English text is the word's id, so it must be unique across all files. After adding or removing files, bump `VERSION` in `sw.js` so phones pick up the change.
