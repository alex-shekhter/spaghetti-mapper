package main

import (
	"crypto/tls"
	"embed"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"spaghettimapper/internal/api"
	"spaghettimapper/internal/auth"
	"spaghettimapper/internal/store"
	smTLS "spaghettimapper/internal/tls"
	"spaghettimapper/internal/vcs"
)

//go:embed all:web
var embedded embed.FS

// assetFS returns the frontend filesystem: live disk in dev mode (instant
// HTML/CSS/JS reloads), embedded files in prod (single-binary distribution).
func assetFS(dev bool, log *slog.Logger) fs.FS {
	if dev {
		log.Info("serving assets from live disk (dev mode)", "dir", "web")
		return os.DirFS("web")
	}
	sub, err := fs.Sub(embedded, "web")
	if err != nil {
		panic(err)
	}
	return sub
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8484", "listen address")
	dev := flag.Bool("dev", false, "serve assets from ./web on disk instead of the embedded copy")
	dataDir := flag.String("data", "", "data directory (default ~/.spaghettimapper)")
	noAuth := flag.Bool("no-auth", false, "disable user identity/auth (open API; for e2e/CI)")
	tlsMode := flag.String("tls", "off", "TLS mode: off | self (self-signed cert)")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	if *dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Error("resolve home dir", "err", err)
			os.Exit(1)
		}
		*dataDir = filepath.Join(home, ".spaghettimapper")
	}

	st, err := store.New(*dataDir)
	if err != nil {
		log.Error("init store", "err", err)
		os.Exit(1)
	}

	vm := vcs.NewManager(*dataDir)

	as, err := auth.New(*dataDir)
	if err != nil {
		log.Error("init auth", "err", err)
		os.Exit(1)
	}

	// self-signed TLS implies a secure origin, so session cookies can be
	// flagged Secure. Plain HTTP keeps them insecure so they aren't dropped.
	secure := *tlsMode != "off"

	mux := http.NewServeMux()
	apiclient := api.New(st, as, vm, log, !*noAuth, secure)
	apiclient.Register(mux)
	// Product welcome / marketing page (embedded web/landing.html). Clean URL
	// for the auth-gate footer and external links; assets stay under /landing.html.
	mux.Handle("GET /welcome", http.RedirectHandler("/landing.html", http.StatusFound))
	// no-cache: browsers must revalidate assets on every load, so a restarted
	// (or recompiled) server never serves a page running stale JS modules.
	// Embedded files have no modtime, so without this Chrome would cache them
	// heuristically and mix old and new frontend code across updates.
	mux.Handle("/", noCache(http.FileServerFS(assetFS(*dev, log))))

	handler := as.Middleware(!*noAuth, requestLogger(log, noCache(apiclient.CommitMiddleware(mux))))

	server := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	scheme := "http"
	if *tlsMode == "self" {
		certPath, keyPath, err := smTLS.SelfSignedCert(*dataDir)
		if err != nil {
			log.Error("self-signed cert", "err", err)
			os.Exit(1)
		}
		server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		scheme = "https"
		log.Info("TLS: self-signed cert", "cert", certPath,
			"hint", "browsers will warn until you trust this cert; the mkcert-style local-CA tier comes later")
		log.Info("SpaghettiMapper listening", "url", scheme+"://"+*addr, "data", *dataDir, "dev", *dev, "auth", !*noAuth)
		if err := server.ListenAndServeTLS(certPath, keyPath); err != nil {
			log.Error("server", "err", err)
			os.Exit(1)
		}
		return
	}

	log.Info("SpaghettiMapper listening", "url", scheme+"://"+*addr, "data", *dataDir, "dev", *dev, "auth", !*noAuth)
	if err := server.ListenAndServe(); err != nil {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func requestLogger(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Debug("request", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
	})
}
