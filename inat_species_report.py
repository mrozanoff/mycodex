#!/usr/bin/env python3
"""
inat_species_report.py

Builds a clean, per-species JSON report from your iNaturalist observations.

For every species you've observed under a given parent taxon, this script pulls:
  - Scientific name + common name
  - Full taxonomy back to Phylum
  - Whether YOUR observations of that species have "DNA Barcode ITS" and/or
    "Microscopy Performed" filled in (Yes/No)
  - Countries and states/provinces YOU have found the species in, each
    flagged "dna": true if at least one of your observations there had a
    DNA Barcode ITS value on file
  - Your own observations, each with its date, place, and a direct link to
    it on iNaturalist

LOCATIONS: this version does NOT use iNaturalist's place_ids/admin_level
system at all -- that turned out to be unreliable to extract from the bulk
observations list, and iNat's admin_level numbering isn't consistently
documented. Instead, it reverse-geocodes each observation's own coordinates
(the "geojson"/"location" fields, which are always present and always
accurate) via OpenStreetMap's Nominatim service. Results are cached by
rounded coordinate, so observations from the same general area (e.g. the
same patch of woods) only cost one lookup, not one per observation. Per
Nominatim's usage policy this is rate-limited to roughly 1 request/second --
for a personal collection this is normally a small number of unique
locations, so it stays fast.

Requires: pip install requests

Usage:
    python inat_species_report.py
    (edit the CONFIG constants below first)
"""

import time
import json
from collections import defaultdict

import requests

# ----------------------------- CONFIG ---------------------------------

USER_ID = "paganka"
PARENT_TAXON_ID = 47170       # the taxon_id from your URL
HRANK = "species"             # only pull observations identified to species

OUTPUT_FILE = "inat_species_report.json"

# iNaturalist asks API consumers to identify themselves and stay under
# roughly 60 requests/minute. We sleep briefly between calls to be polite;
# the script also auto-backs-off on 429s regardless.
HEADERS = {"User-Agent": "inat-species-report-script (personal use)"}
SLEEP_SECONDS = 0.5

BASE = "https://api.inaturalist.org/v1"

TAXONOMY_RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]

# Exact iNaturalist observation field names -- must match exactly (case is
# normalized when compared, but the words themselves have to be right).
FIELD_DNA = "DNA Barcode ITS"
FIELD_MICROSCOPY = "Microscopy Performed"

# Reverse geocoding (for country/state from coordinates). Nominatim's usage
# policy asks for a real identifying User-Agent and max ~1 request/second --
# if you have a contact email, consider adding it to NOMINATIM_HEADERS.
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_HEADERS = {"User-Agent": "inat-species-report-script (personal use)"}
NOMINATIM_SLEEP_SECONDS = 1.1

# Round coordinates to this many decimal places before geocoding/caching.
# 2 decimals is roughly 1.1km -- plenty precise for country/state, and
# means observations from the same general spot share one lookup.
COORD_PRECISION = 2

# ----------------------------- HELPERS ---------------------------------


def _get(url, params=None, retries=3):
    """GET with basic retry/backoff."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
            if resp.status_code == 429:
                wait = 5 * (attempt + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            time.sleep(SLEEP_SECONDS)
            return resp.json()
        except requests.RequestException as e:
            print(f"  Request failed ({e}), retrying...")
            time.sleep(3)
    raise RuntimeError(f"Failed to GET {url} after {retries} attempts")


def extract_field(fields, field_name):
    """Safely extract an observation field's value by name (case-insensitive).

    Matches the shape iNat actually returns, e.g.:
        {"id": ..., "field_id": ..., "datatype": "dna",
         "name": "DNA Barcode ITS", "name_ci": "DNA Barcode ITS", "value": ...}
    """
    target = field_name.lower()
    for f in fields or []:
        name = f.get("name") or (f.get("observation_field") or {}).get("name")
        if name and name.lower() == target:
            return f.get("value")
    return None


def yes_no(value):
    """A field counts as 'filled in' if it's present at all, regardless of
    what the value actually says."""
    return "Yes" if value is not None else "No"


def extract_coords(obs):
    """
    Pull (lat, lon) out of an observation, preferring the geojson field
    (note GeoJSON order is [lon, lat]) and falling back to the "location"
    string ("lat,lon").
    """
    geojson = obs.get("geojson") or {}
    coords = geojson.get("coordinates")
    if coords and len(coords) == 2:
        lon, lat = coords
        return lat, lon

    location = obs.get("location")
    if location and "," in location:
        try:
            lat_str, lon_str = location.split(",", 1)
            return float(lat_str), float(lon_str)
        except ValueError:
            pass

    return None, None


_geocode_cache = {}


def reverse_geocode(lat, lon):
    """
    Reverse-geocode a coordinate to (country, state) via Nominatim, cached
    by rounded coordinate. Returns (None, None) on failure rather than
    raising, so one bad lookup doesn't kill the whole run.
    """
    if lat is None or lon is None:
        return None, None

    key = (round(lat, COORD_PRECISION), round(lon, COORD_PRECISION))
    if key in _geocode_cache:
        return _geocode_cache[key]

    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={
                "format": "jsonv2",
                "lat": key[0],
                "lon": key[1],
                "zoom": 10,
                "addressdetails": 1,
            },
            headers=NOMINATIM_HEADERS,
            timeout=15,
        )
        time.sleep(NOMINATIM_SLEEP_SECONDS)
        resp.raise_for_status()
        address = resp.json().get("address", {})
        country = address.get("country")
        state = (
            address.get("state")
            or address.get("province")
            or address.get("region")
            or address.get("state_district")
        )
    except (requests.RequestException, ValueError) as e:
        print(f"    Reverse geocode failed for {key}: {e}")
        country, state = None, None

    _geocode_cache[key] = (country, state)
    return country, state


def location_entries(all_names, dna_names, microscopy_names):
    """Build the sorted [{name, dna, microscopy}] list for the JSON output."""
    return sorted(
        (
            {"name": name, "dna": name in dna_names, "microscopy": name in microscopy_names}
            for name in all_names
        ),
        key=lambda x: x["name"],
    )


# ----------------------------- FETCHING ---------------------------------


def get_user_observations(user_id, taxon_id, hrank):
    """Page through all of the user's observations for this taxon."""
    obs = []
    page = 1
    while True:
        data = _get(
            f"{BASE}/observations",
            params={
                "user_id": user_id,
                "taxon_id": taxon_id,
                "hrank": hrank,
                "order": "desc",
                "order_by": "created_at",
                "per_page": 200,
                "page": page,
            },
        )
        results = data.get("results", [])
        if not results:
            break
        obs.extend(results)
        print(f"  Fetched page {page} of your observations ({len(results)} results)")
        if len(obs) >= data.get("total_results", 0):
            break
        page += 1
    return obs


_taxon_cache = {}


def get_taxon_detail(taxon_id):
    """Fetch full taxon record (with ancestors) for a taxon id, cached."""
    if taxon_id in _taxon_cache:
        return _taxon_cache[taxon_id]
    data = _get(f"{BASE}/taxa/{taxon_id}")
    results = data.get("results", [])
    detail = results[0] if results else None
    _taxon_cache[taxon_id] = detail
    return detail


def build_taxonomy(taxon_detail):
    """Build a rank -> {name, common_name} dict from kingdom to species."""
    taxonomy = {rank: None for rank in TAXONOMY_RANKS}

    def place(entry):
        rank = entry.get("rank")
        if rank in taxonomy:
            taxonomy[rank] = {
                "name": entry.get("name"),
                "common_name": entry.get("preferred_common_name"),
            }

    for ancestor in taxon_detail.get("ancestors", []) or []:
        place(ancestor)
    place(taxon_detail)

    return taxonomy


# ----------------------------- MAIN ---------------------------------


def main():
    start_time = time.time()

    print(f"Fetching your observations of taxon {PARENT_TAXON_ID}...")
    observations = get_user_observations(USER_ID, PARENT_TAXON_ID, HRANK)
    print(f"Total observations fetched: {len(observations)}\n")

    # Group by species taxon id
    by_species = defaultdict(list)  # taxon_id -> list of lightweight obs dicts

    for obs in observations:
        taxon = obs.get("taxon") or {}
        taxon_id = taxon.get("id")
        if not taxon_id:
            continue

        ofvs = obs.get("ofvs") or []
        obs_id = obs.get("id")
        lat, lon = extract_coords(obs)

        by_species[taxon_id].append(
            {
                "id": obs_id,
                "observed_on": obs.get("observed_on"),
                "place_guess": obs.get("place_guess"),
                "url": f"https://www.inaturalist.org/observations/{obs_id}" if obs_id else None,
                "lat": lat,
                "lon": lon,
                "dna_present": extract_field(ofvs, FIELD_DNA) is not None,
                "microscopy_present": extract_field(ofvs, FIELD_MICROSCOPY) is not None,
            }
        )

    print(f"Found {len(by_species)} unique species. Building report...\n")

    report = {}
    for i, (taxon_id, obs_list) in enumerate(by_species.items(), 1):
        print(f"[{i}/{len(by_species)}] Processing taxon {taxon_id}...")

        taxon_detail = get_taxon_detail(taxon_id)
        if not taxon_detail:
            print(f"  Could not fetch taxon detail for {taxon_id}, skipping.")
            continue

        scientific_name = taxon_detail.get("name")
        common_name = taxon_detail.get("preferred_common_name")
        taxonomy = build_taxonomy(taxon_detail)

        dna_yn = yes_no(True if any(o["dna_present"] for o in obs_list) else None)
        microscopy_yn = yes_no(True if any(o["microscopy_present"] for o in obs_list) else None)

        all_countries, all_states = set(), set()
        dna_countries, dna_states = set(), set()
        microscopy_countries, microscopy_states = set(), set()

        print("  Resolving locations...")
        for o in obs_list:
            country, state = reverse_geocode(o["lat"], o["lon"])
            if country:
                all_countries.add(country)
                if o["dna_present"]:
                    dna_countries.add(country)
                if o["microscopy_present"]:
                    microscopy_countries.add(country)
            if state:
                all_states.add(state)
                if o["dna_present"]:
                    dna_states.add(state)
                if o["microscopy_present"]:
                    microscopy_states.add(state)

        report[scientific_name] = {
            "taxon_id": taxon_id,
            "common_name": common_name,
            "taxonomy": taxonomy,
            "observation_fields": {
                FIELD_DNA: dna_yn,
                FIELD_MICROSCOPY: microscopy_yn,
            },
            "range": {
                "countries": location_entries(all_countries, dna_countries, microscopy_countries),
                "states_provinces": location_entries(all_states, dna_states, microscopy_states),
            },
            "your_observations": sorted(
                (
                    {
                        "id": o["id"],
                        "observed_on": o["observed_on"],
                        "place_guess": o["place_guess"],
                        "url": o["url"],
                    }
                    for o in obs_list
                ),
                key=lambda o: o.get("observed_on") or "",
            ),
        }
        print()

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    elapsed = time.time() - start_time
    print(f"Done. Wrote {len(report)} species to {OUTPUT_FILE} in {elapsed:.1f} seconds.")


if __name__ == "__main__":
    main()
