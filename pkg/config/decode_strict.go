package config

// DecodeStrict re-runs the runtime loader's strict-JSON contract against
// arbitrary bytes. It is exposed so the YAML→JSON migration CLI
// (cmd/oneesama-config-migrate) can enforce the same DisallowUnknownFields
// rule the runtime enforces — that way a cueboard-era key that
// oneesama-go-rewrite has dropped fails at migration time, not at the
// next runtime startup.
//
// Returning the loader's actual error string means callers see
// `json: unknown field "agent_framework_path"` style messages that
// pinpoint the dead key.
func DecodeStrict(jsonBytes []byte) error {
	var raw rawConfig
	return decodeRawConfigStrict(jsonBytes, &raw)
}
