# SpaghettiMapper

A local-first web app for software architects to document, visualize, and
untangle system integrations. Single Go binary, no database — every project is
a folder of human-readable JSON files.

![stack](https://img.shields.io/badge/stack-Go%20%C2%B7%20VanJS%20%C2%B7%20D3-informational)

## Quick start

```sh
go build -o spaghettimapper .
./spaghettimapper            # serves http://127.0.0.1:8484
```

Development mode (HTML/CSS/JS changes reflect on reload, no recompile):

```sh
go run . -dev
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `-addr` | `127.0.0.1:8484` | listen address |
| `-dev` | off | serve assets from `./web` on disk instead of the embedded copy |
| `-data` | `~/.spaghettimapper` | where project folders live |

## Concepts

- **Project** — one architecture map, stored at `~/.spaghettimapper/NAME/`.
- **System** — a node: `internal`, `external`, or `unknown`. Each system owns
  a **data catalog** of entities and their fields.
- **Entity / Field** — catalog items. Fields carry optional `type`,
  `unique`, and `indexed` properties; these are tri-state (absent = "not
  documented", distinct from a documented `false`) so analysis can tell gaps
  from facts. The UI shows coverage ("6/14 fields typed").
- **Integration stream** — data moving between two systems, with timing
  (`real-time`/`scheduled`), API type, data format, direction (`uni`/`bi`),
  status (`planned`/`implemented`/`unknown`), one or more **business needs**,
  and per-endpoint entity/field references into the catalogs.
- **Business need** — the reason streams exist (e.g. "Order Fulfillment").
  A stream can serve several.
- **Flow** — an end-to-end journey: ordered `steps` of `{stream_id, stage}`.
  Stage numbers are explicit and editable; several hops sharing a stage IS
  fan-out/fan-in, and any DAG or cycle the streams form is representable.
  Stages are prefilled from topology when hops are added ("auto-number by
  topology" renumbers the whole flow), and the app warns when the declared
  order contradicts the wiring. Flows carry their own declared business
  needs; needs implied by their streams are deduced automatically and shown
  as ghost chips.
- **Provenance** — every record can carry `{source: manual|imported|inferred,
  confidence}` so machine-generated facts are always distinguishable from
  human-entered ones. Non-manual items get a badge in the UI.

## The map

- Systems render as nodes on a D3 force canvas; drag to pin, double-click to
  unpin, scroll to zoom. Pinned/settled positions persist to `layout.json`,
  so your spatial mental map survives restarts.
- **Edge aggregation**: all streams between the same pair of systems collapse
  into one strand. Width encodes stream count; a badge shows the number;
  arrowheads show flow direction (both ends when flows go both ways).
  Dashed = all planned, dotted = all unknown. Single-stream strands show the
  stream name when zoomed in; hovering any strand or node shows a tooltip.
  A legend sits in the corner and is included in exports. Toggle **Bundle /
  Expand** to switch to one curve per stream, fanned out parallel — each
  strand labelled with its own name, no count badges. Handy on busy
  connections and especially in flow focus, where each hop then sits on its
  own curve instead of stacking on the aggregated strand. The Bundle/Expand
  choice and the **arc spacing** between parallel strands are per-project
  preferences, set from the **Project panel** (click the project name in the
  topbar) and saved to `display.json`, so they survive restarts and travel with
  exports.
- **Dig in**: click a strand (or node) to open the inspector sidebar listing
  every underlying stream, with catalog-resolved entity/field names.
- **Filtering**: a text search (matches system, stream, entity, and field
  names) plus multi-select status / timing / business-need facets. The canvas and the
  left-rail lists use the same matcher. Two behaviors:
  - **Dim** (default) — unmatched items fade to 10% opacity, preserving your
    spatial mental map.
  - **Hide** — unmatched items are removed from the DOM and the force
    simulation entirely, for large tangles.
  Every facet is a set: pick several statuses, several timings, several needs at
  once (empty set = no constraint). A **Systems** facet lets you tick an explicit
  subset of systems to work with — e.g. 5 of 30 — which carves out the induced
  sub-graph: only the chosen systems and the streams whose **both** endpoints are
  in the set are matched; the rest dim or hide per the mode above (other facets
  still filter the streams among the chosen systems). A searchable row filter and
  Clear / All / Invert make ticking many systems fast.
- **Flows**: build a flow by picking its streams (the picker suggests
  connected next hops); each hop gets an editable stage number. Focusing a
  flow dims/hides everything else and draws each hop as a directional amber
  overlay on its strand — arrowhead in the hop's true direction plus a stage
  chip — so a journey like BF → DEV1 → Mule → BF reads directly off the map
  even on strands that carry streams both ways. The flow inspector lists
  hops by stage (filterable for big flows) and flags disconnected pieces,
  order-vs-wiring contradictions, and declared-but-not-carried needs.
  Flows are filterable like everything else: by text, by declared or
  implied business need, and by their hops' status/timing. Focus mode scopes
  every surface consistently: strand tooltips show the flow's hops with
  stage and true direction (noting other streams on the connection), strands
  drop their aggregate arrowheads while an overlay owns the direction story,
  and clicking a strand separates "in this flow" hops from the rest.
- **Matrix lens**: toggle Graph ↔ Matrix for a system×system grid (rows send,
  columns receive; cell = matching stream count, click to dig in) — handy when
  even a filtered force graph is too tangled.
- **Analysis panel**: documentation coverage stats plus the justification
  audit — every field that moves between systems with no business need
  attached is listed as "unjustified data in motion", with inline checkboxes
  to justify it on the spot. Entities can carry needs too (system form).
- **Export SVG** downloads the current canvas as a standalone `.svg`;
  **Export JSON** downloads the whole project as a shareable
  `NAME.spaghetti.json` bundle. **Import project file…** on the landing page
  restores a bundle (IDs preserved, so layouts and references survive).
- **Esc** closes the inspector.

## Storage & concurrency

Each project directory holds `project.json` (with `schema_version`),
`systems.json` (including entity catalogs), `streams.json`, `needs.json`,
`flows.json`, `layout.json`, and `display.json` (canvas display prefs:
Bundle/Expand edge mode and arc spacing). Writes are atomic (temp file + rename) and guarded by a
`sync.RWMutex`; if you edit from two tabs, last write wins.

Deletions are soft: deleted items land in the project's `.trash/` folder
(deleted projects move to `~/.spaghettimapper/.trash/`), recoverable by hand.
Deleting a system cascades to its streams (all trashed); deleting a business
need just detaches it from streams.

Projects written by older versions (schema v1, string-based entities/fields,
single business need) are migrated automatically at startup; auto-created
catalog items are marked with provenance `imported`.

## API

REST/JSON under `/api`:

```
GET/POST           /api/projects
GET/PUT/DELETE     /api/projects/{proj}
GET                /api/projects/{proj}/graph        # everything at once, incl. layout + display
PUT                /api/projects/{proj}/layout       # canvas node positions
GET/PUT            /api/projects/{proj}/display      # canvas display prefs (Bundle/Expand, arc spacing)
GET                /api/projects/{proj}/export       # whole project as one JSON bundle
POST               /api/projects/import?name=NAME    # create project from a bundle
GET/POST           /api/projects/{proj}/systems      # entity catalog rides on the system
PUT/DELETE         /api/projects/{proj}/systems/{id}
GET/POST           /api/projects/{proj}/streams
PUT/DELETE         /api/projects/{proj}/streams/{id}
GET/POST           /api/projects/{proj}/needs
PUT/DELETE         /api/projects/{proj}/needs/{id}
GET/POST           /api/projects/{proj}/flows
PUT/DELETE         /api/projects/{proj}/flows/{id}
```

## Tests

```sh
go test ./...
```

A headless browser smoke test for the UI lives in `web/js/e2e.js`; it runs
against a project named **Demo** with a known shape (5 systems, 7 streams
aggregating to 5 edges, one 2-hop "Order to warehouse" flow). Import the
fixture once, then drive the run with headless Chrome:

```sh
# 1. import the fixture (any running server)
curl -sS -X POST 'http://127.0.0.1:8484/api/projects/import?name=Demo' \
  -H 'Content-Type: application/json' --data-binary @docs/demo.spaghetti.json

# 2. run the smoke test (realistic viewport; the resize assertions need ~960px+)
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new --disable-gpu --no-sandbox --window-size=1600,900 \
  --virtual-time-budget=90000 --dump-dom 'http://127.0.0.1:8484/?e2e#/p/Demo'
```

Then read the `#e2e-results` block in the dumped DOM. The test mutates the
project (justifies/un-justifies fields, toggles display prefs but resets
them), so re-import the fixture for a hermetic re-run.
