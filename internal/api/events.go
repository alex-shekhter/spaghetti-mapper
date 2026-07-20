package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Event is a project-level notification pushed to subscribed SSE clients.
// The frontend re-fetches the architects list (and, on a merge, the graph)
// when it receives one — payloads are intentionally minimal.
type Event struct {
	Type string `json:"type"` // "commit" | "merge" | "abort"
	Arch string `json:"arch,omitempty"`
	Msg  string `json:"msg,omitempty"`
	TS   int64  `json:"ts"`
}

// hub is a tiny per-project pub/sub. Subscribers get a buffered channel;
// publishers never block (a full channel drops the event — SSE is
// best-effort; the client will catch up on the next event or a manual refresh).
type hub struct {
	mu   sync.Mutex
	subs map[string]map[chan Event]struct{}
}

func newHub() *hub { return &hub{subs: map[string]map[chan Event]struct{}{}} }

func (h *hub) subscribe(proj string) chan Event {
	ch := make(chan Event, 4)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[proj] == nil {
		h.subs[proj] = map[chan Event]struct{}{}
	}
	h.subs[proj][ch] = struct{}{}
	return ch
}

func (h *hub) unsubscribe(proj string, ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m, ok := h.subs[proj]; ok {
		delete(m, ch)
		if len(m) == 0 {
			delete(h.subs, proj)
		}
	}
}

func (h *hub) publish(proj string, ev Event) {
	if ev.TS == 0 {
		ev.TS = time.Now().Unix()
	}
	h.mu.Lock()
	subs := h.subs[proj]
	h.mu.Unlock()
	for ch := range subs {
		select {
		case ch <- ev:
		default: // drop if subscriber is slow
		}
	}
}

// events is the SSE endpoint: GET /api/projects/{proj}/events. It stays open
// until the client disconnects, streaming one `data:` line per event.
func (a *API) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush() // open the stream immediately

	proj := r.PathValue("proj")
	ch := a.hub.subscribe(proj)
	defer a.hub.unsubscribe(proj, ch)

	// Heartbeat so proxies don't idle-timeout the connection.
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			b, _ := json.Marshal(ev)
			w.Write([]byte("data: "))
			w.Write(b)
			w.Write([]byte("\n\n"))
			flusher.Flush()
		case <-tick.C:
			w.Write([]byte(": keep-alive\n\n"))
			flusher.Flush()
		}
	}
}
