// Package auth implements SpaghettiMapper's user identity layer.
//
// It is deliberately small and dependency-free (beyond bcrypt): users and API
// tokens are stored as JSON files under the data dir, sessions are stateless
// HMAC-signed cookies. An "architect id" — the username for a human, or the
// token owner for an AI agent — is the identity that will later become a git
// commit author and a branch namespace. No database; the no-external-deps
// promise of the app is preserved.
//
// First-run model: until the first user is created, the store is in "setup
// mode" and the API is open so the setup screen can run. Once a user exists,
// every /api request (except /api/auth/*) requires a valid session cookie or
// bearer token.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	usersFile  = "users.json"
	tokensFile = "tokens.json"
	secretFile = "auth.key"

	// SessionLifetime for a login cookie. Long enough to be ergonomic for a
	// local-first tool, short enough to limit a stolen cookie.
	SessionLifetime = 30 * 24 * time.Hour

	// tokenSecretBytes is the entropy in an API token's secret.
	tokenSecretBytes = 32
	// tokenIDBytes is the length of the public token id (16 hex chars).
	tokenIDBytes = 8

	// MinPasswordLen is enforced on create (setup + admin-created users).
	// Shown under the password field on the setup gate (DR-1).
	MinPasswordLen = 8
)

var (
	ErrNoUsers       = errors.New("no users configured")
	ErrUserExists    = errors.New("user already exists")
	ErrUserNotFound  = errors.New("user not found")
	ErrBadPassword   = errors.New("incorrect password")
	ErrPasswordShort = errors.New("password too short")
	ErrTokenNotFound = errors.New("token not found")
)

// User is a human architect. ID doubles as the architect id (git author /
// branch namespace). Password is a bcrypt hash, never the plaintext.
type User struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Password  string    `json:"password"`
	IsAdmin   bool      `json:"is_admin"`
	CreatedAt time.Time `json:"created_at"`
}

// Token is an API token (machine identity for AI agents). The bearer
// presents the secret; only its bcrypt Hash is stored. ID is the public
// handle shown in the UI.
type Token struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	UserID     string    `json:"user_id"`
	Hash       string    `json:"hash"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at,omitempty"`
}

// Store holds users, API tokens, and the HMAC secret for session cookies.
// All files live under dir (the app data dir, store-level — not inside any
// project), so identity is global to the installation, not per-project.
type Store struct {
	mu     sync.RWMutex
	dir    string
	secret []byte
	users  map[string]*User
	tokens map[string]*Token // keyed by Token.ID
}

// New opens (or creates) the auth store under dir. A random HMAC secret is
// generated on first run and reused thereafter so sessions survive restarts.
func New(dir string) (*Store, error) {
	ad := filepath.Join(dir, "auth")
	if err := os.MkdirAll(ad, 0o700); err != nil {
		return nil, fmt.Errorf("create auth dir: %w", err)
	}
	s := &Store{dir: ad, users: map[string]*User{}, tokens: map[string]*Token{}}
	if err := s.loadSecret(); err != nil {
		return nil, err
	}
	if err := s.loadUsers(); err != nil {
		return nil, err
	}
	if err := s.loadTokens(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadSecret() error {
	p := filepath.Join(s.dir, secretFile)
	b, err := os.ReadFile(p)
	if err == nil {
		if len(b) < 32 {
			return fmt.Errorf("auth key too short")
		}
		s.secret = b
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	if err := os.WriteFile(p, key, 0o600); err != nil {
		return err
	}
	s.secret = key
	return nil
}

func (s *Store) loadUsers() error {
	users, err := readJSON[map[string]*User](filepath.Join(s.dir, usersFile))
	if err != nil {
		return err
	}
	if users != nil {
		s.users = users
	}
	return nil
}

func (s *Store) loadTokens() error {
	tokens, err := readJSON[map[string]*Token](filepath.Join(s.dir, tokensFile))
	if err != nil {
		return err
	}
	if tokens != nil {
		s.tokens = tokens
	}
	return nil
}

func (s *Store) saveUsers() error {
	return writeJSON(filepath.Join(s.dir, usersFile), s.users)
}

func (s *Store) saveTokens() error {
	return writeJSON(filepath.Join(s.dir, tokensFile), s.tokens)
}

// readJSON loads a JSON file into v; a missing file yields the zero value.
func readJSON[T any](path string) (T, error) {
	var v T
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	return v, json.Unmarshal(data, &v)
}

// writeJSON writes v atomically (temp file + rename).
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// HasUsers reports whether any user exists. Until true, the store is in
// setup mode and the API is open.
func (s *Store) HasUsers() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users) > 0
}

// User returns a copy of the user by id, or nil. Never returns the stored
// pointer, so callers can't mutate state outside the lock.
func (s *Store) User(id string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if u, ok := s.users[id]; ok {
		cp := *u
		cp.Password = ""
		return &cp
	}
	return nil
}

// CreateUser adds a new user, hashing the password. The first user is an
// admin by convention.
func (s *Store) CreateUser(id, name, password string, admin bool) (*User, error) {
	if id == "" || password == "" {
		return nil, fmt.Errorf("%w: id and password required", ErrBadPassword)
	}
	if len(password) < MinPasswordLen {
		return nil, fmt.Errorf("%w: at least %d characters", ErrPasswordShort, MinPasswordLen)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.users[id]; ok {
		return nil, ErrUserExists
	}
	u := &User{ID: id, Name: name, Password: string(hash), IsAdmin: admin, CreatedAt: time.Now().UTC()}
	s.users[id] = u
	if err := s.saveUsers(); err != nil {
		delete(s.users, id)
		return nil, err
	}
	cp := *u
	cp.Password = ""
	return &cp, nil
}

// Verify checks credentials and returns the user (without the hash).
func (s *Store) Verify(id, password string) (*User, error) {
	s.mu.RLock()
	u, ok := s.users[id]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrUserNotFound
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(password)); err != nil {
		return nil, ErrBadPassword
	}
	cp := *u
	cp.Password = ""
	return &cp, nil
}

// ---- Sessions (stateless HMAC cookie) ----

// IssueSession builds a signed session token for user, valid for
// SessionLifetime. The token encodes {user, exp} and an HMAC; no server-side
// session store is needed.
func (s *Store) IssueSession(userID string) (string, time.Time) {
	exp := time.Now().UTC().Add(SessionLifetime)
	payload := encodeB64([]byte(userID + "|" + strconv.FormatInt(exp.Unix(), 10)))
	sig := s.sign(payload)
	return payload + "." + sig, exp
}

// VerifySession validates a session token and returns the user id.
func (s *Store) VerifySession(token string) (string, bool) {
	payload, sig, ok := splitToken(token)
	if !ok {
		return "", false
	}
	if !hmac.Equal([]byte(s.sign(payload)), []byte(sig)) {
		return "", false
	}
	dec, err := decodeB64(payload)
	if err != nil {
		return "", false
	}
	parts := strings.SplitN(string(dec), "|", 2)
	if len(parts) != 2 {
		return "", false
	}
	expUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", false
	}
	if time.Now().Unix() > expUnix {
		return "", false
	}
	return parts[0], true
}

func (s *Store) sign(payload string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	return encodeB64(mac.Sum(nil))
}

func splitToken(t string) (payload, sig string, ok bool) {
	for i := len(t) - 1; i >= 0; i-- {
		if t[i] == '.' {
			return t[:i], t[i+1:], true
		}
	}
	return "", "", false
}

// ---- API tokens (machine identity for AI agents) ----

// CreateToken issues a new API token for user. The secret is returned once;
// only its bcrypt hash is kept.
func (s *Store) CreateToken(userID, name string) (id, secret string, err error) {
	sec := make([]byte, tokenSecretBytes)
	if _, err := rand.Read(sec); err != nil {
		return "", "", err
	}
	hash, err := bcrypt.GenerateFromPassword(sec, bcrypt.DefaultCost)
	if err != nil {
		return "", "", err
	}
	idB := make([]byte, tokenIDBytes)
	if _, err := rand.Read(idB); err != nil {
		return "", "", err
	}
	id = hex.EncodeToString(idB)
	t := &Token{ID: id, Name: name, UserID: userID, Hash: string(hash), CreatedAt: time.Now().UTC()}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[id] = t
	if err := s.saveTokens(); err != nil {
		delete(s.tokens, id)
		return "", "", err
	}
	return id, hex.EncodeToString(sec), nil
}

// VerifyToken looks up an API token by its secret, updating LastUsedAt.
func (s *Store) VerifyToken(secret string) (string, bool) {
	b, err := hex.DecodeString(secret)
	if err != nil || len(b) == 0 {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.tokens {
		if bcrypt.CompareHashAndPassword([]byte(t.Hash), b) == nil {
			t.LastUsedAt = time.Now().UTC()
			_ = s.saveTokens()
			return t.UserID, true
		}
	}
	return "", false
}

// ListTokens returns the caller's tokens (without hashes).
func (s *Store) ListTokens(userID string) []Token {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Token{}
	for _, t := range s.tokens {
		if t.UserID == userID {
			cp := *t
			cp.Hash = ""
			out = append(out, cp)
		}
	}
	return out
}

// DeleteToken removes one of the caller's tokens.
func (s *Store) DeleteToken(userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[id]
	if !ok || t.UserID != userID {
		return ErrTokenNotFound
	}
	delete(s.tokens, id)
	return s.saveTokens()
}

func encodeB64(b []byte) string          { return base64.RawURLEncoding.EncodeToString(b) }
func decodeB64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }
