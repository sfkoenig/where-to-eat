# Food Finder Project Notes

## Purpose
Food Finder is a dish-first restaurant search app.

User flow:
- enter a dish
- enter a starting address
- choose a radius
- get back actual dish hits with price, restaurant, distance, open/closed status, and source links

Core product rule:
- price is required for a result to appear
- historical priced data can be reused once previously seen

## Current stack
- Next.js App Router
- deployed on Vercel
- Google Places / Geocoding for discovery and location
- Supabase for persistent cache
- direct website menu crawling
- ordering-platform crawling, especially Toast and SpotOn where available

## Important files
- `app/api/search/route.ts`: backend search, crawling, parsing, ranking, diagnostics
- `app/page.tsx`: search UI and diagnostics UI
- `lib/server-cache.ts`: persistent cache helpers
- `supabase-cache-schema.sql`: cache table schema

## Environment variables
- `GOOGLE_MAPS_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Database setup already needed in Supabase
```sql
create table if not exists search_cache (
  cache_key text primary key,
  value jsonb not null,
  cached_at timestamptz not null default now()
);

create index if not exists idx_search_cache_cached_at on search_cache (cached_at desc);
```

## Deployed app
- production domain: `food-finder-io.vercel.app`
- deployment is connected to GitHub and auto-deploys from `main`

## Local repo state at time of writing
- branch: `main`
- local HEAD: `79c8a0b Use local menu blocks for item extraction`

## Important note about chat history vs local repo
The chat continued after local HEAD `79c8a0b` with additional live debugging and live deploy iterations.
That means the conversation history contains more recent decisions and attempted fixes than this checkout necessarily reflects.

Before resuming deep debugging, verify whether local `main` is behind `origin/main`.

## What has been built
- address-based search, not city-wide only
- radius options include `0.5 mile`
- `sf` expands to `San Francisco`
- mobile layout stacks fields vertically
- results show cards with item, price, restaurant, address, links, and badges
- sort prioritizes lower price, then distance
- monthly cache to reduce Google/API spend
- strict final radius filter
- diagnostics panel in UI
- support for vegetarian-style fuzzy matching
- support for ordering sources beyond plain website menus

## Major architecture decisions
1. Google is used for location and restaurant candidate discovery, but menu/order sources are also critical.
2. Results should only appear when a priced dish hit is found.
3. Cache aggressively to control cost and improve repeat-search speed.
4. Historical priced data should be reusable once captured.
5. Parser quality matters more than loose recall. Wrong prices are worse than missing results.

## Diagnostics behavior
The app exposes a search diagnostics panel to help debug missing restaurants.
Examples of useful lines:
- summary candidate lines
- `[crawl]` lines with `hits=...`
- fallback lines for direct source attempts

This was used to isolate Khob Khun's earlier failure mode:
- discovered by Places
- crawled
- parser returned `hits=0`
- later parser work got Khob Khun to appear

## Restaurants / cases specifically discussed
### Khob Khun Thai Cuisine & Breakfast
- website: `https://www.khobkhunsf.com/thaimenu`
- Toast: `https://order.toasttab.com/online/khob-khun-thai-cuisine-breakfast-3741-geary-blvd`
- Was missing for `pad thai` despite showing in Google Maps UI.
- Diagnostics eventually showed it was discovered and crawled but yielding `hits=0`.
- Subsequent parser changes eventually made it appear.

### Oraan Thai Eatery
- Had parser garbage / duplicate-card issues.
- Examples included CSS-ish or embedded text appearing as item names.
- Later matching also incorrectly included non-pad-thai items in some searches.

### Khaosoi Thai Cuisine
- `https://www.khaosoisf.com/menus`
- Pad thai base price should be `$16.95`.
- App incorrectly picked up modifier pricing such as `add $2 for beef`.
- This remains a known class of bug: modifier price vs entree price.

### My Ivy Thai
- website from diagnostics: `https://www.myivythai.com/`
- Still showing `pad thai` with price `$2` and no description in the latest user screenshot.
- This is the current known bad case and the most important next debugging target.
- It indicates the parser is still selecting a modifier/add-on price block instead of the actual entree block.

## Current known issues
1. Some sites still promote modifier/add-on prices like `$2` instead of entree prices.
2. Some sites still fail to attach descriptions even when the source clearly has them.
3. Some generic parsers are still too loose for certain custom menu layouts.
4. The local repo may be behind the latest live deployment/debugging state.

## Current best understanding of the parser problem
The generic parser pipeline has evolved through multiple stages:
- simple line matching
- heading-aware matching
- sequential price parsing
- forward price parsing
- embedded JSON/script parsing
- local menu block extraction

Even after the local menu block refactor, some sites still fail because:
- the parser chooses a modifier block instead of the entree block
- or it cannot reliably bind the correct description to the selected item/price

The current My Ivy Thai screenshot is the concrete evidence that this is still unresolved.

## Recommended next steps
1. Sync local repo with the latest remote state before more debugging.
2. Inspect My Ivy Thai source structure directly.
3. Add source-specific diagnostics for the exact matched text block on My Ivy Thai.
4. Fix price extraction so modifier prices cannot win over base entree price for that layout.
5. Fix description extraction by binding it to the same selected entree block.
6. Re-test Khaosoi Thai after the My Ivy fix, because it appears to be the same class of bug.

## Resume prompt
If resuming in a new thread, start with something like:

> Read `PROJECT_NOTES.md`, inspect `app/api/search/route.ts`, and continue debugging the My Ivy Thai / Khaosoi Thai menu parser issue where modifier prices like `$2` are being selected instead of entree prices and descriptions are missing.

