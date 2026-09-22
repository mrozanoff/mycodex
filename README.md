# Fungarium

A personal, searchable database of the mushroom species you've found — merging
your iNaturalist observations with your own field notes from a Google Sheet.

```
 iNaturalist API
       │
       ▼
inat_species_report.py
       │
       ▼
data/inat_data.json  +  data/manual_data.csv  ──►  index.html / app.js  ──►  GitHub Pages
 (auto-generated)         (you edit this, in
                            Google Sheets)
```

## What's in this folder

- `index.html`, `style.css`, `app.js` — the site itself. No build step, no
  framework — just open `index.html` in a browser or serve the folder.
- `data/inat_data.json` — **sample placeholder data** (3 example species) so
  the site works out of the box. Replace this with the real file produced by
  `inat_species_report.py` (the script from earlier).
- `data/manual_data.csv` — **sample placeholder notes** matching the same 3
  species, showing the expected columns. Replace with your real notes.

## 1. Set up your Google Sheet

Create a sheet with these exact column headers in row 1 (order doesn't
matter, but the header text does — matching is case-insensitive):

| Scientific Name | Spore Colour | Edibility | Identification Tips | Look-Alikes | Ecology | Fun Facts | Etymology | Informal Group Names | Other Notes |
|---|---|---|---|---|---|---|---|---|---|

**`Scientific Name` is the merge key.** It must match the species name
exactly as it appears in `inat_data.json` (e.g. `Cantharellus cibarius`) —
matching ignores case and leading/trailing spaces, but not spelling.

Fill in a row per species, whenever you have notes for it. Species with no
row yet will still show up on the site — the detail panel will just say
"No field notes yet."

Want more columns later (e.g. "Habitat photos", "Cook notes")? Add the
column to the sheet, then add one line to the `MANUAL_FIELDS` array near the
top of `app.js`:

```js
{ csvHeader: "Cook Notes", key: "cookNotes", label: "Cook notes" },
```

## 2. Get the notes out of Google Sheets and into the site

You have two options — pick whichever fits how often you update the sheet.

**Option A — Publish the sheet live (recommended, no re-uploading ever)**

1. In Google Sheets: `File` → `Share` → `Publish to web`.
2. Choose the specific sheet/tab, set the format to **Comma-separated
   values (.csv)**, and publish.
3. Copy the URL it gives you.
4. In `app.js`, set:
   ```js
   MANUAL_DATA_URL: "https://docs.google.com/spreadsheets/d/e/...../pub?output=csv",
   ```
5. Now the live site always reflects your latest sheet edits — no need to
   touch the repo when you just add notes.

**Option B — Download and commit the CSV**

1. In Google Sheets: `File` → `Download` → `Comma Separated Values (.csv)`.
2. Replace `data/manual_data.csv` with the downloaded file, commit, and push.
3. Repeat whenever you update your notes.

Option A updates instantly; Option B is simpler to reason about (everything
lives in the repo) but requires a re-download/commit each time you edit notes.

## 3. Regenerate your iNaturalist data

Run `inat_species_report.py` (from earlier) to produce a fresh
`inat_data.json`. Copy the output over `data/inat_data.json` in this folder,
commit, and push. Re-run it whenever you log new observations you want
reflected on the site.

## 4. Publish on GitHub Pages

1. Create a new GitHub repo (or use an existing one) and push this whole
   `fungarium` folder to it.
2. In the repo: `Settings` → `Pages` → under "Build and deployment", set
   **Source** to "Deploy from a branch", pick your branch (e.g. `main`) and
   the folder this code lives in (`/root` if you pushed these files at the
   repo root, or `/docs` if you put them in a `docs` folder).
3. Save. GitHub gives you a URL like
   `https://yourusername.github.io/your-repo/` within a minute or two.

## Using it offline

Once `sw.js` (the service worker) is deployed alongside the site, your
phone or laptop caches the app the first time it loads over the internet.
After that:

1. Visit the site once while you have a signal (checking it at home before
   a foraging trip is enough — it doesn't need to be the same day).
2. Optionally, **add it to your home screen** for an app-like icon and a
   full-screen window (no browser address bar):
   - iPhone/Safari: Share button → "Add to Home Screen"
   - Android/Chrome: menu (⋮) → "Add to Home Screen" or "Install app"
3. From then on, opening it — from the home screen icon, a bookmark, or
   your browser history — works with no signal at all, using whatever data
   was cached at your last online visit.

A few things worth knowing:

- The **first-ever visit** requires internet, since there's nothing to
  cache yet.
- Whenever you're online and reload the page, it quietly re-fetches
  `inat_data.json` and `manual_data.csv` in the background and updates the
  cache — so the offline copy is only ever as stale as your last visit
  while connected.
- This only works when the site is served over `https://` (GitHub Pages
  does this automatically) or `http://localhost` for local testing —
  service workers refuse to register over a plain `file://` link or
  unencrypted `http://`.
- To confirm it's working: open the site, then in Chrome/Edge DevTools go
  to Application → Service Workers and check it says "activated and is
  running." You can also tick "Offline" there to simulate no connection.

## Cross-referencing look-alikes automatically

If a "Look-Alikes" note mentions another species you've logged — either by
its full scientific name (`Hydnoporia olivacea`) or the standard abbreviated
form (`H. olivacea`) — the site turns it into a clickable link that jumps
straight to that species' row and opens it.

- Matching is exact and case-insensitive, based on the scientific names in
  `inat_data.json`. No setup needed on your end — just write look-alike
  names normally in the sheet, spelled the way they appear in your data.
- Abbreviated forms (`H. olivacea`) only link automatically when they're
  unambiguous — if you have two different genera starting with the same
  letter and sharing a specific epithet, spell the genus out in full for
  that one so it can be matched.
- Provisional names (`Genus sp. 'epithet'`) aren't auto-linked, since
  they're not a fixed enough pattern to match reliably in free text.

## Unassigned family (Incertae sedis)

Any species with no family on record shows "Incertae sedis" (the standard
taxonomic placeholder for "uncertain placement") instead of a blank. These
are always sorted to the very bottom of the list — below every real
family, alphabetically or not — since they don't have a true alphabetical
position among named families.

## How the site works

- **Stats bar** shows totals for species logged, families, orders, and
  genera — computed live from your data.
- **Search box** matches across everything: common name, scientific name,
  full taxonomy (kingdom→species, including common names), countries/states
  observed, DNA barcode and microscopy values, and every manual note field.
  Type multiple words and all must match (in any order).
- **Filters** narrow by family, order, informal group name, spore colour,
  and whether DNA has been confirmed on at least one of your own
  observations.
- **Column headers** are clickable to sort; click again to reverse.
- The species list shows spore colour (with a small colour swatch guessed
  from keywords in your text — purely a visual aid, adjust the mapping in
  `sporeColourSwatch()` in `app.js` if it guesses wrong).
- Click any row to expand it into a detail panel: full taxonomy breadcrumb,
  two buttons linking straight to iNaturalist's observation map for that
  species (all observations, or only ones with a DNA Barcode ITS value),
  edibility / spore colour / informal names, DNA barcode / microscopy
  fields, the countries and states/provinces **you've** found it in (any
  location backed by at least one DNA-confirmed observation of yours is
  shown in **bold blue**), your own observations — each one a clickable
  link straight to that observation on iNaturalist, one per line — and all
  your longer manual notes (identification tips, look-alikes, ecology, fun
  facts, etymology, other notes).

## Local preview

Because the site fetches local JSON/CSV files, opening `index.html` directly
via `file://` will be blocked by the browser in some setups. Serve it
locally instead:

```bash
cd fungarium
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.
