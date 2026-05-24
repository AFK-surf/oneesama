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
	ImageURL            string `json:"imageUrl,omitempty"`
	ImagePath           string `json:"imagePath,omitempty"`
	FramePath           string `json:"framePath,omitempty"`
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

type ShareableAppsRequest struct {
	SessionID string `json:"session_id,omitempty"`
}

type AppShareRequest struct {
	ScreenShareRequest
	ProcessID        int    `json:"processId,omitempty"`
	PID              int    `json:"pid,omitempty"`
	BundleIdentifier string `json:"bundleIdentifier,omitempty"`
	BundleID         string `json:"bundleId,omitempty"`
	ApplicationName  string `json:"applicationName,omitempty"`
	AppName          string `json:"appName,omitempty"`
	Name             string `json:"name,omitempty"`
}
