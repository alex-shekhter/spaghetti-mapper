package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type contextKey int

const userKey contextKey = iota

const (
	// CookieName is the session cookie.
	CookieName = "sm_sess"
	// BearerPrefix in the Authorization header.
	BearerPrefix = "Bearer "
)

// UserFromContext returns the architect id for the request, and whether a
// user is present. When auth is disabled or the store is in setup mode (no
// users yet), ok is false and id is "" — handlers treat that as an anonymous
// local caller.
func UserFromContext(ctx context.Context) (id string, ok bool) {
	v, present := ctx.Value(userKey).(string)
	if !present {
		return "", false
	}
	return v, true
}

// Middleware gates /api behind a session cookie or bearer token. Behaviour:
//
//   - Non-/api paths (the SPA, css, js) always pass through.
//   - /api/auth/* is always reachable (login, setup, me) — but a valid
//     credential is still attached to the context so /me and /tokens work.
//   - When the store has no users (first run), every /api request passes as
//     anonymous — "setup mode" so the setup screen can create the first user.
//   - Otherwise /api requires a valid session or token; missing/expired →
//     401 with a JSON body.
//
// When enabled is false the middleware is a pass-through (used by -no-auth).
func (s *Store) Middleware(enabled bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static assets and the SPA shell load without auth so the login
		// page can render.
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if !enabled {
			next.ServeHTTP(w, r)
			return
		}
		uid := s.resolve(r)
		// /api/auth/* is always reachable, but attach the user if present
		// so /me and /tokens resolve the caller.
		if strings.HasPrefix(r.URL.Path, "/api/auth/") {
			if uid != "" {
				ctx := context.WithValue(r.Context(), userKey, uid)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if uid == "" {
			if !s.HasUsers() {
				// Setup mode: open until the first user is created.
				next.ServeHTTP(w, r)
				return
			}
			writeUnauth(w)
			return
		}
		ctx := context.WithValue(r.Context(), userKey, uid)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// resolve returns the architect id from a bearer token or session cookie,
// preferring an Authorization header (typical for AI agents).
func (s *Store) resolve(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, BearerPrefix) {
		if uid, ok := s.VerifyToken(strings.TrimPrefix(h, BearerPrefix)); ok {
			return uid
		}
	}
	if c, err := r.Cookie(CookieName); err == nil {
		if uid, ok := s.VerifySession(c.Value); ok {
			return uid
		}
	}
	return ""
}

func writeUnauth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
}

// SetSessionCookie writes the login cookie. secure follows whether the
// server is on TLS so the cookie isn't dropped over plain HTTP.
func (s *Store) SetSessionCookie(w http.ResponseWriter, token string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(SessionLifetime.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// ClearSessionCookie expires the cookie.
func (s *Store) ClearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure,
	})
}
