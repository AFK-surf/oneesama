package slackagent

import "bytes"

func sniffMeetingAudioArtifactExtension(body []byte) string {
	if len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WAVE")) {
		return ".wav"
	}
	if len(body) >= 3 && bytes.Equal(body[:3], []byte("ID3")) {
		return ".mp3"
	}
	if len(body) >= 2 && body[0] == 0xff && body[1]&0xe0 == 0xe0 {
		return ".mp3"
	}
	return ".wav"
}
