export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
};

export type PrepareJoinParams = {
  session_id?: string;
  meeting_url?: string;
  display_name?: string;
  title?: string;
  dry_run?: boolean;
  allow_non_google_meet?: boolean;
  collect_fixture_state?: boolean;
  capture_captions?: boolean;
  caption_language?: string;
  record_meeting?: boolean;
  artifacts_dir?: string;
  meet_audio_backend?: string;
  install_realtime_bridge?: boolean;
  realtime_bridge_mode?: string;
  realtime_agent_runtime?: string;
  realtime_tool_callback_token?: string;
  realtime_instructions?: string;
  realtime_tools?: unknown[];
  realtime_session?: Record<string, unknown>;
  auto_connect_realtime?: boolean;
  send_realtime_session_update?: boolean;
  include_participant_audio?: boolean;
  forward_meet_audio_to_realtime?: boolean;
  meet_audio_input_gain?: number | string;
  realtime_fallback_to_local_mic?: boolean;
  install_local_dialog_bridge?: boolean;
  install_worker_result_bridge?: boolean;
  install_screen_share_bridge?: boolean;
  auto_start_screen_share?: boolean;
  worker_poll_url?: string;
  worker_result_min_created_at?: string;
  worker_delegate_url?: string;
  worker_status_url?: string;
  local_dialog_turn_url?: string;
  local_dialog_tts_url?: string;
  local_dialog_tts_mode?: string;
  local_dialog_tts_provider?: string;
  local_dialog_tts_gain?: string;
  screen_share_mode?: string;
  screen_share_title?: string;
  screen_share_subtitle?: string;
  screen_share_width?: number;
  screen_share_height?: number;
  screen_share_fps?: number;
  browser_extra_args?: string;
};

export type StatusSessionParams = {
  session_id?: string;
};

export type StopSessionParams = {
  session_id?: string;
  reason?: string;
};
