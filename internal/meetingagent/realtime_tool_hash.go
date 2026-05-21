package meetingagent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// RealtimeToolSchemaStableHash returns a deterministic hash of the foreground
// realtime tool schema surface after canonical JSON encoding.
func RealtimeToolSchemaStableHash(includeDemoSurface bool) (string, error) {
	payload, err := json.Marshal(realtimeToolSchemas(includeDemoSurface))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}
