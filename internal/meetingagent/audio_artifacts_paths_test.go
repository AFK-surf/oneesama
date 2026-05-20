package meetingagent

import (
	"reflect"
	"testing"
)

// TestMeetingArtifactCandidatePathsMatrix pins the centralised meeting
// artifact filename and root constants + the candidate-path helper used by
// the redelivery + meetd result paths. If a new artifact root is needed (e.g.
// a cloud bucket path), append it to meetingArtifactCandidatePaths and add a
// row here in the same commit; do not introduce a parallel literal at a
// call site. Task #274.
func TestMeetingArtifactCandidatePathsMatrix(t *testing.T) {
	if rawMeetingAudioFilename != "audio.wav" {
		t.Fatalf("rawMeetingAudioFilename = %q, want %q", rawMeetingAudioFilename, "audio.wav")
	}
	if finalMeetingAudioFilename != "audio.mp3" {
		t.Fatalf("finalMeetingAudioFilename = %q, want %q", finalMeetingAudioFilename, "audio.mp3")
	}
	if meetingCaptionsFilename != "captions.json" {
		t.Fatalf("meetingCaptionsFilename = %q, want %q", meetingCaptionsFilename, "captions.json")
	}
	if meetingTranscriptFilename != "transcript.txt" {
		t.Fatalf("meetingTranscriptFilename = %q, want %q", meetingTranscriptFilename, "transcript.txt")
	}
	if legacyMeetdArtifactRoot != "/tmp/meeting-avatar-bot-data/meeting-artifacts" {
		t.Fatalf("legacyMeetdArtifactRoot = %q", legacyMeetdArtifactRoot)
	}
	if legacyRunnerArtifactRoot != "runtime/meeting-artifacts" {
		t.Fatalf("legacyRunnerArtifactRoot = %q", legacyRunnerArtifactRoot)
	}
	if legacyRunnerSessionDirInfix != "runner-" {
		t.Fatalf("legacyRunnerSessionDirInfix = %q", legacyRunnerSessionDirInfix)
	}

	cases := []struct {
		name    string
		session string
		file    string
		want    []string
	}{
		{
			name:    "audio_mp3_session",
			session: "sess-abc",
			file:    finalMeetingAudioFilename,
			want: []string{
				"/tmp/meeting-avatar-bot-data/meeting-artifacts/sess-abc/audio.mp3",
				"runtime/meeting-artifacts/runner-sess-abc/audio.mp3",
			},
		},
		{
			name:    "audio_wav_session",
			session: "sess-xyz",
			file:    rawMeetingAudioFilename,
			want: []string{
				"/tmp/meeting-avatar-bot-data/meeting-artifacts/sess-xyz/audio.wav",
				"runtime/meeting-artifacts/runner-sess-xyz/audio.wav",
			},
		},
		{
			name:    "captions_session",
			session: "sess-123",
			file:    meetingCaptionsFilename,
			want: []string{
				"/tmp/meeting-avatar-bot-data/meeting-artifacts/sess-123/captions.json",
				"runtime/meeting-artifacts/runner-sess-123/captions.json",
			},
		},
		{
			name:    "empty_session_returns_nil",
			session: "",
			file:    finalMeetingAudioFilename,
			want:    nil,
		},
		{
			name:    "empty_filename_returns_nil",
			session: "sess-abc",
			file:    "",
			want:    nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := meetingArtifactCandidatePaths(tc.session, tc.file)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("meetingArtifactCandidatePaths(%q, %q) = %#v, want %#v", tc.session, tc.file, got, tc.want)
			}
		})
	}
}
