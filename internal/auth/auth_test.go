package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSetupModeOpensUntilFirstUser(t *testing.T) {
	s := newTestStore(t)
	if s.HasUsers() {
		t.Fatal("expected setup mode (no users) on fresh store")
	}
	h := s.Middleware(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if uid, ok := UserFromContext(r.Context()); ok {
			t.Errorf("setup mode should not attach a user, got %q", uid)
		}
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup mode should allow /api, got %d", rec.Code)
	}
}

func TestPasswordMinLength(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateUser("alice", "Alice", "short", true); !errors.Is(err, ErrPasswordShort) {
		t.Fatalf("expected ErrPasswordShort, got %v", err)
	}
	if _, err := s.CreateUser("alice", "Alice", "12345678", true); err != nil {
		t.Fatalf("8-char password should be accepted: %v", err)
	}
}

func TestFirstUserIsAdmin(t *testing.T) {
	s := newTestStore(t)
	u, err := s.CreateUser("alice", "Alice", "hunter22", true)
	if err != nil {
		t.Fatal(err)
	}
	if !u.IsAdmin || u.ID != "alice" {
		t.Fatalf("unexpected user %+v", u)
	}
	if u.Password != "" {
		t.Fatal("returned user must not carry the password hash")
	}
	if !s.HasUsers() {
		t.Fatal("expected HasUsers true after creating a user")
	}
}

func TestVerifyAndSessionRoundTrip(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateUser("alice", "Alice", "hunter22", true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Verify("alice", "wrong"); err != ErrBadPassword {
		t.Fatalf("expected ErrBadPassword, got %v", err)
	}
	if _, err := s.Verify("alice", "hunter22"); err != nil {
		t.Fatalf("verify: %v", err)
	}
	token, exp := s.IssueSession("alice")
	if exp.IsZero() {
		t.Fatal("expected non-zero expiry")
	}
	if uid, ok := s.VerifySession(token); !ok || uid != "alice" {
		t.Fatalf("session verify failed: uid=%q ok=%v", uid, ok)
	}
	dot := indexByte(token, '.')
	tampered := token[:dot] + ".bogus"
	if _, ok := s.VerifySession(tampered); ok {
		t.Fatal("tampered session must not verify")
	}
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func TestMiddlewareAfterSetup(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateUser("alice", "Alice", "hunter22", true); err != nil {
		t.Fatal(err)
	}
	token, _ := s.IssueSession("alice")

	cases := []struct {
		name   string
		path   string
		bearer string // Authorization header
		cookie bool   // attach a valid session cookie
		want   int
	}{
		{"no cred", "/api/projects", "", false, http.StatusUnauthorized},
		{"session cookie", "/api/projects", "", true, http.StatusOK},
		{"session as bearer is not an API token", "/api/projects", "Bearer " + token, false, http.StatusUnauthorized},
		{"auth path always open", "/api/auth/login", "", false, http.StatusOK},
		{"static path open", "/index.html", "", false, http.StatusOK},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := s.Middleware(true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, c.path, nil)
			if c.bearer != "" {
				req.Header.Set("Authorization", c.bearer)
			} else if c.cookie {
				req.AddCookie(&http.Cookie{Name: CookieName, Value: token})
			}
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("%s: got %d want %d", c.name, rec.Code, c.want)
			}
		})
	}
}

func TestAPITokenRoundTrip(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateUser("alice", "Alice", "hunter22", true); err != nil {
		t.Fatal(err)
	}
	id, secret, err := s.CreateToken("alice", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if id == "" || secret == "" {
		t.Fatal("expected non-empty id and secret")
	}
	uid, ok := s.VerifyToken(secret)
	if !ok || uid != "alice" {
		t.Fatalf("token verify failed: uid=%q ok=%v", uid, ok)
	}
	if _, ok := s.VerifyToken("deadbeef"); ok {
		t.Fatal("bogus token must not verify")
	}
	list := s.ListTokens("alice")
	if len(list) != 1 || list[0].Hash != "" {
		t.Fatalf("unexpected token list: %+v", list)
	}
	if err := s.DeleteToken("alice", id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := s.VerifyToken(secret); ok {
		t.Fatal("deleted token must not verify")
	}
}

func TestSecretPersistsAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	s1, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s1.CreateUser("alice", "Alice", "hunter22", true); err != nil {
		t.Fatal(err)
	}
	tok1, _ := s1.IssueSession("alice")

	s2, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if uid, ok := s2.VerifySession(tok1); !ok || uid != "alice" {
		t.Fatalf("session must survive restart, got uid=%q ok=%v", uid, ok)
	}
	for _, f := range []string{"auth/users.json", "auth/auth.key"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatalf("missing %s: %v", f, err)
		}
	}
}
