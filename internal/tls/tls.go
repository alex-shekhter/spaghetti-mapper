// Package tls provides self-signed certificates for a local-first SpaghettiMapper
// deployment. This is the "for now" tier from the design doc: a self-minted cert
// cached on disk, served over HTTPS. Browsers will warn until the user trusts
// it; the mkcert-style local-CA tier and ACME/Let's-Encrypt tier are later
// upgrades behind the same SelfSignedCert entry point.
package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

const (
	certFile = "self.crt"
	keyFile  = "self.key"
	validFor = 10 * 365 * 24 * time.Hour // ~10y; local tool, long-lived is fine
)

// SelfSignedCert returns paths to a cert/key pair under dir, generating and
// caching them on first call. The certificate is valid for localhost, the
// loopback IPs, and the machine's hostname. Reuses an existing pair if
// present so a restart keeps serving the same cert (and the user's trust
// decision, if they accepted it).
func SelfSignedCert(dir string) (certPath, keyPath string, err error) {
	d := filepath.Join(dir, "tls")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", "", fmt.Errorf("create tls dir: %w", err)
	}
	certPath = filepath.Join(d, certFile)
	keyPath = filepath.Join(d, keyFile)
	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			return certPath, keyPath, nil // cached
		}
	}
	if err := generate(certPath, keyPath); err != nil {
		return "", "", err
	}
	return certPath, keyPath, nil
}

func generate(certPath, keyPath string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	host, _ := os.Hostname()

	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"SpaghettiMapper"},
			CommonName:   "localhost",
		},
		NotBefore: time.Now().Add(-time.Hour),
		NotAfter:  time.Now().Add(validFor),
		KeyUsage:  x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageServerAuth,
		},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost", host},
	}
	if ip := net.ParseIP("127.0.0.1"); ip != nil {
		tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
	}
	if ip := net.ParseIP("::1"); ip != nil {
		tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("create certificate: %w", err)
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}
	return writePEM(keyPath, "EC PRIVATE KEY", keyDER, 0o600)
}

func writePEM(path, blockType string, der []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: blockType, Bytes: der})
}
