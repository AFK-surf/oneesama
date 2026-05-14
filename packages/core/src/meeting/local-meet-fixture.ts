import http from "node:http";

interface LocalMeetFixtureServerOptions {
  host?: string;
  port?: number;
}

interface LocalMeetFixtureServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

function fixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Meeting Avatar Bot Local Meet Fixture</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: #f6f7fb;
        color: #202636;
      }
      main {
        width: min(720px, calc(100vw - 48px));
        padding: 40px;
        border: 1px solid #d9deea;
        border-radius: 16px;
        background: white;
        box-shadow: 0 16px 50px rgba(20, 31, 56, 0.12);
      }
      label {
        display: block;
        margin-bottom: 10px;
        font-size: 14px;
        color: #526071;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 14px 16px;
        font-size: 18px;
        border: 1px solid #aeb8c8;
        border-radius: 10px;
      }
      button {
        margin-top: 20px;
        padding: 14px 22px;
        border: 0;
        border-radius: 999px;
        background: #1f6feb;
        color: white;
        font-weight: 700;
        font-size: 17px;
        cursor: pointer;
      }
      #state {
        margin-top: 18px;
        min-height: 24px;
        color: #566273;
      }
      #chat-panel {
        margin-top: 24px;
        padding-top: 18px;
        border-top: 1px solid #e7ebf2;
      }
      #chat-log {
        min-height: 54px;
        padding: 10px 12px;
        border: 1px solid #d9deea;
        border-radius: 10px;
        background: #f8fafc;
        color: #2b3445;
        font-size: 14px;
      }
      #chat-message {
        margin-top: 12px;
      }
      #send-chat {
        margin-top: 10px;
        padding: 10px 16px;
        font-size: 14px;
      }
      #share-screen {
        display: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Google Meet fixture</h1>
      <label for="name">Your name</label>
      <input id="name" aria-label="Your name" placeholder="Enter your name" />
      <button id="join" aria-label="Join now">Join now</button>
      <button id="share-screen" aria-label="Share screen">Share screen</button>
      <p id="state">Waiting for bot.</p>
      <section id="chat-panel" aria-label="Chat with everyone">
        <h2>Chat</h2>
        <div id="chat-log" aria-live="polite">No chat messages.</div>
        <input id="chat-message" aria-label="Send a message" placeholder="Send a message to everyone" />
        <button id="send-chat" aria-label="Send message">Send</button>
      </section>
    </main>
    <script>
      window.__MAB_MEET_FIXTURE = {
        joined: false,
        name: "",
        media: null,
        screenShare: null,
        participantAudio: null,
        workerResults: [],
        realtimeEvents: [],
        chatMessages: [],
        events: [{ ts: new Date().toISOString(), type: "fixture_loaded" }],
      };

      function record(type, detail = {}) {
        window.__MAB_MEET_FIXTURE.events.push({ ts: new Date().toISOString(), type, detail });
      }

      function appendChatMessage(text, source = "fixture") {
        const message = {
          ts: new Date().toISOString(),
          source,
          text: String(text || ""),
        };
        window.__MAB_MEET_FIXTURE.chatMessages.push(message);
        const log = document.getElementById("chat-log");
        log.textContent = window.__MAB_MEET_FIXTURE.chatMessages
          .map((entry) => entry.text)
          .join("\\n");
        record("chat_message", { source, text: message.text });
        return message;
      }

      function maybeCreateParticipantAudio() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("participantAudio") !== "1") return;
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContextImpl({ sampleRate: 48000 });
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const destination = audioContext.createMediaStreamDestination();
        oscillator.frequency.value = 220;
        gain.gain.value = 0.0001;
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();

        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.muted = true;
        audio.dataset.meetingAvatarParticipant = "fixture-participant-audio";
        audio.srcObject = destination.stream;
        document.body.appendChild(audio);

        window.__MAB_MEET_FIXTURE.participantAudio = {
          streamId: destination.stream.id,
          trackIds: destination.stream.getAudioTracks().map((track) => track.id),
        };
        record("participant_audio_ready", window.__MAB_MEET_FIXTURE.participantAudio);
        window.dispatchEvent(new CustomEvent("meeting-avatar-participant-audio-stream", {
          detail: {
            label: "fixture-participant-audio",
            stream: destination.stream,
          },
        }));
      }

      function maybeDispatchRuntimeAcceptanceEvents() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("runtimeAcceptance") !== "1") return;
        window.setTimeout(() => {
          const avatarEvent = {
            type: "response.function_call_arguments.done",
            name: "update_avatar_state",
            call_id: "call_runtime_acceptance_avatar",
            arguments: JSON.stringify({
              mood: "happy",
              action: "emphasize",
              intensity: 1.1,
            }),
          };
          const delegateEvent = {
            type: "response.function_call_arguments.done",
            name: "delegate_to_worker",
            call_id: "call_runtime_acceptance_delegate",
            arguments: JSON.stringify({
              task: "Summarize runtime acceptance smoke.",
              context: "Fixture-level integrated runtime acceptance.",
              mode: "analysis",
              allowCodeChanges: false,
            }),
          };
          const meetChatEvent = {
            type: "response.function_call_arguments.done",
            name: "send_meet_chat",
            call_id: "call_runtime_acceptance_meet_chat",
            arguments: JSON.stringify({
              text: "Realtime hello from runtime acceptance smoke.",
            }),
          };
          window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-server-event", { detail: avatarEvent }));
          window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-server-event", { detail: delegateEvent }));
          window.dispatchEvent(new CustomEvent("meeting-avatar-realtime-server-event", { detail: meetChatEvent }));
          record("runtime_acceptance_events_dispatched", {
            calls: [avatarEvent.name, delegateEvent.name, meetChatEvent.name],
          });
        }, 250);
      }

      function maybeDispatchLocalDialogAcceptanceEvent() {
        const params = new URLSearchParams(window.location.search);
        if (params.get("localDialogAcceptance") !== "1") return;
        window.setTimeout(() => {
          const utterance = params.get("utterance") || "请用一句话介绍 meeting-avatar-bot 的本地 Agent provider 闭环。";
          window.dispatchEvent(new CustomEvent("meeting-avatar-local-utterance", {
            detail: {
              source: "fixture-local-stt",
              text: utterance,
              context: {
                fixture: "local-dialog-acceptance",
              },
            },
          }));
          record("local_dialog_utterance_dispatched", { utterance });
        }, 350);
      }

      document.getElementById("join").addEventListener("click", async () => {
        const state = document.getElementById("state");
        window.__MAB_MEET_FIXTURE.joined = true;
        window.__MAB_MEET_FIXTURE.name = document.getElementById("name").value;
        document.getElementById("share-screen").style.display = "inline-block";
        record("join_clicked", { name: window.__MAB_MEET_FIXTURE.name });
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          window.__MAB_MEET_FIXTURE.media = {
            videoTracks: stream.getVideoTracks().map((track) => ({ readyState: track.readyState, settings: track.getSettings() })),
            audioTracks: stream.getAudioTracks().map((track) => ({ readyState: track.readyState, settings: track.getSettings() })),
          };
          record("media_ready", window.__MAB_MEET_FIXTURE.media);
          state.textContent = "Joined with fake mic/camera.";
          maybeDispatchRuntimeAcceptanceEvents();
          maybeDispatchLocalDialogAcceptanceEvent();
        } catch (error) {
          window.__MAB_MEET_FIXTURE.media = { error: String(error && error.message || error) };
          record("media_failed", window.__MAB_MEET_FIXTURE.media);
          state.textContent = "Joined, but media failed.";
        }
      });

      document.getElementById("share-screen").addEventListener("click", async () => {
        const state = document.getElementById("state");
        record("share_screen_clicked");
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          window.__MAB_MEET_FIXTURE.screenShare = {
            label: "fixture-get-display-media",
            streamId: stream.id,
            videoTracks: stream.getVideoTracks().map((track) => ({
              id: track.id,
              readyState: track.readyState,
              settings: track.getSettings(),
            })),
          };
          record("share_screen_ready", window.__MAB_MEET_FIXTURE.screenShare);
          state.textContent = "Sharing screen.";
        } catch (error) {
          window.__MAB_MEET_FIXTURE.screenShare = { error: String(error && error.message || error) };
          record("share_screen_failed", window.__MAB_MEET_FIXTURE.screenShare);
          state.textContent = "Screen share failed.";
        }
      });

      window.addEventListener("meeting-avatar-worker-result", (event) => {
        window.__MAB_MEET_FIXTURE.workerResults.push(event.detail);
        record("worker_result", { jobId: event.detail && event.detail.id });
      });

      window.addEventListener("meeting-avatar-realtime-event", (event) => {
        window.__MAB_MEET_FIXTURE.realtimeEvents.push(event.detail);
        record("realtime_event", { type: event.detail && event.detail.type });
      });

      window.addEventListener("meeting-avatar-meet-chat-send", (event) => {
        appendChatMessage(event.detail && event.detail.text, "realtime-tool");
      });

      document.getElementById("send-chat").addEventListener("click", () => {
        const input = document.getElementById("chat-message");
        const text = input.value.trim();
        if (!text) return;
        appendChatMessage(text, "manual");
        input.value = "";
      });

      window.addEventListener("meeting-avatar-screen-share-stream", (event) => {
        const stream = event.detail && event.detail.stream;
        window.__MAB_MEET_FIXTURE.screenShare = {
          label: event.detail && event.detail.label,
          streamId: stream && stream.id,
          videoTracks: stream ? stream.getVideoTracks().map((track) => ({
            id: track.id,
            readyState: track.readyState,
            settings: track.getSettings(),
          })) : [],
          state: event.detail && event.detail.state,
        };
        record("screen_share_stream", window.__MAB_MEET_FIXTURE.screenShare);
      });

      maybeCreateParticipantAudio();
    </script>
  </body>
</html>`;
}

export function startLocalMeetFixtureServer(
  options: LocalMeetFixtureServerOptions = {},
): Promise<LocalMeetFixtureServer> {
  const host = options.host || "127.0.0.1";
  const port = options.port || 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "local-meet-fixture" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml());
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort =
        address && typeof address === "object" && "port" in address ? address.port : port;
      resolve({
        server,
        url: `http://${host}:${resolvedPort}/`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) =>
            server.close((error) => (error ? closeReject(error) : closeResolve())),
          ),
      });
    });
  });
}
