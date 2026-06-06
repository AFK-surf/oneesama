export function buildLanOperatorArtifactClientScript() {
  return `(() => {
  function linkedArtifact(input = {}) {
    return {
      ts: new Date().toISOString(),
      label: String(input.label || "artifact"),
      kind: String(input.kind || "artifact"),
      href: String(input.href || ""),
      bytes: Number.isFinite(Number(input.bytes)) ? Number(input.bytes) : null,
      contentType: String(input.contentType || "") || null,
      reason: String(input.reason || "large_artifact"),
      policy: "linked_only",
    };
  }

  function bundleEntry(input = {}) {
    return {
      id: String(input.id || input.kind || "entry"),
      kind: String(input.kind || "artifact"),
      label: String(input.label || input.id || "artifact"),
      href: input.href ? String(input.href) : null,
      bytes: Number.isFinite(Number(input.bytes)) ? Number(input.bytes) : null,
      contentType: String(input.contentType || "") || null,
      policy: String(input.policy || "generated"),
    };
  }

  function createBundleManifest(state, input = {}) {
    const report = input.report || {};
    const links = state.artifacts.largeArtifacts || [];
    const sessionId = String(input.sessionId || state.sessionId || report.sessionId || "lan_operator");
    const ts = new Date().toISOString();
    const id = "debug_bundle_" + String(Date.now());
    const entries = [
      bundleEntry({
        id: "debug_report",
        kind: "json",
        label: "Debug Report JSON",
        bytes: Number(input.reportBytes || 0) || null,
        contentType: "application/json",
        policy: "inline_report",
      }),
      bundleEntry({
        id: "timeline_rows",
        kind: "json",
        label: "Timeline rows",
        bytes: JSON.stringify(report.timeline || []).length,
        contentType: "application/json",
        policy: "generated",
      }),
      bundleEntry({
        id: "turns",
        kind: "json",
        label: "Turn correlation",
        bytes: JSON.stringify(report.debug?.timeline?.turns || report.turns || []).length,
        contentType: "application/json",
        policy: "generated",
      }),
      bundleEntry({
        id: "summaries",
        kind: "json",
        label: "Debug summaries",
        bytes: JSON.stringify(report.summaries || {}).length,
        contentType: "application/json",
        policy: "generated",
      }),
      bundleEntry({
        id: "failure_matrix",
        kind: "json",
        label: "Failure matrix",
        bytes: JSON.stringify(input.failureMatrix || report.failureMatrix || {}).length,
        contentType: "application/json",
        policy: "generated",
      }),
      bundleEntry({
        id: "slo",
        kind: "json",
        label: "SLO scoring",
        bytes: JSON.stringify(input.slo || report.slo || {}).length,
        contentType: "application/json",
        policy: "generated",
      }),
      bundleEntry({
        id: "large_artifacts",
        kind: "manifest",
        label: "Large artifact links",
        bytes: JSON.stringify(links).length,
        contentType: "application/json",
        policy: "linked_only",
      }),
      ...links.map((artifact, index) => bundleEntry({
        id: "large_artifact_" + String(index + 1),
        kind: artifact.kind || "artifact",
        label: artifact.label || "artifact",
        href: artifact.href || null,
        bytes: artifact.bytes,
        contentType: artifact.contentType,
        policy: "linked_only",
      })),
    ];
    return {
      schema: "oneesama.lan_operator_debug_bundle.v1",
      id,
      ts,
      sessionId,
      label: String(input.label || "Local Operator Debug Bundle"),
      href: input.href ? String(input.href) : null,
      entryCount: entries.length,
      entries,
    };
  }

  window.MAB_LAN_OPERATOR_ARTIFACTS = {
    create(input) {
      const state = input.state;
      function record(action, detail = {}) {
        const ts = new Date().toISOString();
        state.artifacts.lastReportAt = ts;
        state.artifacts.lastReportAction = action === "link" ? "mark" : action;
        if (action === "copy") state.artifacts.reportCopyCount += 1;
        if (action === "download") state.artifacts.reportDownloadCount += 1;
        if (action === "mark") {
          state.artifacts.interestingMarks = [
            ...state.artifacts.interestingMarks,
            { ts, label: String(detail.label || "interesting"), note: String(detail.note || "") },
          ].slice(-40);
        }
        if (action === "link") {
          state.artifacts.largeArtifacts = [
            ...(state.artifacts.largeArtifacts || []),
            linkedArtifact({ ...detail, ts }),
          ].filter((artifact) => artifact.href).slice(-40);
        }
        if (action === "bundle") {
          const manifest = createBundleManifest(state, detail);
          state.artifacts.bundleCount += 1;
          state.artifacts.bundles = [
            ...(state.artifacts.bundles || []),
            manifest,
          ].slice(-12);
          detail = {
            label: manifest.label,
            bundleId: manifest.id,
            entryCount: manifest.entryCount,
            bundle: manifest,
          };
          state.artifacts.lastReportAction = "bundle";
        }
        input.sendOperatorEvent?.({ type: "debug_report_artifact", action, ...detail });
        input.syncDebug?.();
      }
      return {
        record,
        registerLink(detail = {}) {
          record("link", detail);
          return state.artifacts.largeArtifacts.at(-1) || null;
        },
        createBundle(detail = {}) {
          record("bundle", detail);
          return state.artifacts.bundles.at(-1) || null;
        },
        render(tableInput) {
          const links = state.artifacts.largeArtifacts || [];
          const bundles = state.artifacts.bundles || [];
          tableInput.summary.textContent =
            "copy:" + String(state.artifacts.reportCopyCount) +
            " dl:" + String(state.artifacts.reportDownloadCount) +
            " links:" + String(links.length) +
            " bundles:" + String(bundles.length);
          const bundleRows = bundles.slice(-3).reverse().map((bundle) => [
            "bundle",
            bundle.label,
            String(bundle.entryCount),
            String(bundle.id || "-"),
          ]);
          const linkRows = links.slice(-5).reverse().map((artifact) => [
            artifact.kind,
            artifact.label,
            artifact.bytes == null ? "-" : String(artifact.bytes),
            String(artifact.href || "-") + " / " + String(artifact.policy || "linked_only"),
          ]);
          tableInput.replaceTableRows(tableInput.table, bundleRows.length || linkRows.length ? [
            ...bundleRows,
            ...linkRows,
          ] : [["report", state.artifacts.lastReportAction || "idle", "-", "inline summary only"]]);
        },
      };
    },
  };
})();`;
}
