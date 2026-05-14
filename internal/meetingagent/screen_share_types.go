package meetingagent

type ScreenShareRequest struct {
	SessionID           string `json:"session_id,omitempty"`
	Title               string `json:"title,omitempty"`
	ScreenShareTitle    string `json:"screenShareTitle,omitempty"`
	Subtitle            string `json:"subtitle,omitempty"`
	ScreenShareSubtitle string `json:"screenShareSubtitle,omitempty"`
	Preview             bool   `json:"preview,omitempty"`
	Mode                string `json:"mode,omitempty"`
	ScreenShareMode     string `json:"screenShareMode,omitempty"`
	WaitMs              int    `json:"waitMs,omitempty"`
}

type VideoStageRequest struct {
	ScreenShareRequest
	VideoURL          string `json:"videoUrl,omitempty"`
	URL               string `json:"url,omitempty"`
	Path              string `json:"path,omitempty"`
	StageTitle        string `json:"stageTitle,omitempty"`
	Width             int    `json:"width,omitempty"`
	ScreenShareWidth  int    `json:"screenShareWidth,omitempty"`
	Height            int    `json:"height,omitempty"`
	ScreenShareHeight int    `json:"screenShareHeight,omitempty"`
	Muted             *bool  `json:"muted,omitempty"`
}
