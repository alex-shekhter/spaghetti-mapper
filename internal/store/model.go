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
	// SystemCount / StreamCount are list-only enrichments (DR-2 home cards).
	// Omitted from project.json writes via omitempty when zero; ListProjects
	// fills them from systems.json / streams.json on disk.
	SystemCount int `json:"system_count,omitempty"`
	StreamCount int `json:"stream_count,omitempty"`
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

// Cluster is a named grouping of systems — a domain, estate, or island —
// with its own business justification. Deleting a cluster never deletes
// its systems. Overlapping membership is allowed.
type Cluster struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	SystemIDs   []string    `json:"system_ids"`
	Color       string      `json:"color,omitempty"` // palette key; "" = auto-assign client-side
	BizNeedIDs  []string    `json:"biz_need_ids,omitempty"`
	Provenance  *Provenance `json:"provenance,omitempty"`
}

// ClusterColors are the allowed palette keys (renderer owns the hex values).
var ClusterColors = []string{
	"verdigris", "iris", "moss", "rosewood",
	"ochre", "glacier", "plum", "fog",
}

// NodePos is a saved canvas position for one system, so the user's spatial
// mental map survives restarts.
type NodePos struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Pinned bool    `json:"pinned"`
}

// Thumb is the compact payload for a version-history thumbnail: node ids +
// their saved positions + types, and one unordered edge per system pair that
// shares a stream. Built from a CommitVolume's systems.json + layout.json so
// the History popover can render a mini-SVG of any past version without
// running the force simulation.
type ThumbNode struct {
	ID   string  `json:"id"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Type string  `json:"type"`
}
type ThumbEdge struct {
	A string `json:"a"`
	B string `json:"b"`
}

// ThumbCluster is the mini-renderer plate payload: hue key + membership only
// (no id/name — history thumbs identify a version by shape + color).
type ThumbCluster struct {
	Color     string   `json:"color,omitempty"`
	SystemIDs []string `json:"system_ids"`
}

type Thumb struct {
	Nodes    []ThumbNode    `json:"nodes"`
	Edges    []ThumbEdge    `json:"edges"`
	Clusters []ThumbCluster `json:"clusters,omitempty"`
}

// Display holds per-project canvas display preferences (persisted in
// display.json), so choices like the Bundle/Expand edge mode and the fan
// spacing between parallel strands survive restarts and travel with the
// project on export/import. Zero values mean "use defaults".
type Display struct {
	Expand         bool          `json:"expand"`           // true = one curve per stream (Expand), false = Bundle
	FanSpacing     float64       `json:"fan_spacing"`      // px between parallel strands in Expand mode (0 = default)
	HideEdgeLabels bool          `json:"hide_edge_labels"`  // true = hide stream name labels on edges
	FilterEnabled  *bool         `json:"filter_enabled,omitempty"` // true = filter is active, false = bypassed
	Filters        *FilterConfig `json:"filters,omitempty"` // saved filter conditions
}

type FilterQuery struct {
	Q     string `json:"q"`
	Scope string `json:"scope"`
}

type FilterConfig struct {
	// Q/Scope were the persisted HUD draft; the UI no longer writes them
	// (drafts are session-ephemeral) but old display.json files may carry them.
	Q        string        `json:"q,omitempty"`
	Scope    string        `json:"scope,omitempty"`
	Queries  []FilterQuery `json:"queries,omitempty"`
	Statuses []string      `json:"statuses,omitempty"`
	Timings  []string      `json:"timings,omitempty"`
	Needs    []string      `json:"needs,omitempty"`
	Systems  []string      `json:"systems,omitempty"`
	// Clusters are live references into the project's clusters (GS-5 A1).
	// Matching expands each id to the cluster's *current* members client-side;
	// the server only stores the ids (pass-through, same lifecycle as Systems).
	Clusters []string `json:"clusters,omitempty"`
	Flow     string   `json:"flow,omitempty"`
}

// UserState is per-project, per-architect viewer state: the committed filter
// chips (including optional flow) and whether filtering is enabled. Filters
// are what a person is looking at — not part of the map — so this lives
// outside the project's git volume (never versioned, merged, or exported).
// Display's Filters/FilterEnabled fields remain only so legacy display.json
// files still parse.
//
// FocusedFlow is a legacy top-level field from a brief experiment; current
// clients store the flow id under Filters.Flow and still read FocusedFlow
// on load for migration.
type UserState struct {
	FilterEnabled *bool         `json:"filter_enabled,omitempty"`
	FocusedFlow   string        `json:"focused_flow,omitempty"` // legacy; prefer Filters.Flow
	Filters       *FilterConfig `json:"filters,omitempty"`
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
