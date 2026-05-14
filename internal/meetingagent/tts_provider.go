package meetingagent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os/exec"
	"strings"
	"unicode/utf8"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const ttsSampleRate = 24000

func (s *Service) SynthesizeTTS(ctx context.Context, input TTSSynthesizeRequest) (TTSSynthesizeResponse, int) {
	payload := normalizeTTSPayload(input, s.dialog)
	provider := normalizeTTSProvider(s.dialog.TTSProvider)
	if strings.TrimSpace(payload.Text) == "" {
		return TTSSynthesizeResponse{"ok": false, "provider": provider, "error": "text_required"}, http.StatusBadRequest
	}

	switch provider {
	case "tone", "tone-wav":
		return synthesizeToneWav(payload), http.StatusOK
	case "command":
		result := s.runCommandTTS(ctx, payload)
		return result, statusForTTSResult(result)
	case "http", "http-json":
		result := s.runHTTPTTS(ctx, payload)
		return result, statusForTTSResult(result)
	default:
		return TTSSynthesizeResponse{"ok": false, "provider": provider, "error": "Unsupported MAB_TTS_PROVIDER provider: " + provider}, http.StatusBadRequest
	}
}

type normalizedTTSPayload struct {
	Text       string         `json:"text"`
	Voice      string         `json:"voice"`
	Format     string         `json:"format"`
	DurationMs int            `json:"durationMs,omitempty"`
	Frequency  float64        `json:"frequency,omitempty"`
	Gain       float64        `json:"gain,omitempty"`
	Context    map[string]any `json:"context"`
}

func normalizeTTSPayload(input TTSSynthesizeRequest, cfg appconfig.DialogConfig) normalizedTTSPayload {
	gain := 0.0
	if input.Gain != nil {
		gain = *input.Gain
	}
	return normalizedTTSPayload{
		Text:       stringOrEmpty(input.Text),
		Voice:      firstNonEmpty(input.Voice, cfg.TTSVoice),
		Format:     firstNonEmpty(input.Format, "wav"),
		DurationMs: input.DurationMs,
		Frequency:  input.Frequency,
		Gain:       gain,
		Context:    cloneMap(input.Context),
	}
}

func synthesizeToneWav(input normalizedTTSPayload) TTSSynthesizeResponse {
	textLength := utf8.RuneCountInString(input.Text)
	durationMs := clampFloat(firstPositive(float64(input.DurationMs), 650+float64(textLength)*28), 450, 3600)
	frequency := clampFloat(firstPositive(input.Frequency, 420+float64(textLength%11)*24), 180, 1200)
	gain := clampFloat(firstPositive(input.Gain, 0.16), 0.001, 0.8)
	samples := make([]float32, int(math.Ceil(ttsSampleRate*durationMs/1000)))
	fadeSamples := minInt(int(ttsSampleRate*0.04), len(samples)/2)
	for index := range samples {
		t := float64(index) / ttsSampleRate
		fadeIn := 1.0
		fadeOut := 1.0
		if fadeSamples > 0 {
			fadeIn = math.Min(1, float64(index)/float64(fadeSamples))
			fadeOut = math.Min(1, float64(len(samples)-index)/float64(fadeSamples))
		}
		envelope := math.Min(fadeIn, fadeOut)
		vibrato := math.Sin(2*math.Pi*4.2*t) * 5
		samples[index] = float32(math.Sin(2*math.Pi*(frequency+vibrato)*t) * gain * envelope)
	}
	wav := encodePCM16Wav(samples, ttsSampleRate)
	return TTSSynthesizeResponse{
		"ok":           true,
		"provider":     "tone-wav",
		"mimeType":     "audio/wav",
		"audioDataUrl": "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(wav),
		"durationMs":   int(durationMs),
		"sampleRate":   ttsSampleRate,
		"textLength":   textLength,
	}
}

func encodePCM16Wav(samples []float32, sampleRate int) []byte {
	const bytesPerSample = 2
	dataSize := len(samples) * bytesPerSample
	buffer := bytes.NewBuffer(make([]byte, 0, 44+dataSize))
	buffer.WriteString("RIFF")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(36+dataSize))
	buffer.WriteString("WAVEfmt ")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(16))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(1))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(1))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(sampleRate))
	_ = binary.Write(buffer, binary.LittleEndian, uint32(sampleRate*bytesPerSample))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(bytesPerSample))
	_ = binary.Write(buffer, binary.LittleEndian, uint16(16))
	buffer.WriteString("data")
	_ = binary.Write(buffer, binary.LittleEndian, uint32(dataSize))
	for _, sample := range samples {
		_ = binary.Write(buffer, binary.LittleEndian, int16(clampFloat(float64(sample), -1, 1)*32767))
	}
	return buffer.Bytes()
}

func (s *Service) runCommandTTS(ctx context.Context, payload normalizedTTSPayload) TTSSynthesizeResponse {
	provider := normalizeTTSProvider(s.dialog.TTSProvider)
	if strings.TrimSpace(s.dialog.TTSCommand) == "" {
		return TTSSynthesizeResponse{"ok": false, "provider": provider, "error": "MAB_TTS_COMMAND is required when MAB_TTS_PROVIDER=command"}
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return TTSSynthesizeResponse{"ok": false, "provider": "command", "error": "marshal_tts_payload_failed"}
	}
	command := exec.CommandContext(ctx, "/bin/sh", "-c", s.dialog.TTSCommand)
	command.Stdin = bytes.NewReader(raw)
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command.Stdout = stdout
	command.Stderr = stderr
	err = command.Run()
	parsed := parseProviderResponse(stdout.String(), TTSSynthesizeResponse{"provider": "command", "debug": strings.TrimSpace(stderr.String())})
	if err != nil {
		parsed["ok"] = false
		if strings.TrimSpace(stringFromAny(parsed["error"])) == "" {
			parsed["error"] = firstNonEmpty(strings.TrimSpace(stderr.String()), commandExitText(err))
		}
		return parsed
	}
	if parsed["ok"] == nil {
		parsed["ok"] = true
	}
	return parsed
}

func (s *Service) runHTTPTTS(ctx context.Context, payload normalizedTTSPayload) TTSSynthesizeResponse {
	provider := normalizeTTSProvider(s.dialog.TTSProvider)
	if strings.TrimSpace(s.dialog.TTSHTTPURL) == "" {
		return TTSSynthesizeResponse{"ok": false, "provider": provider, "error": "MAB_TTS_HTTP_URL is required when MAB_TTS_PROVIDER=http"}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return TTSSynthesizeResponse{"ok": false, "provider": "http", "error": "marshal_tts_payload_failed"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.dialog.TTSHTTPURL, bytes.NewReader(raw))
	if err != nil {
		return TTSSynthesizeResponse{"ok": false, "provider": "http", "error": err.Error()}
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return TTSSynthesizeResponse{"ok": false, "provider": "http", "error": err.Error()}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	parsed := parseProviderResponse(string(body), TTSSynthesizeResponse{"provider": "http"})
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		parsed["ok"] = false
		if strings.TrimSpace(stringFromAny(parsed["error"])) == "" {
			parsed["error"] = fmt.Sprintf("tts HTTP provider returned %d", response.StatusCode)
		}
		return parsed
	}
	if parsed["ok"] == nil {
		parsed["ok"] = true
	}
	return parsed
}

func parseProviderResponse(text string, fallback TTSSynthesizeResponse) TTSSynthesizeResponse {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return mergeTTSResponse(TTSSynthesizeResponse{"ok": false, "error": "empty_tts_provider_response"}, fallback)
	}
	var parsed TTSSynthesizeResponse
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return mergeTTSResponse(TTSSynthesizeResponse{"ok": false, "error": "tts_provider_returned_non_json", "raw": truncateString(trimmed, 400)}, fallback)
	}
	return mergeTTSResponse(parsed, fallback)
}

func statusForTTSResult(result TTSSynthesizeResponse) int {
	if ok, _ := result["ok"].(bool); ok {
		return http.StatusOK
	}
	return http.StatusBadRequest
}

func normalizeTTSProvider(provider string) string {
	normalized := strings.NewReplacer("_", "-").Replace(strings.ToLower(strings.TrimSpace(provider)))
	if normalized == "" {
		return "tone-wav"
	}
	return normalized
}

func mergeTTSResponse(primary TTSSynthesizeResponse, fallback TTSSynthesizeResponse) TTSSynthesizeResponse {
	out := TTSSynthesizeResponse{}
	for key, value := range fallback {
		out[key] = value
	}
	for key, value := range primary {
		out[key] = value
	}
	return out
}

func firstPositive(value float64, fallback float64) float64 {
	if value > 0 {
		return value
	}
	return fallback
}

func clampFloat(value float64, minValue float64, maxValue float64) float64 {
	return math.Max(minValue, math.Min(maxValue, value))
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func stringOrEmpty(value string) string {
	return value
}

func commandExitText(err error) string {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Sprintf("tts command exited %d", exitErr.ExitCode())
	}
	return fmt.Sprintf("tts command exited: %v", err)
}
