package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"spaghettimapper/internal/auth"
	"spaghettimapper/internal/store"
	"spaghettimapper/internal/vcs"
)

func testAPI(t *testing.T) (*API, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	as, err := auth.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	vm := vcs.NewManager(dir)
	a := New(st, as, vm, slog.New(slog.NewTextHandler(io.Discard, nil)), false, false)
	if _, err := st.CreateProject("Demo", ""); err != nil {
		t.Fatal(err)
	}
	// seed a minimal systems.json so GetGraph works after vcs open
	if err := os.WriteFile(filepath.Join(dir, "Demo", "systems.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Demo", "streams.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Demo", "needs.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Demo", "flows.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Demo", "clusters.json"), []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	return a, dir
}

func TestReportGETHeadersAndZip(t *testing.T) {
	a, _ := testAPI(t)
	mux := http.NewServeMux()
	a.Register(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/projects/Demo/report", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.Contains(ct, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
		t.Errorf("Content-Type=%q", ct)
	}
	cd := rec.Header().Get("Content-Disposition")
	if !strings.Contains(cd, "integration-register") || !strings.HasSuffix(strings.Trim(cd, `"`), ".xlsx") && !strings.Contains(cd, ".xlsx") {
		t.Errorf("Content-Disposition=%q", cd)
	}
	b := rec.Body.Bytes()
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' {
		t.Fatalf("body not zip magic: %v", b[:min(4, len(b))])
	}
}

func TestReportPOSTOversizedMapPNG(t *testing.T) {
	a, _ := testAPI(t)
	mux := http.NewServeMux()
	a.Register(mux)

	// 4 MB + 1 of zeros, base64-encoded
	raw := make([]byte, 4*1024*1024+1)
	body, _ := json.Marshal(map[string]string{
		"map_png": base64.StdEncoding.EncodeToString(raw),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/Demo/report", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d want 400, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "4 MB") {
		t.Errorf("body=%s", rec.Body.String())
	}
}

func TestReportPOSTTinyPNG(t *testing.T) {
	a, _ := testAPI(t)
	mux := http.NewServeMux()
	a.Register(mux)

	const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	body, _ := json.Marshal(map[string]string{"map_png": pngB64})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/Demo/report", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	b := rec.Body.Bytes()
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' {
		t.Fatalf("not zip")
	}
}

// RF-1: base64 that decodes but is not a PNG must be 400, not excelize 500.
func TestReportPOSTJunkMapPNG(t *testing.T) {
	a, _ := testAPI(t)
	mux := http.NewServeMux()
	a.Register(mux)

	junk := make([]byte, 100)
	for i := range junk {
		junk[i] = byte(i + 1)
	}
	body, _ := json.Marshal(map[string]string{
		"map_png": base64.StdEncoding.EncodeToString(junk),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/Demo/report", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d want 400, body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "map_png is not a valid PNG") {
		t.Errorf("body=%s", rec.Body.String())
	}
}
