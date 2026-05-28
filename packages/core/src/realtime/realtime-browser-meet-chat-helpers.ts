(() => {
  interface SendMeetChatArgs {
    text?: string;
    message?: string;
    [key: string]: unknown;
  }

  interface MeetFixtureChatMessage {
    ts?: string;
    sender?: string;
    source?: string;
    text?: string;
    [key: string]: unknown;
  }

  type MeetFixture =
    | (Record<string, unknown> & {
        chatMessages?: MeetFixtureChatMessage[];
      })
    | null
    | undefined;

  interface ReadMeetChatArgs {
    limit?: number;
    onlyLinks?: boolean;
    only_links?: boolean;
    [key: string]: unknown;
  }

  interface MeetChatMessageEntry {
    text: string;
    links: string[];
  }

  interface RememberMeetChatMessageOptions {
    inject?: boolean;
    [key: string]: unknown;
  }

  interface RealtimeMeetChatHelperDeps {
    config: Record<string, unknown>;
    state: Record<string, any>;
    observedMeetChatKeys: Set<string>;
    postJson(url: string, body: unknown): Promise<unknown>;
    localServiceUrl(path: string): string;
    recordTimeline(type: string, detail?: Record<string, unknown>): void;
    sendRealtimeEvent(event: unknown): string;
    updateFeedback(): void;
  }

  function create(deps: RealtimeMeetChatHelperDeps) {
    const {
      config,
      state,
      observedMeetChatKeys,
      postJson,
      localServiceUrl,
      recordTimeline,
      sendRealtimeEvent,
      updateFeedback,
    } = deps;
    let meetChatObserver = null;

    function getElementLabel(element) {
      if (!element) return "";
      return [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.getAttribute?.("data-tooltip"),
        element.getAttribute?.("data-tooltip-id"),
        element.getAttribute?.("placeholder"),
        element.innerText,
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    }

    function isVisibleElement(element) {
      if (!element || typeof element.getBoundingClientRect !== "function") return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
        return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function findMeetChatInput(): HTMLElement | null {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            "textarea",
            "input[type='text']",
            "input:not([type])",
            "[contenteditable='true']",
            "[role='textbox']",
          ].join(","),
        ),
      );
      return (
        candidates.find((element) => {
          if (!isVisibleElement(element)) return false;
          const label = getElementLabel(element);
          if (label.includes("search")) return false;
          if (label.includes("your name")) return false;
          return (
            label.includes("message") ||
            label.includes("chat") ||
            label.includes("send") ||
            label.includes("everyone") ||
            label.includes("输入") ||
            label.includes("消息") ||
            element.isContentEditable
          );
        }) || null
      );
    }

    function findVisibleButtonByLabels(labels: string[] = []): HTMLButtonElement | null {
      const lowerLabels = labels.map((label) => String(label).toLowerCase());
      const candidates = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button,[role='button']"),
      );
      return (
        candidates.find((element) => {
          if (!isVisibleElement(element)) return false;
          if (element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
          const label = getElementLabel(element);
          return lowerLabels.some((needle) => label.includes(needle));
        }) || null
      );
    }

    async function waitForMeetChatInput(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const input = findMeetChatInput();
        if (input) return input;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return null;
    }

    function setMeetChatInputText(input, text) {
      input.focus?.();
      if (input.isContentEditable || input.getAttribute?.("contenteditable") === "true") {
        try {
          document.getSelection()?.selectAllChildren(input);
          document.execCommand?.("insertText", false, text);
        } catch {
          input.textContent = text;
        }
        if (!String(input.innerText || input.textContent || "").includes(text)) {
          input.textContent = text;
        }
      } else {
        const prototype =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(input, text);
        else input.value = text;
      }
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function getInputText(input) {
      return String(
        input?.isContentEditable || input?.getAttribute?.("contenteditable") === "true"
          ? input.innerText || input.textContent || ""
          : input?.value || "",
      ).trim();
    }

    function findMeetChatSendButton(input) {
      const inputRect = input?.getBoundingClientRect?.() || null;
      const candidates = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button,[role='button']"),
      )
        .filter((element) => {
          if (!isVisibleElement(element)) return false;
          if (element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
          const label = getElementLabel(element);
          if (label.includes("reaction") || label.includes("mood") || label.includes("emoji"))
            return false;
          return /\b(send|send message|send a message)\b|发送|傳送/.test(label);
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const distance = inputRect
            ? Math.abs((rect.top + rect.bottom) / 2 - (inputRect.top + inputRect.bottom) / 2) +
              Math.max(0, inputRect.left - rect.right)
            : 0;
          return { element, distance, label: getElementLabel(element) };
        })
        .toSorted((a, b) => a.distance - b.distance);
      return candidates[0]?.element || null;
    }

    async function waitForMeetChatSendButton(input, timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const button = findMeetChatSendButton(input);
        if (button) return button;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return null;
    }

    async function waitForMeetChatSent(input, text, timeoutMs = 2500) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const currentText = getInputText(input);
        if (!currentText || !currentText.includes(text)) return "input-cleared";
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      return "";
    }

    async function triggerMeetChatSubmit(input) {
      const sendButton = await waitForMeetChatSendButton(input);
      if (sendButton) {
        sendButton.click();
        return "send-button";
      }
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter",
        }),
      );
      return "enter-key";
    }

    async function sendMeetChat(args: SendMeetChatArgs = {}) {
      const text = String(args.text || args.message || "").trim();
      if (!text) throw new Error("send_meet_chat requires text");

      const fixture = (window as any).__MAB_MEET_FIXTURE as MeetFixture;
      if (fixture) {
        const beforeCount = fixture.chatMessages?.length || 0;
        window.dispatchEvent(
          new CustomEvent("meeting-avatar-meet-chat-send", { detail: { text } }),
        );
        const afterCount = fixture.chatMessages?.length || 0;
        if (afterCount > beforeCount) {
          return {
            ok: true,
            path: "fixture-event",
            text,
            count: afterCount,
            sentAt: new Date().toISOString(),
          };
        }
      }

      let input = await waitForMeetChatInput(400);
      if (!input) {
        const chatButton = findVisibleButtonByLabels([
          "chat",
          "chat with everyone",
          "open chat",
          "show everyone",
          "messages",
          "聊天",
          "訊息",
          "消息",
        ]);
        if (!chatButton) throw new Error("meet chat button not found");
        chatButton.click();
        input = await waitForMeetChatInput(3000);
      }
      if (!input) throw new Error("meet chat input not found");
      setMeetChatInputText(input, text);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      const submitPath = await triggerMeetChatSubmit(input);
      const sentConfirmation = await waitForMeetChatSent(input, text);
      if (!sentConfirmation) {
        return {
          ok: false,
          error: "meet_chat_submit_unconfirmed",
          path: "meet-dom",
          submitPath,
          inputText: getInputText(input),
          text,
        };
      }
      return {
        ok: true,
        path: "meet-dom",
        submitPath,
        sentConfirmation,
        text,
        sentAt: new Date().toISOString(),
      };
    }

    function readMeetingAwarenessTool(name = "meet_participants") {
      const awareness = (window as any).MAB_MEETING_AWARENESS || null;
      const base = {
        ok: Boolean(awareness),
        source: awareness?.source || "",
        observedAt: awareness?.observedAt || "",
        caveat:
          awareness?.caveat ||
          "Best-effort Google Meet DOM/caption heuristic; no live awareness has been published yet.",
      };
      if (name === "active_speaker") {
        return {
          ...base,
          activeSpeaker: awareness?.activeSpeaker || null,
          recentSpeakers: awareness?.recentSpeakers || [],
        };
      }
      return {
        ...base,
        participants: awareness?.participants || [],
        participantCount: awareness?.participantCount || null,
        activeSpeaker: awareness?.activeSpeaker || null,
        recentSpeakers: awareness?.recentSpeakers || [],
      };
    }

    function extractUrls(text: unknown): string[] {
      return Array.from(String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)).map((match) =>
        match[0].replace(/[.,，。!?！？;；:：]+$/g, ""),
      );
    }

    function readFixtureMeetChat(limit: number, onlyLinks: boolean) {
      const fixture = (window as any).__MAB_MEET_FIXTURE as MeetFixture;
      const messages = (fixture?.chatMessages || []).slice(-limit).map((entry) => ({
        ts: entry.ts || "",
        sender: entry.source || "",
        text: String(entry.text || ""),
        links: extractUrls(entry.text || ""),
      }));
      return onlyLinks ? messages.filter((entry) => entry.links.length) : messages;
    }

    function findMeetChatMessageElements(): HTMLElement[] {
      const messageSelector = [
        "[data-message-id]",
        "[data-message-text]",
        "[data-message-text-content]",
        "[role='listitem']",
        "[role='article']",
      ].join(",");
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>([messageSelector, "a[href^='http']"].join(",")),
      );
      return candidates.filter((element) => {
        if (!isVisibleElement(element)) return false;
        if (element.matches("a[href^='http']")) {
          const messageParent = element.closest(messageSelector);
          if (messageParent && messageParent !== element) return false;
        }
        const text = String(element.innerText || element.textContent || "").trim();
        const href = (element as HTMLAnchorElement).href || "";
        if (!text && !href) return false;
        if (/^(chat|messages|send a message|发送消息|訊息|聊天)$/i.test(text)) return false;
        const hasMessageAttribute = Boolean(
          element.hasAttribute("data-message-id") ||
          element.hasAttribute("data-message-text") ||
          element.hasAttribute("data-message-text-content"),
        );
        const hasChatAncestor = Boolean(
          element.closest(
            "[aria-label*='Chat'],[aria-label*='chat'],[aria-label*='messages'],[aria-label*='Messages']",
          ),
        );
        return hasChatAncestor || hasMessageAttribute;
      });
    }

    async function ensureMeetChatOpen() {
      if (findMeetChatInput()) return true;
      const chatButton = findVisibleButtonByLabels([
        "chat",
        "chat with everyone",
        "open chat",
        "show everyone",
        "messages",
        "聊天",
        "訊息",
        "消息",
      ]);
      if (!chatButton) return false;
      chatButton.click();
      await waitForMeetChatInput(2500);
      return true;
    }

    async function readMeetChat(args: ReadMeetChatArgs = {}) {
      const limit = Math.max(1, Math.min(Number(args.limit || 10), 50));
      const onlyLinks = Boolean(args.onlyLinks || args.only_links);
      if ((window as any).__MAB_MEET_FIXTURE) {
        const messages = readFixtureMeetChat(limit, onlyLinks);
        return {
          ok: true,
          path: "fixture-state",
          messages,
          links: messages.flatMap((entry) => entry.links),
          count: messages.length,
          readAt: new Date().toISOString(),
        };
      }
      await ensureMeetChatOpen();
      const seen = new Set();
      const messages = [];
      for (const element of findMeetChatMessageElements()) {
        const rawText = String(element.innerText || element.textContent || "").trim();
        const text = rawText.replace(/\s+/g, " ").slice(0, 1000);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const links = Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((anchor) => anchor.href)
          .filter((href) => /^https?:\/\//.test(href));
        for (const url of extractUrls(text)) {
          if (!links.includes(url)) links.push(url);
        }
        if (onlyLinks && links.length === 0) continue;
        messages.push({
          text,
          links,
        });
      }
      const recent = messages.slice(-limit);
      return {
        ok: true,
        path: "meet-dom",
        messages: recent,
        links: Array.from(new Set(recent.flatMap((entry) => entry.links))),
        count: recent.length,
        readAt: new Date().toISOString(),
      };
    }

    function normalizeMeetChatElement(element: HTMLElement): MeetChatMessageEntry | null {
      const rawText = String(element.innerText || element.textContent || "").trim();
      const href = (element as HTMLAnchorElement).href || "";
      const text = (rawText || href).replace(/\s+/g, " ").slice(0, 1000);
      if (!text) return null;
      const anchors = element.querySelectorAll
        ? Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
        : [];
      const links = anchors.map((anchor) => anchor.href).filter((url) => /^https?:\/\//.test(url));
      if (/^https?:\/\//.test(href) && !links.includes(href)) links.push(href);
      for (const url of extractUrls(text)) {
        if (!links.includes(url)) links.push(url);
      }
      if (
        !links.length &&
        /^(more_vert|call_end|info|chat_bubble|apps|mood|closed_caption|back_hand|keep|pin message|send message)$/i.test(
          text,
        )
      )
        return null;
      if (!links.length && text.length < 8) return null;
      if (
        !links.length &&
        /meeting host/i.test(text) &&
        (/mute .+ microphone/i.test(text) || /more actions/i.test(text))
      ) {
        return null;
      }
      return {
        text,
        links: Array.from(new Set(links)),
      };
    }

    function rememberMeetChatMessage(
      message: MeetChatMessageEntry | null,
      source: string = "observer",
      options: RememberMeetChatMessageOptions = {},
    ) {
      if (!message?.text) return { ok: false, skipped: true, reason: "empty_message" };
      const botName = String(config.botName || "").trim();
      if (botName && message.text.includes(botName)) {
        return { ok: false, skipped: true, reason: "own_message" };
      }
      const key = `${message.text}|${message.links.join(",")}`;
      if (observedMeetChatKeys.has(key)) return { ok: false, skipped: true, reason: "duplicate" };
      observedMeetChatKeys.add(key);
      if (options.inject === false) return { ok: true, seeded: true };
      const entry = {
        ts: new Date().toISOString(),
        source,
        text: message.text,
        links: message.links || [],
      };
      state.meetChat.messages.push(entry);
      state.meetChat.messages = state.meetChat.messages.slice(-30);
      state.meetChat.links = Array.from(
        new Set(state.meetChat.messages.flatMap((item) => item.links)),
      ).slice(-50);
      state.meetChat.lastObservedAt = entry.ts;
      recordTimeline("meet_chat_observed", {
        source,
        text: entry.text.slice(0, 200),
        links: entry.links,
      });
      const channel = sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          metadata: {
            source: "meet_chat_observer",
            observedSource: source,
          },
          content: [
            {
              type: "input_text",
              text: `Meet chat message from the operator: ${entry.text}${entry.links.length ? `\nLinks: ${entry.links.join(" ")}` : ""}`,
            },
          ],
        },
      });
      state.meetChat.injected += 1;
      updateFeedback();
      return { ok: true, channel, entry };
    }

    function scanMeetChatMessages(source = "scan", options = {}) {
      const results = [];
      for (const element of findMeetChatMessageElements()) {
        const message = normalizeMeetChatElement(element);
        if (!message) continue;
        const result = rememberMeetChatMessage(message, source, options);
        if (result.ok) results.push(result.entry);
      }
      return results;
    }

    async function installMeetChatObserver() {
      if (config.observeMeetChat === false || state.meetChat.observerInstalled)
        return { ok: true, skipped: true };
      await ensureMeetChatOpen();
      scanMeetChatMessages("initial-scan", { inject: false });
      meetChatObserver = new MutationObserver(() => {
        try {
          scanMeetChatMessages("mutation");
        } catch (error) {
          state.meetChat.errors.push({
            ts: new Date().toISOString(),
            message: String((error && error.message) || error).slice(0, 300),
          });
          state.meetChat.errors = state.meetChat.errors.slice(-20);
        }
      });
      meetChatObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.setInterval(() => {
        try {
          scanMeetChatMessages("poll");
        } catch (error) {
          state.meetChat.errors.push({
            ts: new Date().toISOString(),
            message: String((error && error.message) || error).slice(0, 300),
          });
          state.meetChat.errors = state.meetChat.errors.slice(-20);
        }
      }, 1500);
      state.meetChat.observerInstalled = true;
      recordTimeline("meet_chat_observer_installed", {});
      updateFeedback();
      return { ok: true };
    }

    async function runLocalMeetTool(name, args = {}) {
      if (config.dryRunLocalTools) return { ok: true, dryRun: true, tool: name, arguments: args };
      if (name === "send_meet_chat") return sendMeetChat(args);
      if (name === "present_video_stage")
        return postJson(localServiceUrl("/screen-share/video"), args);
      if (name === "stop_video_stage") return postJson(localServiceUrl("/screen-share/stop"), args);
      if (name === "list_shareable_windows" || name === "list_shareable_apps")
        return postJson(localServiceUrl("/screen-share/apps"), args);
      if (name === "share_existing_app_window" || name === "present_app_share")
        return postJson(localServiceUrl("/screen-share/app"), args);
      if (name === "read_meet_chat") return readMeetChat(args);
      if (name === "meet_participants" || name === "active_speaker")
        return readMeetingAwarenessTool(name);
      throw new Error(`unsupported local meet tool: ${name}`);
    }

    return {
      sendMeetChat,
      readMeetChat,
      installMeetChatObserver,
      runLocalMeetTool,
      readMeetingAwarenessTool,
      scanMeetChatMessages,
    };
  }

  (window as any).__MAB_REALTIME_MEET_CHAT_HELPERS = { create };
})();
