package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

const meetdInternalSecretsFile = "internal-secrets.json"

type runtimeSecrets struct {
	MeetdWebhookSecret string `json:"meetd_webhook_secret"`
}

func applyDerivedRuntimeDefaults(cfg *Config) error {
	if strings.TrimSpace(cfg.Meetd.CalibrateModel) == "" {
		cfg.Meetd.CalibrateModel = strings.TrimSpace(cfg.Meetd.SummaryModel)
	}
	if strings.TrimSpace(cfg.Meetd.WebhookURL) == "" {
		cfg.Meetd.WebhookURL = defaultMeetdWebhookURL(cfg.SlackAgent.Listen)
	}
	if strings.TrimSpace(cfg.Meetd.WebhookSecret) != "" {
		return nil
	}
	secret, err := loadOrCreateMeetdWebhookSecret(cfg.Persistence)
	if err != nil {
		return err
	}
	cfg.Meetd.WebhookSecret = secret
	return nil
}

func defaultMeetdWebhookURL(slackListen string) string {
	baseURL := localHTTPBaseURL(slackListen)
	if baseURL == "" {
		return ""
	}
	return strings.TrimRight(baseURL, "/") + "/webhooks/meeting-result"
}

func localHTTPBaseURL(listen string) string {
	address := strings.TrimSpace(listen)
	switch {
	case address == "":
		return ""
	case strings.HasPrefix(address, "http://") || strings.HasPrefix(address, "https://"):
		return strings.TrimRight(address, "/")
	case strings.HasPrefix(address, ":"):
		return "http://127.0.0.1" + address
	}
	host, port, err := net.SplitHostPort(address)
	if err == nil {
		switch strings.Trim(host, "[]") {
		case "", "0.0.0.0", "::":
			host = "127.0.0.1"
		}
		return "http://" + net.JoinHostPort(host, port)
	}
	if strings.HasPrefix(address, "0.0.0.0:") {
		return "http://127.0.0.1:" + strings.TrimPrefix(address, "0.0.0.0:")
	}
	return "http://" + address
}

func loadOrCreateMeetdWebhookSecret(cfg PersistenceConfig) (string, error) {
	dataDir := strings.TrimSpace(cfg.DataDir)
	if dataDir == "" {
		dataDir = defaultPersistenceDataDir
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("create runtime secret dir: %w", err)
	}
	path := filepath.Join(dataDir, meetdInternalSecretsFile)
	if secret, err := readMeetdWebhookSecret(path); err == nil && secret != "" {
		return secret, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	secret, err := newHexSecret(32)
	if err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(runtimeSecrets{MeetdWebhookSecret: secret}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal runtime secret: %w", err)
	}
	payload = append(payload, '\n')
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return readMeetdWebhookSecret(path)
	}
	if err != nil {
		return "", fmt.Errorf("create runtime secret file: %w", err)
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(payload); err != nil {
		return "", fmt.Errorf("write runtime secret file: %w", err)
	}
	return secret, nil
}

func readMeetdWebhookSecret(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var secrets runtimeSecrets
	if err := json.Unmarshal(data, &secrets); err != nil {
		return "", fmt.Errorf("parse runtime secret file: %w", err)
	}
	return strings.TrimSpace(secrets.MeetdWebhookSecret), nil
}

func newHexSecret(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate runtime secret: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}
