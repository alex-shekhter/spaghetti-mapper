package main

import (
	"embed"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"spaghettimapper/internal/api"
	"spaghettimapper/internal/store"
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

	mux := http.NewServeMux()
	api.New(st, log).Register(mux)
	// no-cache: browsers must revalidate assets on every load, so a restarted
	// (or recompiled) server never serves a page running stale JS modules.
	// Embedded files have no modtime, so without this Chrome would cache them
	// heuristically and mix old and new frontend code across updates.
	mux.Handle("/", noCache(http.FileServerFS(assetFS(*dev, log))))

	server := &http.Server{
		Addr:              *addr,
		Handler:           requestLogger(log, mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Info("SpaghettiMapper listening", "url", "http://"+*addr, "data", *dataDir, "dev", *dev)
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
