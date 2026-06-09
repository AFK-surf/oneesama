export function buildLanOperatorDebugPanelClientScript() {
  return `(() => {
  const milestoneLabels = {
    heard: "heard",
    speechStarted: "speech",
    transcript: "transcript",
    tool: "tool",
    kwwk: "kwwk",
    verification: "verify",
    output: "output",
  };

  function joinedText(events, type) {
    return events
      .filter((event) => event.type === type && event.text)
      .map((event) => event.text)
      .join("");
  }

  function countSummary(counts) {
    const entries = Object.entries(counts || {});
    if (!entries.length) return "-";
    return entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => name + ":" + String(count))
      .join(" / ");
  }

  function providerEventSummary(events) {
    const rows = (events || []).slice(-6).reverse();
    if (!rows.length) return "-";
    return rows
      .map((event) => [
        event.provider || "provider",
        event.providerEventType || "?",
        "->",
        event.canonicalType || "?",
        event.turnId || event.responseId || "",
      ].filter(Boolean).join(" "))
      .join(" | ");
  }

  function providerDrilldownRows(events) {
    return (events || []).slice(-8).reverse().map((event) => [
      event.provider || "provider",
      event.providerEventType || "?",
      event.canonicalType || "?",
      [
        event.summary || "",
        event.turnId ? "turn:" + event.turnId : "",
        event.responseId ? "response:" + event.responseId : "",
        event.itemId ? "item:" + event.itemId : "",
        event.detailKeys?.length ? "keys:" + event.detailKeys.join(",") : "",
      ].filter(Boolean).join(" / ") || "-",
    ]);
  }

  function liveProviderConfigRows(config, selectedTransport) {
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    return providers.map((provider) => [
      [
        provider.label || provider.transport || "provider",
        provider.transport === selectedTransport ? "selected" : "",
      ].filter(Boolean).join(" / "),
      provider.keyConfigured
        ? "configured / " + String(provider.keySource || "key")
        : "missing / " + (provider.acceptedKeyEnv || []).join("|"),
      [
        provider.model || "-",
        provider.modelSource ? "model:" + provider.modelSource : "",
        provider.config?.thinkingLevel ? "thinking:" + provider.config.thinkingLevel : "",
      ].filter(Boolean).join(" / "),
      provider.runCommand || "-",
    ]);
  }

  function renderLiveProviderConfig(input) {
    if (!input.debugProviderConfigSummary || !input.debugProviderConfigTable) return;
    const config = input.state.liveProviderConfig || input.boot.liveProviderConfig || {};
    const selectedTransport =
      config.selectedTransport ||
      input.state.conversation?.provider?.adapterKind ||
      input.boot.conversationTransport ||
      "";
    const providers = Array.isArray(config.providers) ? config.providers : [];
    const selected = providers.find((provider) => provider.transport === selectedTransport) || null;
    input.debugProviderConfigSummary.textContent = selected
      ? [
          selected.label || selected.transport,
          selected.keyConfigured ? "configured" : "key missing",
          selected.model || "-",
        ].join(" / ")
      : String(selectedTransport || "diagnostic");
    input.replaceTableRows(
      input.debugProviderConfigTable,
      providers.length ? liveProviderConfigRows(config, selectedTransport) : [["-", "-", "-", "-"]],
    );
  }

  function lowerText() {
    return Array.from(arguments).map((value) => {
      if (value && typeof value === "object") {
        try {
          return JSON.stringify(value).toLowerCase();
        } catch {
          return "";
        }
      }
      return String(value || "").toLowerCase();
    }).join(" ");
  }

  function primaryBlockerLayer(row) {
    if (row.layer === "kwwk") {
      const text = lowerText(row.event, row.blocker);
      if (text.includes("verification") || text.includes("verifying") || text.includes("verify")) return "verification";
      if (text.includes("execution") || text.includes("executing") || text.includes("executor") || text.includes("surface")) return "kwwk_execution";
      if (text.includes("planner") || text.includes("planning")) return "kwwk_planner";
      const detailText = lowerText(row.detail);
      if (detailText.includes("verification") || detailText.includes("verifying") || detailText.includes("verify")) return "verification";
      if (detailText.includes("execution") || detailText.includes("executing") || detailText.includes("executor") || detailText.includes("surface")) return "kwwk_execution";
      if (detailText.includes("planner") || detailText.includes("planning")) return "kwwk_planner";
      return "kwwk_execution";
    }
    if (row.layer === "visual" || row.layer === "operator") {
      return lowerText(row.event, row.blocker, row.detail).includes("meet") ? "meet_adapter" : "transport";
    }
    return row.layer || "transport";
  }

  function primaryBlockerSummary(state) {
    const timeline = state.timeline || {};
    const blockerRows = (timeline.rows || []).filter((row) => row.blocker);
    if (!blockerRows.length) return null;
    const latestBadTurn = [...(timeline.turns || [])]
      .reverse()
      .find((turn) => turn.status === "blocked" || turn.status === "failed" || turn.blocker);
    const turnBlockers = latestBadTurn
      ? blockerRows.filter((row) => row.turnId === latestBadTurn.turnId)
      : [];
    const candidates = turnBlockers.length ? turnBlockers : blockerRows;
    const row = candidates.at(-1);
    if (!row) return null;
    return {
      layer: primaryBlockerLayer(row),
      timelineLayer: row.layer,
      event: row.event,
      blocker: row.blocker,
      turnId: row.turnId,
      responseId: row.responseId,
      candidateCount: candidates.length,
    };
  }

  function primaryBlockerLabel(primaryBlocker) {
    if (!primaryBlocker) return "none";
    return [
      primaryBlocker.layer,
      primaryBlocker.blocker,
      primaryBlocker.event,
      primaryBlocker.turnId ? "turn:" + primaryBlocker.turnId : "",
    ].filter(Boolean).join(" / ");
  }

  function timelineRowStatus(row) {
    return [
      row.ok ? (row.blocker || "ok") : (row.blocker || "blocked"),
      row.responseId ? "response:" + row.responseId : "",
      row.id ? "row:" + row.id : "",
      row.detail && typeof row.detail === "object"
        ? "keys:" + Object.keys(row.detail).sort().slice(0, 8).join(",")
        : "",
    ].filter(Boolean).join(" / ");
  }

  function renderTurnTimelineRows(input, currentTurnId) {
    const timeline = input.state.timeline || {};
    const rows = timeline.rows || [];
    const turns = timeline.turns || [];
    const recentTurns = turns.slice(-4).reverse();
    const groupedRows = [];
    for (const turn of recentTurns) {
      const rowsForTurn = rows.filter((row) => row.turnId === turn.turnId);
      if (!rowsForTurn.length) continue;
      groupedRows.push([
        turn.turnId,
        "summary",
        [
          turn.status || "active",
          Object.entries(milestoneLabels)
            .filter(([key]) => Boolean(turn.milestones?.[key]))
            .map(([, label]) => label)
            .join(" -> ") || "no milestones",
        ].join(" / "),
        {
          text: turn.blocker || input.durationLabel(turn.durationMs),
          className: turn.blocker || turn.status === "blocked" || turn.status === "failed"
            ? "debug-bad"
            : turn.status === "completed"
              ? "debug-ok"
              : "debug-warn",
        },
      ]);
      rowsForTurn.forEach((row, index) => {
        groupedRows.push([
          row.turnId || "-",
          "#" + String(index + 1) + " " + input.durationLabel(row.durationMs),
          String(row.layer || "-") + " / " + String(row.event || "-"),
          {
            text: timelineRowStatus(row),
            className: row.ok ? "debug-ok" : "debug-bad",
          },
        ]);
      });
    }
    const currentRows = currentTurnId ? rows.filter((row) => row.turnId === currentTurnId) : [];
    if (input.debugTurnTimelineSummary) {
      input.debugTurnTimelineSummary.textContent = [
        currentTurnId || "no turn",
        String(currentRows.length) + " rows",
        String(recentTurns.length) + " turns",
      ].join(" / ");
    }
    if (input.debugTurnTimelineTable) {
      input.replaceTableRows(
        input.debugTurnTimelineTable,
        groupedRows.length ? groupedRows : [["-", "-", "waiting", "no turn rows"]],
      );
    }
    return groupedRows.length;
  }

  function renderTurnsAndConversation(input) {
    const state = input.state;
    const boot = input.boot;
    const conversation = state.conversation || {};
    const provider = conversation.provider || {};
    const canonicalEvents = conversation.canonicalEvents || state.canonicalEvents || [];
    const latestTurn = (state.timeline.turns || []).at(-1) || null;
    const primaryBlocker = primaryBlockerSummary(state);
    const currentTurnId = latestTurn?.turnId || state.timeline.currentTurnId || null;
    const turnRows = (state.timeline.turns || []).slice(-6).reverse().map((turn) => [
      turn.turnId,
      Object.entries(milestoneLabels)
        .filter(([key]) => Boolean(turn.milestones?.[key]))
        .map(([, label]) => label)
        .join(" -> ") || "-",
      String(turn.latestEvent || "-") + " / " + input.durationLabel(turn.durationMs),
      {
        text: turn.blocker || turn.status || "active",
        className: turn.blocker || turn.status === "blocked" || turn.status === "failed"
          ? "debug-bad"
          : turn.status === "completed"
            ? "debug-ok"
            : "debug-warn",
      },
    ]);
    input.debugTurnCount.textContent = String((state.timeline.turns || []).length) + " turns";
    input.replaceTableRows(input.debugTurnTable, turnRows.length ? turnRows : [["-", "-", "-", "waiting"]]);
    renderTurnTimelineRows(input, currentTurnId);

    const turnEvents = currentTurnId
      ? canonicalEvents.filter((event) => event.turnId === currentTurnId)
      : canonicalEvents;
    const transcriptCompleted = [...turnEvents].reverse().find((event) => event.type === "transcript_completed" && event.text);
    const assistantCompleted = [...turnEvents].reverse().find((event) => event.type === "assistant_text_completed" && event.text);
    const interruption = [...canonicalEvents].reverse().find((event) => event.type === "interrupted");
    const currentResponseId =
      latestTurn?.responseIds?.at(-1) || state.output.assistantText.lastResponseId || "";
    input.debugConversationSummary.textContent = [
      conversation.status || "not_connected",
      currentTurnId || "no turn",
      latestTurn?.latestEvent || "-",
      primaryBlocker ? "primary:" + primaryBlocker.layer : "no primary blocker",
    ].join(" / ");
    input.replaceTableRows(input.debugConversationTable, [
      [
        "Engine",
        String(conversation.engineId || "unknown") +
          " / " +
          String(state.liveProviderConfig?.selectedTransport || boot.conversationTransport),
      ],
      ["Session", boot.sessionId],
      ["Turn", currentTurnId || "-"],
      ["Response", currentResponseId || "-"],
      ["Primary blocker", {
        text: primaryBlockerLabel(primaryBlocker),
        className: primaryBlocker ? "debug-bad" : "debug-ok",
      }],
      ["User transcript", transcriptCompleted?.text || joinedText(turnEvents, "transcript_delta") || "-"],
      ["Assistant transcript", assistantCompleted?.text || joinedText(turnEvents, "assistant_text_delta") || state.output.assistantText.completedText || state.output.assistantText.currentText || "-"],
      ["Speech starts", conversation.eventCounts?.speech_started || 0],
      ["Control", conversation.control?.lastCommand
        ? String(conversation.control.lastCommand) + " / " + String(conversation.control.lastResult || "sent")
        : "idle"],
      ["Control detail", conversation.control?.lastDetail ? JSON.stringify(conversation.control.lastDetail) : "-"],
      ["Interruption", interruption ? String(interruption.responseId || "") + " / " + String(interruption.detail?.reason || interruption.detail?.control || "interrupted") : "-"],
    ]);

    const adapterKind =
      provider.adapterKind ||
      conversation.engineId ||
      state.liveProviderConfig?.selectedTransport ||
      boot.conversationTransport ||
      "unknown";
    input.debugPortSummary.textContent = [
      adapterKind,
      provider.rawEventDrilldownAvailable ? "provider drill-down" : "canonical only",
    ].join(" / ");
    input.replaceTableRows(input.debugPortTable, [
      ["Adapter", adapterKind],
      ["Canonical counts", countSummary(conversation.eventCounts)],
      ["Latest canonical", canonicalEvents.at(-1)?.type || "-"],
      ["Raw drill-down", provider.rawEventDrilldownAvailable ? "available" : "none"],
      ["Latest provider event", provider.latestProviderEventType || "-"],
      ["Provider counts", countSummary(provider.providerEventCounts)],
      ["Recent provider events", providerEventSummary(provider.recentEvents)],
    ]);
    renderLiveProviderConfig(input);
    if (input.debugProviderDrilldownSummary && input.debugProviderDrilldownTable) {
      const providerEvents = provider.recentEvents || [];
      input.debugProviderDrilldownSummary.textContent = provider.rawEventDrilldownAvailable
        ? String(providerEvents.length) + " recent"
        : "none";
      input.replaceTableRows(
        input.debugProviderDrilldownTable,
        providerEvents.length ? providerDrilldownRows(providerEvents) : [["-", "-", "-", "canonical only"]],
      );
    }
  }

  function renderToolAndKwwk(input) {
    const state = input.state;
    const cancel = state.toolRouting.cancel || {};
    input.debugToolRoutingSummary.textContent = state.toolRouting.actualTool
      ? String(state.toolRouting.expectedTool || "?") + " -> " + String(state.toolRouting.actualTool)
      : state.toolRouting.status;
    input.replaceTableRows(input.debugToolRoutingTable, [
      ["Status", state.toolRouting.status],
      ["Expected", state.toolRouting.expectedTool],
      ["Actual", state.toolRouting.actualTool],
      ["Call", state.toolRouting.callId],
      ["Argument safety", { text: state.toolRouting.argumentSafety.ok ? "safe" : "check", className: state.toolRouting.argumentSafety.ok ? "debug-ok" : "debug-warn" }],
      ["Function output", state.toolRouting.functionOutputDelivered ? "delivered" : "pending"],
      ["Cancel", cancel.lastResult ? String(cancel.lastResult) + " / " + String(cancel.lastReason || "-") : "idle"],
    ]);

    input.debugKwwkSummary.textContent = state.kwwk.blocker
      ? state.kwwk.status + " / " + state.kwwk.blocker
      : state.kwwk.status;
    input.replaceTableRows(input.debugKwwkTable, [
      ["Job", state.kwwk.currentJobId],
      ["Status", { text: state.kwwk.blocker || state.kwwk.status, className: state.kwwk.blocker ? "debug-bad" : "debug-ok" }],
      ["Target", state.kwwk.target],
      ["Latest action", state.kwwk.latestActionKind],
      ["Cursor/action count", String(state.kwwk.cursorEventCount) + " / " + String(state.kwwk.actionCount)],
      ["Timings", state.kwwk.timings],
      ["Phase evidence", state.kwwk.phaseEvidence],
      ["Verification", state.kwwk.verification],
    ]);
  }

  function filterText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function applyFilter(input) {
    const query = filterText(input.input?.value);
    const sections = Array.from(document.querySelectorAll(".debug-section"));
    let visibleSections = 0;
    let matchedRows = 0;
    let hiddenRows = 0;
    for (const section of sections) {
      const titleMatches = query && filterText(section.querySelector(".debug-section-title")?.innerText).includes(query);
      const rows = Array.from(section.querySelectorAll("tbody tr"));
      let sectionMatchedRows = 0;
      for (const row of rows) {
        const rowMatches = !query || titleMatches || filterText(row.innerText).includes(query);
        row.dataset.filterHidden = rowMatches ? "false" : "true";
        if (rowMatches) sectionMatchedRows += 1;
        else hiddenRows += 1;
      }
      const sectionVisible = !query || titleMatches || sectionMatchedRows > 0;
      section.dataset.filterHidden = sectionVisible ? "false" : "true";
      if (sectionVisible) visibleSections += 1;
      if (query) matchedRows += sectionMatchedRows;
    }
    const jsonMatches = !query || filterText(input.json?.innerText).includes(query);
    if (input.json) input.json.dataset.filterHidden = jsonMatches ? "false" : "true";
    if (input.status) input.status.textContent = query
      ? String(visibleSections) + " sections / " + String(matchedRows) + " rows"
      : "filter off";
    return { query, visibleSections, matchedRows, hiddenRows, jsonMatches };
  }

  function convClock(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "--:--:--";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function convDur(ms) {
    if (ms == null || isNaN(Number(ms))) return "—";
    if (ms < 1000) return Math.round(ms) + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  }
  function convClip(v, n) {
    var s = (v == null ? "" : String(v)).replace(/\\s+/g, " ").trim();
    n = n || 120;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function convToolName(e) {
    return (e.detail && (e.detail.toolName || e.detail.tool || e.detail.name)) || e.toolName || "tool";
  }
  function statusChip(tone, text) {
    var s = document.createElement("span");
    s.className = "cockpit-chip" + (tone ? " " + tone : "");
    var dot = document.createElement("span"); dot.className = "cockpit-dot";
    var lbl = document.createElement("span"); lbl.textContent = text;
    s.appendChild(dot); s.appendChild(lbl);
    return s;
  }

  var INSP_NEXT = {
    mic: "check input device / speak near mic",
    transcript: "check provider / key / session",
    assistant: "check engine / provider events",
    tool: "check tool routing / args",
    app: "check KWWK phase / app permissions",
    final: "check output pipeline",
  };
  function stageOf(row) {
    if (!row) return "";
    if (row.kind === "user") return "transcript";
    if (row.kind === "assistant") return "assistant";
    if (row.kind === "tool") return row.type === "app-control" ? "app" : "tool";
    return "assistant";
  }
  function rowForStage(stage, rows) {
    var firstAsst = null, lastAsst = null, firstTool = null, firstApp = null, firstUser = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === "user") { if (!firstUser) firstUser = r; }
      else if (r.kind === "assistant") { if (!firstAsst) firstAsst = r; lastAsst = r; }
      else if (r.kind === "tool") { if (!firstTool) firstTool = r; if (r.type === "app-control" && !firstApp) firstApp = r; }
    }
    if (stage === "mic" || stage === "transcript") return firstUser;
    if (stage === "assistant") return firstAsst;
    if (stage === "final") return lastAsst || firstAsst;
    if (stage === "app") return firstApp || firstTool;
    if (stage === "tool") return firstTool;
    return null;
  }
  function evkv(label, value) {
    var kv = document.createElement("div"); kv.className = "insp-kv";
    var b = document.createElement("b"); b.textContent = label;
    var s = document.createElement("span"); s.textContent = value;
    kv.appendChild(b); kv.appendChild(s); return kv;
  }
  function renderEventInspector(input, row) {
    var box = document.getElementById("operator-event-inspector");
    if (!box) return;
    if (!row) { box.hidden = true; box.dataset.inspectorOpen = "false"; return; }
    box.hidden = false; box.dataset.inspectorOpen = "true";
    var head = document.getElementById("inspector-head");
    if (head) head.className = "inspector-head " + (row.lane || "");
    var chip = document.getElementById("inspector-chip");
    if (chip) chip.textContent = row.type || row.kind || "event";
    var owner = document.getElementById("inspector-owner");
    if (owner) owner.textContent = row.owner || "—";
    var stat = document.getElementById("inspector-status");
    if (stat) { stat.className = "tl-status " + (row.statusTone || "neutral"); stat.textContent = row.status || "info"; }
    var stage = stageOf(row);
    var raws = row.raws || [];
    var first = raws[0] || {};
    var detail = first.detail || {};
    var ev = document.getElementById("inspector-evidence");
    if (ev) {
      ev.innerHTML = "";
      ev.appendChild(evkv("stage", stage || "—"));
      ev.appendChild(evkv("time", row.ts ? convClock(row.ts) : "live"));
      ev.appendChild(evkv("duration", convDur(row.durMs)));
      ev.appendChild(evkv("events", String(raws.length)));
      var turnId = first.turnId || detail.turnId;
      if (turnId) ev.appendChild(evkv("turn", String(turnId)));
      var respId = first.responseId || detail.responseId;
      if (respId) ev.appendChild(evkv("response", String(respId)));
      var callId = detail.callId || detail.call_id || first.itemId;
      if (callId) ev.appendChild(evkv("call/item", String(callId)));
    }
    var errText = "";
    for (var k = 0; k < raws.length; k++) { if (raws[k] && raws[k].error) { errText = String(raws[k].error); break; } }
    var nextEl = document.getElementById("inspector-next");
    if (nextEl) {
      var bad = row.statusTone === "error" || !!errText;
      if (bad || row.statusTone === "running") {
        nextEl.hidden = false;
        nextEl.className = "inspector-next" + (bad ? " bad" : "");
        nextEl.innerHTML = "";
        var nb = document.createElement("b"); nb.textContent = bad ? "blocked → next: " : "running → ";
        nextEl.appendChild(nb);
        nextEl.appendChild(document.createTextNode(errText ? convClip(errText, 120) : (INSP_NEXT[stage] || "in progress")));
      } else {
        nextEl.hidden = true;
      }
    }
    var rawText = "";
    try { rawText = JSON.stringify(raws.length === 1 ? raws[0] : raws, null, 2); } catch (err) { rawText = String(row.summary || ""); }
    var rawEl = document.getElementById("inspector-raw");
    if (rawEl) rawEl.textContent = rawText;
    box.__rawText = rawText;
  }
  function wireInspector(stream) {
    var box = document.getElementById("operator-event-inspector");
    if (!box || box.__wired) return;
    box.__wired = true;
    var closeBtn = document.getElementById("inspector-close");
    if (closeBtn) closeBtn.addEventListener("click", function () {
      stream.__selectedId = null;
      var inp = stream.__lastInput;
      if (inp) renderConversationStream(inp); else renderEventInspector(null, null);
    });
    var copyBtn = document.getElementById("inspector-copy");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var t = box.__rawText || "";
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function () {});
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
    });
  }
  function renderConversationStream(input) {
    var stream = input.stream || document.getElementById("operator-conversation-stream");
    if (!stream) return;
    stream.__lastInput = input;
    wireInspector(stream);
    var state = input.state || {};
    var conv = state.conversation || {};
    var out = state.output || {};
    var events = (conv.canonicalEvents || state.canonicalEvents || []).slice();
    events.sort(function (a, b) { return String(a.ts || "").localeCompare(String(b.ts || "")); });

    var metaNode = document.getElementById("conversation-meta");
    if (metaNode) {
      var engine =
        conv.engineId ||
        (state.liveProviderConfig && state.liveProviderConfig.selectedTransport) ||
        (input.boot && input.boot.conversationTransport) ||
        "engine";
      metaNode.textContent = String(engine) + " · " + String(conv.status || "not_connected");
    }

    var rows = [];
    var userByTurn = {}, asstByKey = {}, toolByCall = {};
    function rowOf(map, key, kind, lane, e) {
      if (!map[key]) {
        var r = { id: kind + ":" + key, kind: kind, lane: lane, type: "", owner: "", summary: "", status: "", statusTone: "neutral", ts: e.ts, firstMs: Date.parse(e.ts) || 0, durMs: null, startMs: 0, raws: [] };
        map[key] = r; rows.push(r);
      }
      return map[key];
    }
    var toolCount = 0, lastError = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var t = e.type;
      if (t === "transcript_delta" || t === "transcript_completed") {
        var u = rowOf(userByTurn, e.turnId || e.itemId || ("u" + i), "user", "tl-user", e);
        u.type = "transcript"; u.owner = "you";
        if (t === "transcript_completed" && e.text) u.summary = e.text; else if (e.text) u.summary += e.text;
        u.status = t === "transcript_completed" ? "heard" : "hearing";
        u.statusTone = t === "transcript_completed" ? "ok" : "running";
        u.ts = e.ts || u.ts; u.raws.push(e);
      } else if (t === "assistant_text_delta" || t === "assistant_text_completed") {
        var a = rowOf(asstByKey, e.responseId || e.turnId || e.itemId || ("a" + i), "assistant", "tl-assistant", e);
        a.type = "assistant"; a.owner = "Oneesama";
        if (t === "assistant_text_completed" && e.text) a.summary = e.text; else if (e.text) a.summary += e.text;
        a.status = t === "assistant_text_completed" ? "done" : "speaking";
        a.statusTone = t === "assistant_text_completed" ? "ok" : "running";
        a.ts = e.ts || a.ts; a.raws.push(e);
      } else if (t === "tool_call_started" || t === "tool_call_delta" || t === "tool_call_completed" || t === "tool_result_accepted") {
        var callKey = (e.detail && (e.detail.callId || e.detail.call_id)) || e.itemId || e.responseId || ("t" + i);
        var r = rowOf(toolByCall, callKey, "tool", "tl-tool", e);
        var tnm = convToolName(e);
        r.type = /kwwk|computer|app|cu_|control/i.test(String(tnm)) ? "app-control" : "tool"; r.owner = tnm; r.raws.push(e);
        if (t === "tool_call_started") { r.status = "running"; r.statusTone = "running"; r.startMs = Date.parse(e.ts) || 0; if (!r.summary) r.summary = convToolName(e) + " started"; toolCount += 1; }
        else if (t === "tool_call_completed") { r.status = "completed"; r.statusTone = "ok"; if (r.startMs) r.durMs = (Date.parse(e.ts) || 0) - r.startMs; }
        else if (t === "tool_result_accepted") { r.status = "result"; r.statusTone = "ok"; }
        var dt = e.detail || {};
        if (dt.summary || dt.status) r.summary = convToolName(e) + (dt.summary ? " · " + dt.summary : " · " + dt.status);
        r.ts = e.ts || r.ts;
      } else if (t === "interrupted") {
        rows.push({ id: "int:" + (e.id || i), kind: "system", lane: "tl-error", type: "interrupt", owner: "system", summary: "interrupted", status: "interrupted", statusTone: "error", ts: e.ts, firstMs: Date.parse(e.ts) || 0, durMs: null, raws: [e] });
      }
      if (e.error) lastError = { text: e.error, ts: e.ts };
    }
    rows.sort(function (a, b) { return (a.firstMs || 0) - (b.firstMs || 0); });

    var live = out.assistantText || {};
    var liveText = live.currentText || "";
    var lastAsst = null;
    for (var k = rows.length - 1; k >= 0; k--) { if (rows[k].kind === "assistant") { lastAsst = rows[k]; break; } }
    if (liveText && (!lastAsst || lastAsst.summary !== liveText)) {
      rows.push({ id: "live", kind: "assistant", lane: "tl-assistant", type: "assistant", owner: "Oneesama", summary: liveText, status: "speaking", statusTone: "running", ts: null, firstMs: 8.64e15, durMs: null, raws: [{ live: true, text: liveText }] });
    }

    var cockpit = document.getElementById("operator-cockpit");
    if (cockpit) {
      var connTone = conv.status === "connected" ? "ok" : (conv.status === "failed" ? "error" : "neutral");
      var running = null;
      for (var m = rows.length - 1; m >= 0; m--) { if (rows[m].kind === "tool" && rows[m].statusTone === "running") { running = rows[m]; break; } }
      var errText = lastError ? lastError.text : ((conv.control && conv.control.lastError) || "");
      var engineName = String(
        conv.engineId ||
        (state.liveProviderConfig && state.liveProviderConfig.selectedTransport) ||
        (input.boot && input.boot.conversationTransport) ||
        "engine",
      );
      cockpit.innerHTML = "";
      cockpit.appendChild(statusChip(connTone, (conv.status === "connected" ? "connected" : (conv.status || "offline")) + " · " + engineName));
      cockpit.appendChild(statusChip(running ? "running" : "neutral", running ? ("tool: " + running.owner) : "idle"));
      cockpit.appendChild(statusChip("neutral", String(events.length) + " events · " + String(toolCount) + " tools"));
      cockpit.appendChild(statusChip(errText ? "error" : "ok", errText ? ("error: " + convClip(errText, 28)) : "no error"));
    }

    var verdictEl = document.getElementById("operator-verdict");
    if (verdictEl) {
      var stageState = { mic: "idle", transcript: "idle", assistant: "idle", tool: "idle", app: "idle", final: "idle" };
      var sev = { idle: 0, ok: 1, warn: 2, bad: 3 };
      function setStage(stage, s) { if (sev[s] > sev[stageState[stage]]) stageState[stage] = s; }
      for (var s2 = 0; s2 < rows.length; s2++) {
        var rr = rows[s2];
        if (rr.kind === "user") { setStage("mic", "ok"); setStage("transcript", rr.statusTone === "ok" ? "ok" : "warn"); }
        else if (rr.kind === "assistant") { setStage("assistant", rr.statusTone === "ok" ? "ok" : "warn"); if (rr.statusTone === "ok") setStage("final", "ok"); }
        else if (rr.kind === "tool") {
          var ts2 = rr.statusTone === "ok" ? "ok" : (rr.statusTone === "running" ? "warn" : (rr.statusTone === "error" ? "bad" : "warn"));
          setStage("tool", ts2);
          if (rr.type === "app-control") setStage("app", ts2);
        }
      }
      var errLower = errText ? String(errText).toLowerCase() : "";
      if (errLower) {
        if (/mic|energy|microphone|audio input/.test(errLower)) setStage("mic", "bad");
        else if (/transcript|speech|stt/.test(errLower)) setStage("transcript", "bad");
        else if (/kwwk|mutation|computer|app[-_ ]?control/.test(errLower)) setStage("app", "bad");
        else if (/tool/.test(errLower)) setStage("tool", "bad");
        else setStage("assistant", "bad");
      }
      var order = ["mic", "transcript", "assistant", "tool", "app", "final"];
      var nextMap = { mic: "check input device / speak near mic", transcript: "check provider / key / session", assistant: "check engine / provider events", tool: "check tool routing / args", app: "check KWWK phase / app permissions", final: "check output pipeline" };
      var firstBad = null;
      for (var o = 0; o < order.length; o++) { if (stageState[order[o]] === "bad") { firstBad = order[o]; break; } }
      var anyWarn = false, anyOk = false;
      for (var o2 = 0; o2 < order.length; o2++) { if (stageState[order[o2]] === "warn") anyWarn = true; if (stageState[order[o2]] === "ok") anyOk = true; }
      var vTone, vText, vNext = "";
      if (firstBad) { vTone = "bad"; vText = "Blocked at " + firstBad; vNext = errText ? convClip(errText, 60) : (nextMap[firstBad] || ""); }
      else if (anyWarn) { vTone = "warn"; vText = "Running"; }
      else if (anyOk) { vTone = "ok"; vText = "Healthy"; }
      else { vTone = "idle"; vText = "Idle · waiting for input"; }
      verdictEl.innerHTML = "";
      var badge = document.createElement("span"); badge.className = "verdict-badge " + vTone; badge.textContent = vText;
      verdictEl.appendChild(badge);
      var pipe = document.createElement("div"); pipe.className = "verdict-pipeline";
      for (var p = 0; p < order.length; p++) {
        var st = document.createElement("span");
        var stTone = stageState[order[p]];
        st.className = "stage" + (stTone !== "idle" ? " " + stTone : "");
        st.textContent = order[p];
        st.dataset.stage = order[p];
        st.setAttribute("role", "button");
        st.tabIndex = 0;
        st.title = "Jump to " + order[p] + " evidence";
        (function (stageName) {
          function jump() {
            var target = rowForStage(stageName, rows);
            if (!target) return;
            stream.__selectedId = target.id;
            stream.__scrollToSelected = true;
            renderConversationStream(input);
          }
          st.addEventListener("click", jump);
          st.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
        })(order[p]);
        pipe.appendChild(st);
        if (p < order.length - 1) { var arr = document.createElement("span"); arr.className = "stage-arrow"; arr.textContent = "›"; pipe.appendChild(arr); }
      }
      verdictEl.appendChild(pipe);
      if (vNext) { var nx = document.createElement("span"); nx.className = "verdict-next"; var bb = document.createElement("b"); bb.textContent = "next: "; nx.appendChild(bb); nx.appendChild(document.createTextNode(vNext)); verdictEl.appendChild(nx); }
    }

    if (!rows.length) {
      stream.innerHTML = "";
      var empty = document.createElement("div");
      empty.className = "conversation-empty";
      empty.textContent = "No messages yet. Start mic and speak, or type below and hit Send Text.";
      stream.appendChild(empty);
      stream.__selectedId = null;
      renderEventInspector(input, null);
      return;
    }

    var atBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 56;
    stream.innerHTML = "";
    var prevMs = null;
    var selRow = null, selDom = null;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var rowId = r.id || (r.kind + ":" + j);
      var isSel = stream.__selectedId === rowId;
      var delta = (prevMs != null && r.firstMs && r.firstMs < 8.64e15) ? "+" + Math.max(0, (r.firstMs - prevMs) / 1000).toFixed(1) + "s" : "";
      if (r.firstMs && r.firstMs < 8.64e15) prevMs = r.firstMs;
      var row = document.createElement("div");
      row.className = "tl-row " + r.lane + (isSel ? " selected" : "");
      row.setAttribute("role", "button");
      row.setAttribute("aria-pressed", String(isSel));
      row.tabIndex = 0;
      if (isSel) { selRow = r; selDom = row; }
      var main = document.createElement("div"); main.className = "tl-main";
      var chip = document.createElement("span"); chip.className = "tl-chip"; chip.textContent = r.type || "event";
      var sumCell = document.createElement("span"); sumCell.className = "tl-summary"; sumCell.textContent = convClip(r.summary || "—", 200);
      var statCell = document.createElement("span"); statCell.className = "tl-status " + (r.statusTone || "neutral"); statCell.textContent = r.status || "info";
      var durCell = document.createElement("span"); durCell.className = "tl-dur"; durCell.textContent = convDur(r.durMs);
      main.appendChild(chip); main.appendChild(sumCell); main.appendChild(statCell); main.appendChild(durCell);
      var meta = document.createElement("div"); meta.className = "tl-meta";
      var metaTime = document.createElement("span"); metaTime.textContent = (r.ts ? convClock(r.ts) : "live") + (delta ? " " + delta : "");
      var metaOwner = document.createElement("span"); metaOwner.textContent = convClip(r.owner, 24);
      meta.appendChild(metaTime); meta.appendChild(metaOwner);
      var rawType = (r.raws && r.raws[0] && r.raws[0].type) ? String(r.raws[0].type) : "";
      if (rawType && rawType !== r.type) { var metaRaw = document.createElement("span"); metaRaw.textContent = rawType; meta.appendChild(metaRaw); }
      row.appendChild(main); row.appendChild(meta);
      (function (id, rowEl) {
        function toggle() {
          stream.__selectedId = stream.__selectedId === id ? null : id;
          renderConversationStream(input);
        }
        rowEl.addEventListener("click", toggle);
        rowEl.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      })(rowId, row);
      stream.appendChild(row);
    }
    renderEventInspector(input, selRow);
    if (stream.__scrollToSelected && selDom) { selDom.scrollIntoView({ block: "nearest" }); stream.__scrollToSelected = false; }
    else if (atBottom && !selRow) stream.scrollTop = stream.scrollHeight;
  }

  window.MAB_LAN_OPERATOR_DEBUG_PANEL = { applyFilter, renderTurnsAndConversation, renderToolAndKwwk, renderConversationStream };
})();`;
}
