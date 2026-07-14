package store

import "time"

// CurrentSchema is written to project.json; projects below it are migrated
// on server startup (see migrate.go).
const CurrentSchema = 2

// Provenance records where a fact came from, so machine-generated data is
// always distinguishable from human-entered data. Absent = manual.
type Provenance struct {
	Source     string  `json:"source,omitempty"`     // manual | imported | inferred
	Confidence float64 `json:"confidence,omitempty"` // 0..1, meaningful for inferred
}

// Project is the top-level container for one architecture map.
// Each project lives in its own directory under the store root.
type Project struct {
	Name          string    `json:"name"`
	Description   string    `json:"description"`
	SchemaVersion int       `json:"schema_version"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// Field belongs to an Entity in a system's data catalog.
// Unique/Indexed are tri-state: nil means "not documented", which analysis
// must treat differently from a documented false.
// BizNeedIDs is the justification layer: which business needs justify this
// field existing/moving at all. Empty = nobody has justified it yet.
type Field struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Type        string      `json:"type,omitempty"`
	Unique      *bool       `json:"unique,omitempty"`
	Indexed     *bool       `json:"indexed,omitempty"`
	Description string      `json:"description,omitempty"`
	BizNeedIDs  []string    `json:"biz_need_ids,omitempty"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// Entity is a named data object owned by a System (its catalog).
type Entity struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	Fields      []Field     `json:"fields"`
	BizNeedIDs  []string    `json:"biz_need_ids,omitempty"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// System is a node on the map. It owns a catalog of entities that streams
// reference by ID.
type System struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Type        string      `json:"type"` // internal | external | unknown
	Entities    []Entity    `json:"entities"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// Endpoint describes one side (source or destination) of a stream.
// EntityIDs/FieldIDs reference the endpoint system's catalog.
type Endpoint struct {
	SystemID   string   `json:"system_id"`
	EntityIDs  []string `json:"entity_ids"`
	FieldsMode string   `json:"fields_mode"` // all | list | unknown
	FieldIDs   []string `json:"field_ids"`   // when fields_mode == list
}

// Stream is an integration stream: data moving between two systems.
type Stream struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	BizNeedIDs  []string    `json:"biz_need_ids"`
	Timing      string      `json:"timing"`      // real-time | scheduled
	APIType     string      `json:"api_type"`    // REST, SOAP, Streaming, DB-link, ...
	DataFormat  string      `json:"data_format"` // JSON, XML, CSV, ...
	Direction   string      `json:"direction"`   // uni | bi
	Status      string      `json:"status"`      // planned | implemented | unknown
	Source      Endpoint    `json:"source"`
	Destination Endpoint    `json:"destination"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// FlowStep is one hop of a flow: a stream plus its explicit stage number.
// Stages are plain integers set by the user (prefilled from topology in the
// UI); several steps may share a stage — that IS fan-out/fan-in.
type FlowStep struct {
	StreamID string `json:"stream_id"`
	Stage    int    `json:"stage"`
}

// Flow is a named journey: an ordered set of streams that together implement
// one end-to-end process. Branches, cycles, and gaps are still derived from
// the streams' endpoints; only the stage numbers are stored. BizNeedIDs are
// the flow's own declared needs; needs implied by its streams are deduced
// client-side.
type Flow struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	BizNeedIDs  []string    `json:"biz_need_ids"`
	Steps       []FlowStep  `json:"steps"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// BizNeed groups streams under a business justification.
type BizNeed struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// NodePos is a saved canvas position for one system, so the user's spatial
// mental map survives restarts.
type NodePos struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Pinned bool    `json:"pinned"`
}

// Enum values accepted by validation.
var (
	SystemTypes = []string{"internal", "external", "unknown"}
	Timings     = []string{"real-time", "scheduled"}
	Directions  = []string{"uni", "bi"}
	Statuses    = []string{"planned", "implemented", "unknown"}
	FieldsModes = []string{"all", "list", "unknown"}
	Sources     = []string{"manual", "imported", "inferred"}
)
