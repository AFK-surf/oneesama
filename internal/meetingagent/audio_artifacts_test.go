package meetingagent

import "testing"

func TestParseMeetingAudioSignalRejectsAllZeroAudio(t *testing.T) {
	output := `
[Parsed_astats_0 @ 0x123] Channel: 1
[Parsed_astats_0 @ 0x123] Max level: 0.000000
[Parsed_astats_0 @ 0x123] Peak level dB: -inf
[Parsed_astats_0 @ 0x123] Overall
[Parsed_astats_0 @ 0x123] Max level: 0.000000
[Parsed_astats_0 @ 0x123] Peak level dB: -inf
`
	got, ok := parseMeetingAudioSignal(output)
	if !ok {
		t.Fatalf("parseMeetingAudioSignal ok = false, want true")
	}
	if got {
		t.Fatalf("parseMeetingAudioSignal = true, want false for all-zero audio")
	}
}

func TestParseMeetingAudioSignalAcceptsNonZeroAudio(t *testing.T) {
	output := `
[Parsed_astats_0 @ 0x123] Channel: 1
[Parsed_astats_0 @ 0x123] Max level: 0.018433
[Parsed_astats_0 @ 0x123] Peak level dB: -34.689
`
	got, ok := parseMeetingAudioSignal(output)
	if !ok {
		t.Fatalf("parseMeetingAudioSignal ok = false, want true")
	}
	if !got {
		t.Fatalf("parseMeetingAudioSignal = false, want true for non-zero audio")
	}
}
