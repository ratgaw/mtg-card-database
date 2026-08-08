# MTG Card Price Database

A static, no-build, no-backend card price browser for Magic: the Gathering. All data is fetched
live in the browser — nothing to install, nothing to sync ahead of time.

## Data sources

- [Scryfall](https://scryfall.com/docs/api) — card metadata, finishes, and current USD prices
  (aggregated from TCGPlayer and Cardmarket).
- [MTGJSON](https://mtgjson.com/) — per-set booster composition (the weighted card sheets WotC
  uses to build Set/Collector/Draft boosters), used to compute booster expected value (EV).
- [Tesseract.js](https://tesseract.projectnaptha.com/) — in-browser OCR, loaded lazily only when
  you use the "scan a card" feature, for reading a card's name off a photo.

All of the above allow direct cross-origin requests from the browser, so this site has no server
component at all. Your collection data (see below) is stored only in your own browser's
`localStorage` — it isn't sent anywhere.

## Running locally

Just open `index.html` in a browser — no server required.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/root containing `index.html`.
3. That's it — no build step.

## Features

**Card Browser**
- Search by card name and/or set, scoped to sets released (or releasing within ~3 weeks) in the
  last 10 years.
- Filter by price range (USD), and exclude cards with no price data.
- Exclude foil, etched, alt-art/showcase/borderless, and/or the plain base printing — independently.
- Sort by price (high↔low), group results by set, switch between a table and an image grid.
- Click any card for a detail view: full-size art, every finish's price, which booster products
  it's actually found in, and buy/sell links out to TCGPlayer/Cardmarket.
- Set picker supports "Select all", a filter box, and click-and-drag multi-select.

**Compare Booster Value**
- Pick any number of sets and see Set/Play Booster vs Collector Booster (and Draft, when
  available) expected value, computed from MTGJSON's real weighted booster-slot data joined
  against live Scryfall prices — as a grouped bar chart and a sortable table.
- Sets with no published booster data, or where fewer than half the set's cards have price data,
  are automatically dropped from the comparison (and named, with the reason, in the summary).
- If you've logged real opened packs for a set in **My Collection**, your actual average pull
  value is shown alongside the theoretical EV.

**My Collection**
- Search-and-add or scan a photo: OCR reads the card's name off the image, resolves it through
  Scryfall's fuzzy-name lookup, and shows real search results for you to confirm the exact
  printing — camera capture on mobile, file upload everywhere.
- "Log a pack": start a session for a specific set + booster type, add the cards you pulled, and
  finish it to record that pack's real value — rolls into the running average shown in Compare.
- Collection table with running total value, per-card quantity controls, and per-set/booster-type
  pack history.
- Download a JSON backup / restore from one — the only way to move your collection between
  browsers or devices, since it's local-storage-only (see limitations).

## Notes / limitations

- Booster EV is only available for sets MTGJSON has published booster data for (mostly recent
  sets with an actual print-boosters-and-sell-at-retail product).
- Prices are Scryfall's latest daily snapshot, not real-time.
- "Alt art" is a derived heuristic (showcase/extended-art/inverted frame effects, full-art, or
  borderless treatments) since Scryfall has no single flag for it — it won't perfectly match
  every collector's definition of "alt art."
- **Collection data is local to one browser on one device** — no account, no server, no sync.
  Clearing site data (or switching browsers/devices) loses it unless you've exported a backup.
- OCR card-name detection is best-effort (lighting, angle, and older card frames all affect
  accuracy) — it's meant to pre-fill a search for you to confirm, not to auto-identify with
  certainty. It also can't tell which specific printing/foil you have; you always pick that from
  real search results.
