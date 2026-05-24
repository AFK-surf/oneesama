package postmeeting

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const maxProviderResponseBodyBytes = 4 << 20

var defaultProviderHTTPClient = &http.Client{Timeout: 2 * time.Minute}

func httpClient(client *http.Client) *http.Client {
	if client != nil {
		return client
	}
	return defaultProviderHTTPClient
}

func readProviderResponseBody(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxProviderResponseBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxProviderResponseBodyBytes {
		return nil, fmt.Errorf("provider response body exceeds %d bytes", maxProviderResponseBodyBytes)
	}
	return body, nil
}

func providerRequestError(label string, err error) error {
	op := ""
	for {
		var urlErr *url.Error
		if !errors.As(err, &urlErr) {
			break
		}
		if op == "" {
			op = urlErr.Op
		}
		err = urlErr.Err
	}
	if op != "" {
		return fmt.Errorf("%s request: %s: %w", label, op, err)
	}
	return fmt.Errorf("%s request: %w", label, err)
}

func providerURLWithAPIKey(rawURL, apiKey string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("key", firstNonEmpty(apiKey))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
