package internalauth

import (
	"crypto/subtle"
	"net"
	"strings"
)

const HeaderName = "X-Oneesama-Internal-Key"

func IsAuthorized(remoteAddr string, configuredKey string, providedKey string) bool {
	if IsLoopbackRemoteAddr(remoteAddr) {
		return true
	}
	expected := strings.TrimSpace(configuredKey)
	if expected == "" {
		return false
	}
	provided := strings.TrimSpace(providedKey)
	return provided != "" && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func IsLoopbackRemoteAddr(value string) bool {
	host := strings.TrimSpace(value)
	if host == "" {
		return false
	}
	if splitHost, _, err := net.SplitHostPort(host); err == nil {
		host = splitHost
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && ip.IsLoopback()
}
