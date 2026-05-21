package persona

import (
	"crypto/sha256"
	"encoding/hex"
)

// OneesamaPIStablePromptText returns the foreground Pi stable prompt prefix.
// The Request parameter exists so tests can prove dynamic request data does
// not influence this stable cache surface.
func OneesamaPIStablePromptText(req Request) string {
	return oneesamaPISystemPrompt(req)
}

// OneesamaPIStablePromptHash returns a deterministic hash for the foreground
// Pi stable prompt prefix. Dynamic workspace context must not change it.
func OneesamaPIStablePromptHash(req Request) string {
	return stableHarnessSHA256(OneesamaPIStablePromptText(req))
}

func stableHarnessSHA256(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
