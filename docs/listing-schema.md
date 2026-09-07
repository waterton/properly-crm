# Canonical Listing Schema — Properly CRM

*Design artifact. Shape first, home second. Draft v1 — 2026-09-04.*

---

## 0. The one-sentence purpose

A **listing** is one structured record of a marketable property, entered once, from which the
website post, the social pieces, and the drip content are all generated. The MLS stays the system
of record; this record is built from the **same inputs you feed the MLS**, not synced from it.

---

## 1. What kind of object this is (and isn't)

There are now three property-shaped things in Properly. Keep them distinct:

| Object | Native question | Lives as | Example |
|---|---|---|---|
| `inv_properties` (rental) | "what did this address cost / earn?" | property-as-**cost-center** | a Magna duplex you manage |
| seller `transactions` | "where is this deal in its lifecycle?" | property-as-**deal** | 2459 W 1800 N, under contract |
| **`listings`** (new) | "how do I publish and market this home?" | property-as-**marketing asset** | 2459 W 1800 N, active, EN/ES pitch, photos |

Same street address can appear in all three and they're still different objects — different
lifecycle, different fields, different audience. A listing is the only one built *to be published*.

**The two links that keep it from being a silo:**

- `contact_id` → the **seller** (a `contacts` row). Always set.
- `transaction_id` → the **seller-side deal** (a `transactions` row). Nullable. Set when the listing
  goes under contract, or earlier if you want them joined from the start. This is the seam: a listing
  is the pre-publication + marketing face of the same address that becomes a seller transaction.

---

## 2. Status lifecycle

One enum drives everything downstream (what the site shows, what drips fire, what's archived).

```
draft → coming_soon → active → under_contract → pending → sold
                         └────────────→ withdrawn / expired
```

| Status | Meaning | On the website | Drips |
|---|---|---|---|
| `draft` | being assembled, not public | hidden | none |
| `coming_soon` | teaser before live | "Coming Soon" badge | pre-list teaser |
| `active` | on market | full listing shown | new-listing / open-house |
| `under_contract` | offer accepted, contingencies live | "Under Contract" badge | — |
| `pending` | contingencies cleared | "Pending" badge (or hidden) | — |
| `sold` | closed | "Sold" / moved to sold gallery | just-sold / sphere |
| `withdrawn` / `expired` | off market | hidden | none |

When `under_contract` is reached, that's the natural moment to set `transaction_id` and hand the
lifecycle to the seller deal you already track.

---

## 3. Core fields (universal — every listing has these)

These are "the same facts, once." They're the columns every downstream transform reads.

| Field | Type | Notes |
|---|---|---|
| `id` | bigint (PK) | `Date.now()`-style id, matching Properly convention |
| `contact_id` | bigint | → seller contact |
| `transaction_id` | bigint, nullable | → seller deal, set later |
| `mls_number` | text | the MLS key — your system-of-record pointer, not a sync |
| `slug` | text | URL-safe, e.g. `2459-w-1800-n-clinton` — drives the site post URL |
| `property_type` | enum | `residential` \| `land` \| `commercial` |
| `status` | enum | see §2 |
| `address_full` | text | display address |
| `street`, `city`, `state`, `zip` | text | parsed parts (site/schema.org, filtering) |
| `county` | text | nullable |
| `price` | numeric | list price (or lease rate for commercial-for-lease) |
| `price_qualifier` | text | nullable — "$/SF NNN", "OBO", "per acre" |
| `hoa_monthly` | numeric | nullable |
| `taxes_annual` | numeric | nullable |
| `lot_size` | text | nullable — "0.24 ac", "10,454 sf" |
| `year_built` | int | nullable |
| `parking` | text | nullable — "2-car garage", "12 stalls" |
| `latitude`, `longitude` | numeric | nullable — for the site map |

---

## 4. Type-specific fields → one `details` JSON

Keep the table stable across property types by putting type-specific facts in a single `details`
jsonb column (this is how Properly already handles commercial-lease and REPC detail blobs). Only the
block matching `property_type` is populated.

**`details` when `residential`:**
```json
{ "beds": 4, "baths_full": 2, "baths_half": 1, "sqft": 2450,
  "stories": 2, "basement": "finished", "garage_spaces": 2,
  "style": "rambler", "appliances_included": true }
```

**`details` when `land`:**
```json
{ "acreage": 5.2, "zoning": "A-1", "utilities": ["culinary water","power at road"],
  "buildable": true, "road_access": "paved", "water_rights": "none", "topography": "gentle slope" }
```

**`details` when `commercial`:**
```json
{ "building_sqft": 1997, "rentable_sqft": 1997, "use_type": "retail/assembly",
  "lease_type": "NNN", "cam_per_sf_low": 5.0, "cam_per_sf_high": 6.0,
  "cap_rate": null, "for_sale_or_lease": "lease", "occupancy": "vacant",
  "zoning": "Community Commercial", "parking_ratio": "4/1000" }
```

(The commercial block deliberately mirrors your LOI inputs so a listing can pre-fill an LOI later.)

---

## 5. Marketing payload (the publishable content)

This is what makes it a *listing* and not a spreadsheet row. Bilingual is first-class because you
already run EN/ES through Gemini in Notes.

| Field | Type | Feeds |
|---|---|---|
| `headline_en` / `headline_es` | text | site title, social headline |
| `pitch_en` / `pitch_es` | text (long) | site body, MLS-style description |
| `features` | jsonb (array of strings) | site bullets, social highlights — e.g. `["Oversized windows","End unit","Shared breakroom"]` |
| `highlights` | jsonb (array, max ~3) | the short punch list for a social graphic |
| `hero_image_url` | text | the one photo used on the site card + social thumbnail |
| `gallery_url` | text | link to the full photo set (Dropbox / Google / photographer / MLS) |
| `video_url` | text, nullable | walkthrough |
| `tour_url` | text, nullable | Matterport / 3D |
| `open_houses` | jsonb (array) | `[{ "start":"2026-09-13T11:00", "end":"...", "note":"" }]` |

*(Photos: per your call, the record stores links, not files — a single `hero_image_url` for the
site card/social thumbnail plus a `gallery_url` to wherever the full set already lives. No Supabase
Storage needed.)*

---

## 6. Ops / provenance / output tracking

So you can see at a glance which outputs a listing has already produced.

| Field | Type | Notes |
|---|---|---|
| `created_at`, `updated_at` | timestamptz | |
| `published_at` | timestamptz, nullable | first time it went `active` |
| `source_notes` | text, nullable | the raw facts you pasted into MLS, kept for regeneration |
| `outputs` | jsonb | `{ "site_post_id": 412, "site_url":"...", "social_done":["ig-feed"], "drip_enrolled": true }` |
| `archived` | bool | mirrors the LOI pattern — hide without deleting |

---

## 7. Downstream transforms (why the schema is shaped this way)

Each output is just a projection of the record. Sequenced by transform cost (cheap → expensive):

**Drips (nearly free — do first).** Same database the drip engine already reads. A drip references
`listing_id` and pulls `address_full`, `price`, `status`, `headline_en/es`. New-listing and
just-sold campaigns become data lookups, not new content.

**Website / WordPress post (medium — do second).** No IDX, so posts are manual by design. The
record generates the post: `slug` → URL, `headline_*` → title, `pitch_*` → body, `features` →
bullets, `hero_image_url` + `gallery_url` → media, `status` → badge, core facts → the spec table.
Push via the WP REST API, or at minimum emit a paste-ready block. The Active Listings page becomes a
*consumer* of this record instead of a fifth place you re-type facts.

**Social graphic (expensive — do last).** It's design, not data. `hero_image_url` + `headline_*` +
`highlights` (≤3) → a templated graphic. Real, but finicky; leave it for a genuine lull.

**Bilingual:** enter `*_en`, generate `*_es` via Gemini (your existing pattern), and let the human
edit the ES. Both are stored so you never regenerate at publish time.

---

## 8. Home (later) — reference SQL, do NOT run yet

Shape is settled above; *where it lives* is a separate decision. Recommended home is a `listings`
table in the **same Supabase project** as Properly (same auth, same DB the drips read). Sketch, to
review — not to migrate until you've pressure-tested the fields:

```sql
create table if not exists listings (
  id             bigint primary key,
  contact_id     bigint,                 -- -> contacts.id (seller)
  transaction_id bigint,                 -- -> transactions.id (nullable; set at under_contract)
  mls_number     text,
  slug           text,
  property_type  text,                   -- residential | land | commercial
  status         text,                   -- see lifecycle
  address_full   text,
  street text, city text, state text, zip text, county text,
  price          numeric,
  price_qualifier text,
  hoa_monthly    numeric,
  taxes_annual   numeric,
  lot_size       text,
  year_built     int,
  parking        text,
  latitude numeric, longitude numeric,
  details        jsonb,                  -- type-specific block (§4)
  headline_en text, headline_es text,
  pitch_en    text, pitch_es    text,
  features    jsonb,                     -- ["...","..."]
  highlights  jsonb,
  hero_image_url text,
  gallery_url    text,
  video_url text, tour_url text,
  open_houses jsonb,
  source_notes text,
  outputs     jsonb,
  archived    boolean default false,
  published_at timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table listings enable row level security;
create policy "listings authenticated" on listings
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
```

Wiring notes for when you build it: add `listings` to `DB_COLS` (write-allowlist), add its
`loadFromDB` index, and a `LISTINGS` global + `saveListing`/`delListing`, matching the LOI/deal-sheet
pattern exactly.

---

## 9. Decisions still open

1. **`transaction_id` timing** — join a listing to a seller deal from creation, or only at
   `under_contract`? (Recommend: optional, set at `under_contract`.)
2. **`pending` on the site** — show with a badge, or hide until `sold`?
3. **Slug source** — auto from address, or hand-set for SEO?
4. **Who generates the WP post** — REST API push (needs a WP app-password + a small endpoint) vs.
   copy-paste block to start. (Recommend: paste block first, API later.)
5. **Commercial for-sale vs. for-lease** — the `details.for_sale_or_lease` flag covers it, but decide
   whether `price` means sale price or lease rate per type.
```
```

---

*Next step when you're ready: pick the home (§8), then build the `listings` table + a minimal
"New Listing" form, and wire the drip transform first.*
