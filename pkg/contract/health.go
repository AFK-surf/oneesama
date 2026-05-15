package contract

type HealthResponse struct {
	OK              bool   `json:"ok"`
	Service         string `json:"service"`
	Version         string `json:"version,omitempty"`
	BundleVersion   string `json:"bundle_version,omitempty"`
	AgentSDKVersion string `json:"agent_sdk_version,omitempty"`
}
