// Package volume is the storage substrate the store reads and writes through.
// It has two implementations (in package vcs): a disk-backed volume for the
// project's main line (the on-disk working tree) and a git-tree-backed volume
// for an architect's branch. Keeping the interface in its own package lets
// the store depend on it without importing vcs (which would create a cycle,
// since vcs needs the store's ProjectDir).
package volume

import "os"

// Volume is a read/write/commit view over a project's files. Names are
// project-relative (e.g. "systems.json"). A missing file reads as an error
// satisfying os.IsNotExist.
type Volume interface {
	Read(name string) ([]byte, error)
	Write(name string, data []byte) error
	Exists(name string) bool
	// Commit persists staged writes. For a disk volume this commits the
	// working tree to the main line; for a branch volume this flushes the
	// in-memory buffer to the branch ref. Best-effort identity (architect)
	// and a message are attached as the commit author/message.
	Commit(architectID, architectName, msg string) error
	// CanTrash reports whether deleted items should be preserved in a .trash/
	// folder on disk (the main line's recoverable-delete feature). Branches
	// recover via git history and .trash is gitignored, so they return false.
	CanTrash() bool
	// IsBranch reports whether this is an architect's branch (vs the main
	// line). The store uses it to skip the global working-tree mutex for
	// branches, which don't touch the working tree.
	IsBranch() bool
	// Release frees any per-branch write lock held when the volume was
	// created for writing. No-op for disk volumes and branch read volumes.
	Release()
}

// IsNotExist reports whether err is a missing-file error.
func IsNotExist(err error) bool { return err != nil && os.IsNotExist(err) }
