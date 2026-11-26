# Lookbook Index

A running index of 315 clothing labels and their newest lookbooks.

- **Just in** (front page): the latest lookbooks, collections and collabs, laid out by release date.
- **Brands**: every label with a one-line style note, sortable A–Z, by region or by price, filterable by category. Click a label for its card.
- **Elsewhere**: fashion sites worth knowing (runway, shops, reading, industry).
- `old/stark/`: the previous stark text-only version, kept for reference.

Data:
- `brands.json`: the label directory (`s` is the style line).
- `drops.json`: the feed, refreshed weekly. A drop can show a real cover by putting an image in `covers/` and adding `"cover": "covers/<file>"` to its entry. Covers show in black and white and turn to colour on hover.

Live at https://jere-mee-as.github.io/lookbookindex/ · Made by Jere.

Images: `.github/workflows/images.yml` runs `scripts/fetch-images.mjs` every Monday, on any change to drops.json/brands.json, or by hand (Actions → Fetch images → Run workflow). It saves each drop's article preview image and each brand's homepage preview image into `covers/` (900px WebP) and records them as `cover` / `img`. Misses are listed in the run summary; to fix one by hand, drop an image in `covers/` and set the field yourself.
