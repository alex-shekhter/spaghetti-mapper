# AI import from integration diagrams

This document defines a **prompt + JSON Schema** that you can hand to any
external LLM (GPT, Claude, Gemini, …) together with a set of **pictures of
integration diagrams**. The model's job is to read the diagrams and emit a
single JSON document — a SpaghettiMapper **project bundle** — that imports
cleanly via:

```
POST /api/projects/import?name=NAME
Content-Type: application/json

<bundle JSON produced by the model>
```

(or, equivalently, paste the JSON into **Import project file…** on the
landing page — choose any project name).

The schema below mirrors the Go `store.Bundle` struct exactly, including the
enum constraints the app otherwise enforces on the create/edit endpoints.
Although the import path itself does not reject bad enum values, following
the schema guarantees the imported project renders and analyses correctly.

---

## How to use this document

1. Copy the **System prompt** section verbatim into the LLM as the
   system/developer message.
2. Attach all diagram pictures to the same conversation.
3. Optionally append a short user note listing extra context the pictures
   don't show (system purposes, business needs, timings, etc.).
4. Ask the model to reply with **only** the JSON document — no prose, no
   code fence. (The schema is provided to the model inside the system prompt
   so structured-output / JSON-mode APIs can use it directly.)
5. Save the response as `NAME.spaghetti.json` and import it.

> **Stable IDs are mandatory.** The import keeps every ID as-is. Streams
> reference systems by `id`; flows reference streams by `id`; endpoints
> reference entities/fields by `id`. If the model invents an ID in one place
> and a different one in another, the project will import but render broken.
> The schema and prompt enforce consistent IDs via the `x-ref` notes.

---

## System prompt (copy verbatim)

```
You are an integration-architecture analyst. You will be given a set of
pictures that together document the integrations of a software ecosystem:
system diagrams, data-flow diagrams, sequence diagrams, catalog/entity
listings, and tables of streams between systems.

Your task: produce ONE JSON document that conforms to the JSON Schema
embedded below. The document is a SpaghettiMapper project bundle. Output
JSON and nothing else — no markdown, no code fence, no commentary.

GENERAL RULES
- Every system, entity, field, stream, business need, and flow MUST have a
  stable, unique `id` string. Use short readable slugs (e.g. "sys-crm",
  "ent-order", "fld-order-id", "strm-crm-to-billing", "need-fulfillment",
  "flow-order-to-cash"). Reuse the SAME id everywhere the same object is
  referenced.
- A stream's source.system_id and destination.system_id MUST be ids of
  systems present in `systems`.
- A stream endpoint's entity_ids MUST be ids of entities that belong to the
  endpoint's system. field_ids (when fields_mode == "list") MUST be ids of
  fields that belong to one of those entities.
- A flow step's stream_id MUST be the id of a stream present in `streams`.
- biz_need_ids on streams / flows / entities / fields MUST reference ids of
  needs present in `needs`.
- Prefer completeness over guessing: if a property is not visible in the
  diagrams, omit it rather than inventing a value. Use the "unknown" /
  "unknown" enum values where they exist; leave free-text fields (api_type,
  data_format, type, description) out if undocumented.
- Mark every record with provenance so human-entered and model-derived facts
  stay distinguishable: set `provenance.source` to "imported" and
  `provenance.confidence` to a 0..1 number reflecting how clearly the
  diagram supports the fact (1.0 = explicitly drawn/labeled, 0.5 = inferred
  from layout/arrows, 0.3 = guessed). Omit provenance only when the fact is
  verbatim from a label.
- Entities and fields: only model the catalog items the diagrams actually
  show. Do not pad with invented fields. If a stream clearly moves a whole
  entity, set fields_mode "all"; if it lists specific fields, use "list" and
  give field_ids; if the diagrams show an exchange but no field detail, use
  "unknown".
- Systems: classify type as "internal" for systems inside the org boundary
  shown in the diagrams, "external" for third-party/SaaS/partner systems,
  and "unknown" when you cannot tell.
- Streams: timing is "real-time" for synchronous/event-driven flows,
  "scheduled" for batch/cron/nightly. direction is "uni" unless the diagram
  shows bidirectional exchange, in which case "bi". status is "implemented"
  if drawn solid/active, "planned" if dashed/future/roadmap, "unknown"
  otherwise.
- Flows: only create a flow when the diagrams explicitly name an end-to-end
  process/journey (e.g. "Order-to-Cash"). Number stages left-to-right /
  top-to-bottom as drawn. Do not synthesize flows that are not depicted.
- layout: leave as an empty object {} unless the diagrams give explicit
  coordinates. The app will auto-layout missing positions.

JSON SCHEMA (conform exactly; additionalProperties are allowed but keep the
document minimal):

<paste the JSON Schema from the next section here, verbatim>
```

> When feeding the prompt to a JSON-mode / structured-output API, pass the
> schema block as the `response_schema` / `schema` parameter and keep the
> prose rules above as the system message.

---

## JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://spaghettimapper.local/bundle.schema.json",
  "title": "SpaghettiMapper project bundle",
  "description": "A whole SpaghettiMapper project in one JSON document, importable via POST /api/projects/import?name=NAME",
  "type": "object",
  "required": ["format_version", "project", "systems", "streams", "needs", "flows", "layout"],
  "additionalProperties": false,
  "properties": {
    "format_version": {
      "type": "integer",
      "const": 1,
      "description": "Bundle format version. Must be 1."
    },
    "exported_at": {
      "type": "string",
      "format": "date-time",
      "description": "Optional ISO-8601 timestamp. Ignored on import; safe to omit."
    },
    "project": {
      "type": "object",
      "description": "Project metadata. On import, schema_version/created_at/updated_at are set by the server; only description is preserved. name is taken from the import URL ?name= or falls back to project.name.",
      "required": ["name", "description"],
      "additionalProperties": false,
      "properties": {
        "name":        { "type": "string", "minLength": 1, "description": "Project name. Used as fallback when no ?name= is given on import." },
        "description": { "type": "string", "description": "Human-readable project description. May be empty string." },
        "schema_version": { "type": "integer", "description": "Ignored on import; the server forces the current schema version." },
        "created_at":  { "type": "string", "format": "date-time" },
        "updated_at":  { "type": "string", "format": "date-time" }
      }
    },
    "systems": {
      "type": "array",
      "description": "Systems (graph nodes). Each owns a data catalog of entities/fields.",
      "items": { "$ref": "#/$defs/system" }
    },
    "streams": {
      "type": "array",
      "description": "Integration streams (edges): data moving between two systems.",
      "items": { "$ref": "#/$defs/stream" }
    },
    "needs": {
      "type": "array",
      "description": "Business needs that justify streams/flows/catalog items.",
      "items": { "$ref": "#/$defs/need" }
    },
    "flows": {
      "type": "array",
      "description": "Named end-to-end journeys over ordered streams.",
      "items": { "$ref": "#/$defs/flow" }
    },
    "layout": {
      "type": "object",
      "description": "Saved canvas positions keyed by system id. Empty object {} is fine; the app auto-positions missing systems.",
      "additionalProperties": { "$ref": "#/$defs/nodePos" }
    }
  },

  "$defs": {

    "provenance": {
      "type": "object",
      "description": "Records where a fact came from. Use source 'imported' for model-derived data with a 0..1 confidence.",
      "additionalProperties": false,
      "required": ["source"],
      "properties": {
        "source":     { "type": "string", "enum": ["manual", "imported", "inferred"] },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },

    "system": {
      "type": "object",
      "required": ["id", "name", "type", "entities"],
      "additionalProperties": false,
      "properties": {
        "id":          { "type": "string", "minLength": 1, "description": "Stable unique id; referenced by streams and layout." },
        "name":        { "type": "string", "minLength": 1 },
        "description": { "type": "string", "description": "May be empty string." },
        "type":        { "type": "string", "enum": ["internal", "external", "unknown"] },
        "entities":    { "type": "array", "items": { "$ref": "#/$defs/entity" } },
        "provenance":  { "$ref": "#/$defs/provenance" }
      }
    },

    "entity": {
      "type": "object",
      "required": ["id", "name", "fields"],
      "additionalProperties": false,
      "properties": {
        "id":          { "type": "string", "minLength": 1, "description": "Stable unique id; referenced by stream endpoints." },
        "name":        { "type": "string", "minLength": 1 },
        "description": { "type": "string" },
        "fields":      { "type": "array", "items": { "$ref": "#/$defs/field" } },
        "biz_need_ids": { "type": "array", "items": { "type": "string" }, "description": "Ids of needs justifying this entity." },
        "provenance":  { "$ref": "#/$defs/provenance" }
      }
    },

    "field": {
      "type": "object",
      "required": ["id", "name"],
      "additionalProperties": false,
      "properties": {
        "id":          { "type": "string", "minLength": 1, "description": "Stable unique id; referenced by stream endpoints when fields_mode == 'list'." },
        "name":        { "type": "string", "minLength": 1 },
        "type":        { "type": "string", "description": "Free text, e.g. uuid, string, int, decimal, date. Omit if undocumented." },
        "unique":      { "type": "boolean", "description": "Tri-state: omit = not documented, true/false = documented." },
        "indexed":     { "type": "boolean", "description": "Tri-state: omit = not documented, true/false = documented." },
        "description": { "type": "string" },
        "biz_need_ids": { "type": "array", "items": { "type": "string" } },
        "provenance":  { "$ref": "#/$defs/provenance" }
      }
    },

    "endpoint": {
      "type": "object",
      "description": "One side of a stream. system_id must match a system id; entity_ids must match entities of that system; field_ids (when fields_mode == 'list') must match fields of those entities.",
      "required": ["system_id", "fields_mode"],
      "additionalProperties": false,
      "properties": {
        "system_id":   { "type": "string", "minLength": 1 },
        "entity_ids":  { "type": "array", "items": { "type": "string" }, "description": "Entities moved by this endpoint. [] when none documented." },
        "fields_mode": { "type": "string", "enum": ["all", "list", "unknown"] },
        "field_ids":   { "type": "array", "items": { "type": "string" }, "description": "Required-when fields_mode == 'list'; ignored otherwise." }
      }
    },

    "stream": {
      "type": "object",
      "required": ["id", "name", "biz_need_ids", "timing", "direction", "status", "source", "destination"],
      "additionalProperties": false,
      "properties": {
        "id":           { "type": "string", "minLength": 1, "description": "Stable unique id; referenced by flows." },
        "name":         { "type": "string", "minLength": 1 },
        "biz_need_ids": { "type": "array", "items": { "type": "string" }, "description": "Needs this stream serves. [] when none documented." },
        "timing":       { "type": "string", "enum": ["real-time", "scheduled"] },
        "api_type":     { "type": "string", "description": "Free text: REST, SOAP, GraphQL, Streaming, Kafka, DB-link, SFTP, … Omit if undocumented." },
        "data_format":  { "type": "string", "description": "Free text: JSON, XML, CSV, Avro, Parquet, fixed-width, … Omit if undocumented." },
        "direction":    { "type": "string", "enum": ["uni", "bi"] },
        "status":       { "type": "string", "enum": ["planned", "implemented", "unknown"] },
        "source":       { "$ref": "#/$defs/endpoint" },
        "destination":  { "$ref": "#/$defs/endpoint" },
        "provenance":   { "$ref": "#/$defs/provenance" }
      }
    },

    "need": {
      "type": "object",
      "required": ["id", "name", "description"],
      "additionalProperties": false,
      "properties": {
        "id":          { "type": "string", "minLength": 1, "description": "Stable unique id; referenced by streams/flows/entities/fields." },
        "name":        { "type": "string", "minLength": 1 },
        "description": { "type": "string", "description": "May be empty string." },
        "provenance":  { "$ref": "#/$defs/provenance" }
      }
    },

    "flowStep": {
      "type": "object",
      "description": "One hop of a flow. stream_id must match a stream id. stage is an explicit integer >= 1; equal stages mean fan-out/fan-in.",
      "required": ["stream_id", "stage"],
      "additionalProperties": false,
      "properties": {
        "stream_id": { "type": "string", "minLength": 1 },
        "stage":     { "type": "integer", "minimum": 1 }
      }
    },

    "flow": {
      "type": "object",
      "required": ["id", "name", "description", "biz_need_ids", "steps"],
      "additionalProperties": false,
      "properties": {
        "id":          { "type": "string", "minLength": 1 },
        "name":        { "type": "string", "minLength": 1 },
        "description": { "type": "string", "description": "May be empty string." },
        "biz_need_ids": { "type": "array", "items": { "type": "string" }, "description": "Needs the flow itself declares. Inferred needs from its streams are deduced automatically; do not duplicate them here unless explicitly declared." },
        "steps":       { "type": "array", "items": { "$ref": "#/$defs/flowStep" } },
        "provenance":  { "$ref": "#/$defs/provenance" }
      }
    },

    "nodePos": {
      "type": "object",
      "description": "Saved canvas position for one system. x/y are canvas coordinates; pinned means the user fixed it.",
      "required": ["x", "y", "pinned"],
      "additionalProperties": false,
      "properties": {
        "x":      { "type": "number" },
        "y":      { "type": "number" },
        "pinned": { "type": "boolean" }
      }
    }
  }
}
```

### Enum quick reference

| Field | Allowed values |
|-------|----------------|
| `system.type` | `internal` · `external` · `unknown` |
| `stream.timing` | `real-time` · `scheduled` |
| `stream.direction` | `uni` · `bi` |
| `stream.status` | `planned` · `implemented` · `unknown` |
| `endpoint.fields_mode` | `all` · `list` · `unknown` |
| `provenance.source` | `manual` · `imported` · `inferred` |

`stream.api_type`, `stream.data_format`, and `field.type` are **free text**
(no enum). Leave them out when the diagrams don't show them.

### Tri-state booleans

`field.unique` and `field.indexed` are **tri-state**:

- **omitted** → "not documented" (analysis treats this as a gap),
- `true` / `false` → a documented fact.

Never write `false` to mean "I don't know" — omit the key instead. This
matters for the coverage stats ("6/14 fields typed").

---

## Referential integrity checklist

Before accepting the model's output, verify:

- [ ] Every `id` is unique within its collection (systems, entities, fields,
      streams, needs, flows). Entity/field ids only need to be unique within
      their owning system, but using globally-unique slugs is safest.
- [ ] Each `stream.source.system_id` / `stream.destination.system_id`
      matches a `system.id`.
- [ ] Each `endpoint.entity_ids` entry matches an `entity.id` whose parent
      `system.id` equals the endpoint's `system_id`.
- [ ] Each `endpoint.field_ids` entry matches a `field.id` inside one of
      those entities, **and** `fields_mode == "list"`.
- [ ] Each `flow.steps[].stream_id` matches a `stream.id`.
- [ ] Every `biz_need_ids` entry (on streams, flows, entities, fields)
      matches a `need.id`.
- [ ] `layout` keys (if any) match `system.id`s.

The importer will accept the file even if some of these are wrong, but the
graph will render with dangling references. Running the checklist (or a
small validation script) before import is strongly recommended.

---

## Worked example

A tiny two-system ecosystem with one stream, one business need, and one
flow. Use this as a shape reference and as a fixture for an import smoke
test.

```json
{
  "format_version": 1,
  "project": {
    "name": "Order Demo",
    "description": "Minimal example derived from a single integration diagram."
  },
  "needs": [
    {
      "id": "need-fulfillment",
      "name": "Order Fulfillment",
      "description": "Get orders from the web shop into the fulfillment system.",
      "provenance": { "source": "imported", "confidence": 0.9 }
    }
  ],
  "systems": [
    {
      "id": "sys-shop",
      "name": "Web Shop",
      "description": "Customer-facing storefront.",
      "type": "internal",
      "entities": [
        {
          "id": "ent-order",
          "name": "Order",
          "description": "A customer order.",
          "biz_need_ids": ["need-fulfillment"],
          "fields": [
            { "id": "fld-order-id", "name": "id", "type": "uuid", "unique": true, "indexed": true, "biz_need_ids": ["need-fulfillment"] },
            { "id": "fld-order-status", "name": "status", "type": "string", "indexed": true }
          ]
        }
      ],
      "provenance": { "source": "imported", "confidence": 0.9 }
    },
    {
      "id": "sys-wms",
      "name": "Warehouse Management",
      "description": "Picks, packs and ships orders.",
      "type": "internal",
      "entities": [
        {
          "id": "ent-shipment",
          "name": "Shipment",
          "fields": [
            { "id": "fld-shipment-id", "name": "id", "type": "uuid", "unique": true }
          ]
        }
      ],
      "provenance": { "source": "imported", "confidence": 0.9 }
    }
  ],
  "streams": [
    {
      "id": "strm-shop-to-wms",
      "name": "Push new orders",
      "biz_need_ids": ["need-fulfillment"],
      "timing": "real-time",
      "api_type": "REST",
      "data_format": "JSON",
      "direction": "uni",
      "status": "implemented",
      "source":      { "system_id": "sys-shop", "entity_ids": ["ent-order"], "fields_mode": "list", "field_ids": ["fld-order-id", "fld-order-status"] },
      "destination": { "system_id": "sys-wms",  "entity_ids": ["ent-shipment"], "fields_mode": "all" },
      "provenance": { "source": "imported", "confidence": 0.85 }
    }
  ],
  "flows": [
    {
      "id": "flow-order-to-ship",
      "name": "Order to Shipment",
      "description": "An order placed on the web shop becomes a shipment in WMS.",
      "biz_need_ids": ["need-fulfillment"],
      "steps": [ { "stream_id": "strm-shop-to-wms", "stage": 1 } ],
      "provenance": { "source": "imported", "confidence": 0.7 }
    }
  ],
  "layout": {}
}
```

### Import it

With the server running (`./spaghettimapper`):

```sh
curl -sS -X POST 'http://127.0.0.1:8484/api/projects/import?name=Order%20Demo' \
  -H 'Content-Type: application/json' \
  --data-binary @order-demo.spaghetti.json
```

or open `http://127.0.0.1:8484/` and use **Import project file…**, picking any
project name. Either way IDs are preserved, so re-importing a corrected
bundle into a fresh name keeps references and layout stable.

---

## Notes on what the importer does (and doesn't) enforce

The import path (`store.ImportProject`) is intentionally lenient so shared
bundles never fail to load. Concretely it:

- forces `project.schema_version` to the current value and sets
  `created_at`/`updated_at` to now,
- defaults any nil `systems`/`streams`/`needs`/`flows`/`layout` to empty,
- assigns ids to **entities and fields** that arrive with an empty `id`,
  clamps flow `stage < 1` to `1`, and defaults nil slices to `[]`.

It does **not** run the enum/required validation that the create/edit
endpoints run, and it does **not** check that referenced ids exist. That is
why the schema and the integrity checklist above exist — they encode the
constraints that make the bundle *useful*, not merely *importable*. If you
want a hard gate, validate the model's output against this JSON Schema
(with a 2020-12 compliant validator) and run the referential-integrity
checks before importing.