# MTG Card Price Database

A static, no-build, no-backend card price browser for Magic: the Gathering. All data is fetched
live in the browser — nothing to install, nothing to sync ahead of time.

## Data sources

- [Scryfall](https://scryfall.com/docs/api) — card metadata, finishes, and current USD prices
  (aggregated from TCGPlayer and Cardmarket).
- [MTGJSON](https://mtgjson.com/) — per-set booster composition (the weighted card sheets WotC
  uses to build Set/Collector/Draft boosters), used to compute booster expected value (EV).

Both APIs allow direct cross-origin requests from the browser, so this site has no server
component at all.

## Running locally

Just open `index.html` in a browser — no server required.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo's Settings → Pages, set the source to the branch/root containing `index.html`.
3. That's it — no build step.

## Features

- Search by card name and/or set, scoped to sets released in the last 10 years.
- Filter by price range (USD).
- Exclude foil, etched, alt-art/showcase/borderless, and/or the plain base printing —
  independently.
- Group results by set, with per-set row count and average price.
- Per-set "Booster EV" panel comparing Set Booster vs Collector Booster (and Draft Booster, when
  available) expected value, computed from MTGJSON's real weighted booster-slot data joined
  against live Scryfall prices.

## Notes / limitations

- Booster EV is only available for sets MTGJSON has published booster data for (mostly recent
  sets with an actual print-boosters-and-sell-at-retail product).
- Prices are Scryfall's latest daily snapshot, not real-time.
- "Alt art" is a derived heuristic (showcase/extended-art/inverted frame effects, full-art, or
  borderless treatments) since Scryfall has no single flag for it — it won't perfectly match
  every collector's definition of "alt art."
