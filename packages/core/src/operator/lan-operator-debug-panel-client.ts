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
      ["Engine", String(conversation.engineId || "unknown") + " / " + boot.conversationTransport],
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

    const adapterKind = provider.adapterKind || conversation.engineId || boot.conversationTransport || "unknown";
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

  window.MAB_LAN_OPERATOR_DEBUG_PANEL = { applyFilter, renderTurnsAndConversation, renderToolAndKwwk };
})();`;
}
