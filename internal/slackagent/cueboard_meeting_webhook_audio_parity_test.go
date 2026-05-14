//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParitySniffMeetingAudioArtifactExtension(t *testing.T) {
	t.Run("wav", func(t *testing.T) {
		got := sniffMeetingAudioArtifactExtension([]byte("RIFFxxxxWAVErest"))
		if got != ".wav" {
			t.Fatalf("sniff wav = %q, want .wav", got)
		}
	})

	t.Run("mp3 id3", func(t *testing.T) {
		got := sniffMeetingAudioArtifactExtension([]byte("ID3rest"))
		if got != ".mp3" {
			t.Fatalf("sniff mp3(id3) = %q, want .mp3", got)
		}
	})

	t.Run("mp3 frame", func(t *testing.T) {
		got := sniffMeetingAudioArtifactExtension([]byte{0xff, 0xfb, 0x90, 0x64})
		if got != ".mp3" {
			t.Fatalf("sniff mp3(frame) = %q, want .mp3", got)
		}
	})
}
