#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { validateSyntheticSpeakerProfileIsolation } from "./real-meet-synthetic-speaker-smoke.mjs";
import {
  calendarMeetCreationRequested,
  calendarRoomConfigSummary,
  createTemporaryCalendarMeet,
  googleCalendarRoomConfigFromEnv,
} from "./real-meet-calendar-room.mjs";
import { hostAdmissionConfigFromEnv } from "./real-meet-host-admission-helper.mjs";
import {
  argValue as resolveArgValue,
  extractRealMeetUrlFromJoinStatus,
  normalizeRealMeetUrl,
  resolveRealMeetUrl,
} from "./real-meet-url-resolver.mjs";

export { extractRealMeetUrlFromJoinStatus, normalizeRealMeetUrl };

const SELF = fileURLToPath(import.meta.url);
const SYNTHETIC_SCRIPT = fileURLToPath(
  new URL("./real-meet-synthetic-speaker-smoke.mjs", import.meta.url),
);

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || "").trim());
}

function requireRealMeetUrl() {
  return (
    envFlag("MAB_REQUIRE_REAL_MEET_URL") ||
    envFlag("MAB_REAL_MEET_REQUIRED") ||
    process.argv.includes("--require-real-meet-url")
  );
}

function meetCompatMode() {
  return process.argv.includes("--meet-compat");
}

function withAcceptanceLane(result) {
  if (!meetCompatMode()) return result;
  return {
    gate: "meet_compat",
    acceptanceLane: "meet_compat_secondary",
    primaryAcceptanceLane: "lan_operator",
    ...result,
  };
}

function argValue(name) {
  return resolveArgValue(process.argv, name);
}

function profileSummary(profile) {
  return {
    profileMode: profile?.profileMode || "",
    browserUserDataDirConfigured: Boolean(profile?.browserUserDataDir),
    browserChannel: profile?.browserChannel || "",
    chromiumExecutablePathConfigured: Boolean(profile?.chromiumExecutablePath),
  };
}

function mainBotProfileConfigFromEnv(env = process.env) {
  const browserUserDataDir = String(env.MAB_BROWSER_USER_DATA_DIR || "").trim();
  const profileMode =
    String(env.MAB_MEET_PROFILE_MODE || "")
      .trim()
      .toLowerCase() || (browserUserDataDir ? "persistent" : "");
  if (profileMode && !["guest", "persistent"].includes(profileMode)) {
    throw new Error("MAB_MEET_PROFILE_MODE must be guest or persistent");
  }
  if (profileMode === "persistent" && !browserUserDataDir) {
    throw new Error("MAB_BROWSER_USER_DATA_DIR is required when MAB_MEET_PROFILE_MODE=persistent");
  }
  return {
    profileMode,
    browserUserDataDir,
    browserChannel: String(env.MAB_BROWSER_CHANNEL || "").trim(),
    chromiumExecutablePath: String(env.MAB_CHROMIUM_EXECUTABLE || "").trim(),
  };
}

function persistentProfileLaunchIdentityWarning(profile, role) {
  if (profile?.profileMode !== "persistent" || !profile?.browserUserDataDir) return null;
  if (profile.browserChannel || profile.chromiumExecutablePath) return null;
  return {
    reason: `${role}_profile_launch_identity_unverified`,
    message:
      "Preflight can verify profile path isolation only. Configure a matching browser channel or Chromium executable before treating Google sign-in state as real-room evidence.",
    profile: profileSummary(profile),
  };
}

export function buildAdmissionRecipes({ calendarMeetCreation = null } = {}) {
  const autoRoom = calendarMeetCreation?.requested === true;
  return [
    {
      id: "main_bot_host_profile",
      label: "Use an authenticated main bot profile that can host or is invited",
      env: [
        "MAB_MEET_PROFILE_MODE=persistent",
        "MAB_BROWSER_USER_DATA_DIR=/path/to/authenticated-main-bot-profile",
      ],
      optionalEnv: ["MAB_BROWSER_CHANNEL=chrome", "MAB_CHROMIUM_EXECUTABLE=/path/to/chrome"],
      worksWithAutoRoom: true,
      note: autoRoom
        ? "Best for auto-room: the Calendar-created room can admit the main bot when this profile owns or can join the event."
        : "Use when the provided Meet room admits this authenticated bot identity.",
    },
    {
      id: "invited_synthetic_speaker_profile",
      label: "Use an authenticated synthetic speaker profile invited by Calendar",
      env: [
        "MAB_SYNTHETIC_SPEAKER_PROFILE_MODE=persistent",
        "MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR=/path/to/authenticated-speaker-profile",
        "MAB_REAL_MEET_CALENDAR_ATTENDEES=speaker@example.com",
      ],
      optionalEnv: [
        "MAB_SYNTHETIC_SPEAKER_BROWSER_CHANNEL=chrome",
        "MAB_SYNTHETIC_SPEAKER_CHROMIUM_EXECUTABLE=/path/to/chrome",
      ],
      worksWithAutoRoom: true,
      note: "The speaker profile must be separate from the main bot profile. For auto-room, include the speaker email in Calendar attendees.",
    },
    {
      id: "host_admission_actor",
      label: "Run a separate authenticated host actor to invite/admit the speaker",
      env: [
        "MAB_REAL_MEET_HOST_ADMISSION=1",
        "MAB_HOST_ADMISSION_BROWSER_USER_DATA_DIR=/path/to/authenticated-host-profile",
      ],
      optionalEnv: [
        "MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL=speaker@example.com",
        "MAB_HOST_ADMISSION_BROWSER_CHANNEL=chrome",
        "MAB_HOST_ADMISSION_CHROMIUM_EXECUTABLE=/path/to/chrome",
      ],
      worksWithAutoRoom: true,
      note: "The host profile must be separate from both main bot and synthetic speaker profiles.",
    },
  ];
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function chromeProfileLockFiles(profileDir) {
  return ["SingletonLock", "SingletonSocket", "SingletonCookie"]
    .map((name) => pathJoin(profileDir, name))
    .filter((path) => existsSync(path));
}

const CHROME_PROFILE_COPY_EXCLUDED_DIRS = new Set([
  "BrowserMetrics",
  "Cache",
  "Code Cache",
  "Crashpad",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "Safe Browsing",
  "ShaderCache",
  "component_crx_cache",
  "extensions_crx_cache",
]);

function shouldCopyChromeProfilePath(sourceRoot, entryPath) {
  const relative = pathRelative(sourceRoot, entryPath);
  if (!relative) return true;
  const name = basename(entryPath);
  if (name.startsWith("Singleton")) return false;
  const parts = relative.split(/[\\/]+/);
  return !parts.some((part) => CHROME_PROFILE_COPY_EXCLUDED_DIRS.has(part));
}

export async function prepareSyntheticSpeakerProfileClone({
  env = process.env,
  force = false,
  now = new Date(),
} = {}) {
  const mainBotProfile = mainBotProfileConfigFromEnv(env);
  if (mainBotProfile.profileMode !== "persistent" || !mainBotProfile.browserUserDataDir) {
    return {
      ok: false,
      reason: "main_bot_persistent_profile_required",
      requiredFix:
        "Set MAB_MEET_PROFILE_MODE=persistent and MAB_BROWSER_USER_DATA_DIR to the authenticated main bot Chrome profile before preparing a speaker clone.",
      mainBotProfile: profileSummary(mainBotProfile),
    };
  }

  const sourceDir = pathResolve(mainBotProfile.browserUserDataDir);
  if (!existsSync(sourceDir)) {
    return {
      ok: false,
      reason: "main_bot_profile_missing",
      requiredFix: `Main bot Chrome profile does not exist: ${sourceDir}`,
      mainBotProfile: profileSummary(mainBotProfile),
    };
  }

  const targetDir = pathResolve(
    env.MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR ||
      env.MAB_SYNTHETIC_SPEAKER_USER_DATA_DIR ||
      pathJoin(dirname(sourceDir), `speaker-clone-${timestampForPath(now)}`),
  );
  const isolationFailure = validateSyntheticSpeakerProfileIsolation(mainBotProfile, {
    profileMode: "persistent",
    browserUserDataDir: targetDir,
  });
  if (isolationFailure) {
    return {
      ok: false,
      reason: isolationFailure.reason,
      requiredFix: isolationFailure.requiredFix,
      failure: isolationFailure,
      sourceDir,
      targetDir,
    };
  }

  const locks = chromeProfileLockFiles(sourceDir);
  if (locks.length > 0) {
    return {
      ok: false,
      reason: "main_bot_profile_locked",
      requiredFix:
        "Stop Chrome/meeting-agent sessions using the main bot profile before cloning it for the synthetic speaker.",
      sourceDir,
      targetDir,
      lockFileCount: locks.length,
    };
  }

  if (existsSync(targetDir)) {
    if (!force) {
      return {
        ok: false,
        reason: "speaker_profile_already_exists",
        requiredFix:
          "Choose a new MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR or pass --force-speaker-profile-clone to replace the existing clone.",
        sourceDir,
        targetDir,
      };
    }
    await rm(targetDir, { recursive: true, force: true });
  }

  await mkdir(dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (entryPath) => shouldCopyChromeProfilePath(sourceDir, entryPath),
  });

  return {
    ok: true,
    reason: "speaker_profile_prepared",
    sourceDir,
    targetDir,
    mainBotProfile: profileSummary(mainBotProfile),
    syntheticSpeakerProfile: {
      profileMode: "persistent",
      browserUserDataDirConfigured: true,
    },
    env: {
      MAB_SYNTHETIC_SPEAKER_PROFILE_MODE: "persistent",
      MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR: targetDir,
      ...(env.MAB_BROWSER_CHANNEL
        ? { MAB_SYNTHETIC_SPEAKER_BROWSER_CHANNEL: env.MAB_BROWSER_CHANNEL }
        : {}),
      ...(env.MAB_CHROMIUM_EXECUTABLE
        ? { MAB_SYNTHETIC_SPEAKER_CHROMIUM_EXECUTABLE: env.MAB_CHROMIUM_EXECUTABLE }
        : {}),
    },
    excludedDirs: Array.from(CHROME_PROFILE_COPY_EXCLUDED_DIRS).sort(),
  };
}

function syntheticSpeakerProfileConfigFromEnv(env = process.env) {
  const profileMode = String(
    env.MAB_SYNTHETIC_SPEAKER_PROFILE_MODE ||
      env.MAB_SYNTHETIC_SPEAKER_MEET_PROFILE_MODE ||
      "guest",
  )
    .trim()
    .toLowerCase();
  if (!["guest", "persistent"].includes(profileMode)) {
    throw new Error("MAB_SYNTHETIC_SPEAKER_PROFILE_MODE must be guest or persistent");
  }
  const browserUserDataDir = String(
    env.MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR ||
      env.MAB_SYNTHETIC_SPEAKER_USER_DATA_DIR ||
      "",
  ).trim();
  if (profileMode === "persistent" && !browserUserDataDir) {
    throw new Error(
      "MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR is required when MAB_SYNTHETIC_SPEAKER_PROFILE_MODE=persistent",
    );
  }
  return {
    profileMode,
    browserUserDataDir,
    browserChannel: String(
      env.MAB_SYNTHETIC_SPEAKER_BROWSER_CHANNEL || env.MAB_SYNTHETIC_SPEAKER_CHROME_CHANNEL || "",
    ).trim(),
    chromiumExecutablePath: String(
      env.MAB_SYNTHETIC_SPEAKER_CHROMIUM_EXECUTABLE ||
        env.MAB_SYNTHETIC_SPEAKER_CHROME_EXECUTABLE ||
        "",
    ).trim(),
  };
}

export function buildSidecarAcceptancePreflight({
  env = process.env,
  meetUrl = "",
  meetUrlSource = "",
  calendarMeetCreation = null,
} = {}) {
  let mainBotProfile;
  let syntheticSpeakerProfile;
  const hostAdmission = hostAdmissionConfigFromEnv(env);
  const blockers = [];
  const warnings = [];

  try {
    mainBotProfile = mainBotProfileConfigFromEnv(env);
    syntheticSpeakerProfile = syntheticSpeakerProfileConfigFromEnv(env);
  } catch (error) {
    blockers.push({
      blocker: "invalid_profile_configuration",
      blockerSource: "preflight",
      requiredFix: String(error?.message || error),
    });
  }

  if (mainBotProfile && syntheticSpeakerProfile) {
    const isolationFailure = validateSyntheticSpeakerProfileIsolation(
      mainBotProfile,
      syntheticSpeakerProfile,
    );
    if (isolationFailure) {
      blockers.push({
        blocker: isolationFailure.reason,
        blockerSource: "synthetic_speaker",
        requiredFix: isolationFailure.requiredFix,
        failure: isolationFailure,
      });
    }

    if (syntheticSpeakerProfile.profileMode === "guest") {
      warnings.push({
        reason: "synthetic_speaker_guest_profile",
        message:
          "Strict Meet rooms may reject uninvited guest speakers; use a separate authenticated speaker profile if admission fails.",
      });
    }
    const mainLaunchWarning = persistentProfileLaunchIdentityWarning(mainBotProfile, "main_bot");
    if (mainLaunchWarning) warnings.push(mainLaunchWarning);
    const speakerLaunchWarning = persistentProfileLaunchIdentityWarning(
      syntheticSpeakerProfile,
      "synthetic_speaker",
    );
    if (speakerLaunchWarning) warnings.push(speakerLaunchWarning);
  }
  if (hostAdmission.enabled && !hostAdmission.ok) {
    blockers.push({
      blocker: hostAdmission.blocker || "host_admission_invalid",
      blockerSource: "host_admission",
      requiredFix: hostAdmission.requiredFix || "",
      failure: hostAdmission,
    });
  }
  if (calendarMeetCreation?.requested && calendarMeetCreation?.config?.ok === false) {
    blockers.push({
      blocker: "google_calendar_credentials_missing",
      blockerSource: "calendar_meet",
      requiredFix:
        "Set GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN, or point MAB_WORKSPACE_TOOLS_ENV_FILE / MAB_GOOGLE_CREDENTIAL_FILE at a file containing them.",
      failure: calendarMeetCreation,
    });
  }
  const calendarAutoRoomNeedsAdmissionPath =
    calendarMeetCreation?.requested &&
    calendarMeetCreation?.config?.ok === true &&
    hostAdmission.enabled !== true &&
    mainBotProfile?.profileMode !== "persistent" &&
    !(
      syntheticSpeakerProfile?.profileMode === "persistent" &&
      Number(calendarMeetCreation?.config?.attendeeCount || 0) > 0
    );
  if (calendarAutoRoomNeedsAdmissionPath) {
    blockers.push({
      blocker: "calendar_auto_room_admission_path_missing",
      blockerSource: "calendar_meet",
      requiredFix:
        "Auto-created Calendar Meet rooms still require admission. Configure an authenticated main bot host profile, an invited authenticated synthetic-speaker profile, or MAB_REAL_MEET_HOST_ADMISSION with a separate host profile.",
      failure: calendarMeetCreation,
    });
  }

  const firstBlocker = blockers[0] || null;
  const admissionRecipes = buildAdmissionRecipes({ calendarMeetCreation });
  const admissionPreconditions = {
    realMeetRoomRequired: true,
    syntheticSpeakerMustBeAdmitted: true,
    hostAdmissionActorConfigured: hostAdmission.enabled === true,
    hostAdmissionProfileConfigured: hostAdmission.browserUserDataDirConfigured === true,
    hostAdmissionInviteEmailConfigured: hostAdmission.inviteEmailConfigured === true,
    calendarAutoRoomRequested: calendarMeetCreation?.requested === true,
    calendarAutoRoomAdmissionPathConfigured: !calendarAutoRoomNeedsAdmissionPath,
    roomAdmissionVerified: false,
    profileLaunchIdentityVerified:
      warnings.some((warning) =>
        String(warning.reason || "").endsWith("profile_launch_identity_unverified"),
      ) === false,
    meetFreeCuGatesAvailable: true,
    profilesConfiguredOnly: blockers.length === 0,
    mainBotProfileMode: mainBotProfile?.profileMode || "",
    syntheticSpeakerProfileMode: syntheticSpeakerProfile?.profileMode || "",
    message:
      "Preflight validates URL/profile wiring only; final acceptance still requires a Meet room or host profile that admits the synthetic speaker.",
  };
  return {
    ok: blockers.length === 0,
    preflightSatisfied: blockers.length === 0,
    acceptanceSatisfied: false,
    preflightOnly: true,
    diagnosticOnly: true,
    skipped: false,
    blocker: firstBlocker?.blocker || "",
    blockerSource: firstBlocker?.blockerSource || "",
    requiredFix: firstBlocker?.requiredFix || "",
    meetUrl,
    meetUrlSource,
    mainBotProfile: profileSummary(mainBotProfile),
    syntheticSpeakerProfile: profileSummary(syntheticSpeakerProfile),
    hostAdmission,
    calendarMeetCreation,
    admissionPreconditions,
    admissionRecipes,
    warnings,
    blockers,
  };
}

async function writeJsonOutIfRequested(output) {
  const jsonOut = argValue("--json-out");
  if (jsonOut) await writeFile(jsonOut, `${output}\n`);
}

async function emitJsonResult(result, { error = false } = {}) {
  const output = JSON.stringify(result, null, 2);
  await writeJsonOutIfRequested(output);
  if (error) console.error(output);
  else console.log(output);
}

async function skipMissingRealMeetUrl(resolution = {}) {
  const strict = requireRealMeetUrl();
  const result = {
    ok: false,
    skipped: !strict,
    diagnosticOnly: !strict,
    acceptanceSatisfied: false,
    reason: "missing_env",
    missingEnv: ["MAB_REAL_MEET_URL"],
    checkedSources: resolution.checkedSources || [],
    discoveryError: resolution.discoveryError || "",
    activeBrowserRecordError: resolution.activeBrowserRecordError || "",
    command: meetCompatMode()
      ? "MAB_REAL_MEET_URL=https://meet.google.com/... npm run acceptance:realtime-meet-compat"
      : "MAB_REAL_MEET_URL=https://meet.google.com/... npm run acceptance:realtime-live-sidecar",
    message:
      "Set MAB_REAL_MEET_URL, pass --real-meet-url, or keep a meeting-agent session active so /join/status exposes the real Meet URL.",
  };
  const output = withAcceptanceLane(result);
  await emitJsonResult(output, { error: strict });
  if (strict) process.exitCode = 1;
  return output;
}

function forwardChildOutput(label, stream) {
  stream.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk.toString()}`);
  });
}

async function runGate(label, args, sessionId, meetUrl) {
  let tmpDir = "";
  try {
    tmpDir = await mkdtemp(pathJoin(tmpdir(), `oneesama-${label}-`));
    const jsonOut = pathJoin(tmpDir, "result.json");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SYNTHETIC_SCRIPT, ...args, "--json-out", jsonOut],
      {
        env: {
          ...process.env,
          MAB_REAL_MEET_URL: meetUrl,
          MAB_REAL_MEET_SESSION_ID: sessionId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    forwardChildOutput(label, child.stdout);
    forwardChildOutput(`${label}:stderr`, child.stderr);
    const exit = await waitForChildExit(child, realMeetChildTimeoutMs());
    if (!existsSync(jsonOut)) {
      return {
        ok: false,
        acceptanceSatisfied: false,
        reason: exit.timedOut ? "gate_timeout" : "missing_json",
        error: exit.timedOut
          ? `${label} timed out after ${exit.timeoutMs}ms before writing ${jsonOut}`
          : `${label} did not write ${jsonOut}`,
        childExit: exit,
      };
    }
    return parseGateJsonResult(label, await readFile(jsonOut, "utf8"), exit);
  } catch (error) {
    return gateRunErrorResult(label, error);
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function realMeetChildTimeoutMs() {
  const value =
    process.env.MAB_REAL_MEET_COMPAT_CHILD_TIMEOUT_MS ||
    process.env.MAB_REAL_MEET_CHILD_TIMEOUT_MS ||
    "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function gateRunErrorResult(label, error) {
  return {
    ok: false,
    acceptanceSatisfied: false,
    reason: "gate_error",
    error: `${label} gate failed: ${String(error?.message || error)}`,
    childExit: null,
  };
}

export async function waitForChildExit(child, timeoutMs = 0) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let hardKillTimer = null;
    const cleanup = () => {
      child.off("error", fail);
      child.off("exit", finish);
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => settle(reject, error);
    const finish = (code, signal) => settle(resolve, { code, signal, timedOut, timeoutMs });
    child.once("error", fail);
    child.once("exit", finish);
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);
    }
  });
}

export function parseGateJsonResult(label, text, childExit) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return {
      ...parsed,
      childExit,
    };
  } catch (error) {
    return {
      ok: false,
      acceptanceSatisfied: false,
      reason: "invalid_json",
      error: `${label} wrote invalid JSON evidence: ${String(error?.message || error)}`,
      raw: String(text || "").slice(0, 500),
      childExit,
    };
  }
}

function childExitSucceeded(result = {}) {
  const exit = result.childExit;
  return Boolean(exit && exit.code === 0 && !exit.signal);
}

export function compactSyntheticResult(result = {}) {
  const compact = result?.final?.compact || result?.last?.compact || {};
  const childOk = childExitSucceeded(result);
  const textTurnFallback =
    result?.textTurnFallback ||
    result?.final?.textTurnFallback ||
    result?.last?.textTurnFallback ||
    null;
  return {
    ok: result.ok === true && childOk,
    acceptanceSatisfied: childOk && result.acceptanceSatisfied === true && !textTurnFallback,
    sessionId: result.sessionId || "",
    failure: result.failure || null,
    hostAdmission: result.hostAdmission || null,
    mainBotProfile: result.mainBotProfile || null,
    syntheticSpeakerProfile: result.syntheticSpeakerProfile || null,
    gates: result?.final?.gates || result?.last?.gates || {},
    toolCalls: compact.toolCalls || null,
    textTurnFallback,
    error: result.error || "",
    childExit: result.childExit || null,
  };
}

export function compactAppControlResult(result = {}) {
  if (Array.isArray(result.suite)) {
    const cases = result.suite.map((entry) => {
      const final = entry?.final || {};
      const appControl = final.appControl || {};
      const joinStatus = final.joinStatus || {};
      return {
        id: entry.id || "",
        kind: entry.kind || "",
        ok: entry.ok === true,
        acceptanceSatisfied: entry.acceptanceSatisfied === true,
        status: appControl.status || "",
        actions: appControl.actions || [],
        cursor: appControl.cursor || null,
        timing: appControl.timing || null,
        audienceCursor: joinStatus.kwwkCursor || null,
        avatarHud: joinStatus.avatarHud || null,
        jobId: appControl.jobId || joinStatus?.toolTelemetry?.appControlJobId || "",
      };
    });
    const childOk = childExitSucceeded(result);
    return {
      ok: result.ok === true && childOk,
      acceptanceSatisfied:
        result.acceptanceSatisfied === true &&
        childOk &&
        cases.length > 0 &&
        cases.every((entry) => entry.acceptanceSatisfied),
      sessionId: result.sessionId || "",
      applicationName: result.applicationName || "",
      liveModelFirstLatency: result.liveModelFirstLatency || null,
      suite: cases,
      childExit: result.childExit || null,
    };
  }
  const final = result?.final || {};
  const appControl = final.appControl || {};
  const joinStatus = final.joinStatus || {};
  const childOk = childExitSucceeded(result);
  const meetPage =
    result?.errorBody?.postcheck?.meetPage ||
    result?.errorBody?.present?.meetPage ||
    result?.errorBody?.beforePresentation?.meetPage ||
    {};
  const meetingAdmission = {
    waitingForAdmit: meetPage.waitingForAdmit === true,
    inMeeting: meetPage.inMeeting === true,
    cannotJoin: meetPage.cannotJoin === true,
    participantCount: Number.isFinite(Number(meetPage.participantCount))
      ? Number(meetPage.participantCount)
      : null,
    textHead: String(
      meetPage.textHead || result?.errorBody?.beforePresentation?.textHead || "",
    ).slice(0, 500),
  };
  return {
    ok: result.ok === true && childOk,
    acceptanceSatisfied: result.acceptanceSatisfied === true && childOk,
    sessionId: result.sessionId || "",
    applicationName: result.applicationName || "",
    status: appControl.status || "",
    blocker:
      appControl.blocker || (meetingAdmission.waitingForAdmit ? "room_admission_required" : ""),
    error: result.error || appControl.error || "",
    jobId: appControl.jobId || joinStatus?.toolTelemetry?.appControlJobId || "",
    timing: appControl.timing || null,
    meetingAdmission,
    realtimeEvidence: {
      sidecarActive: joinStatus.sidecarActive === true,
      sidecarPageCount: Number(joinStatus.sidecarPageCount || 0),
      sdkOwnerPageCount: Number(joinStatus.sdkOwnerPageCount || 0),
      connected: joinStatus.realtime?.connected === true,
      toolTelemetry: joinStatus.toolTelemetry || null,
      meetSurface: joinStatus.meetSurface || null,
    },
    childExit: result.childExit || null,
  };
}

export function summarizeSidecarBlocker(gates = {}) {
  if (gates.syntheticSpeaker?.acceptanceSatisfied && gates.appControl?.acceptanceSatisfied) {
    return { blocker: "", blockerSource: "", requiredFix: "" };
  }

  const syntheticFailure = gates.syntheticSpeaker?.failure;
  if (
    syntheticFailure?.reason === "speaker_room_admission_required" &&
    gates.appControl?.meetingAdmission?.waitingForAdmit
  ) {
    return {
      blocker: "real_meet_room_admission_required",
      blockerSource: "real_meet_admission",
      requiredFix:
        "Run the main bot and/or synthetic speaker with authenticated profiles invited to the Calendar Meet, or enable MAB_REAL_MEET_HOST_ADMISSION with a separate host profile and MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL.",
    };
  }
  if (!gates.syntheticSpeaker?.acceptanceSatisfied) {
    const reason =
      syntheticFailure?.reason || gates.syntheticSpeaker?.error || "synthetic_speaker_failed";
    return {
      blocker: reason,
      blockerSource: "synthetic_speaker",
      requiredFix:
        syntheticFailure?.requiredFix ||
        "Use a Meet room/profile that can admit the synthetic speaker, configure a separate authenticated speaker profile, or enable MAB_REAL_MEET_HOST_ADMISSION with a separate host profile.",
    };
  }

  if (!gates.appControl?.acceptanceSatisfied) {
    const failedCase = gates.appControl?.suite?.find((entry) => !entry.acceptanceSatisfied);
    return {
      blocker: failedCase?.status || gates.appControl?.error || "app_control_failed",
      blockerSource: failedCase?.id ? `app_control:${failedCase.id}` : "app_control",
      requiredFix:
        "Inspect the app-control child gate result and rerun after fixing the failed KWWK/Realtime evidence.",
    };
  }

  return {
    blocker: "unknown_sidecar_acceptance_failure",
    blockerSource: "sidecar",
    requiredFix: "",
  };
}

export async function runRealMeetSidecarAcceptanceMain() {
  if (process.argv.includes("--prepare-speaker-profile")) {
    const result = await prepareSyntheticSpeakerProfileClone({
      force: process.argv.includes("--force-speaker-profile-clone"),
    });
    await emitJsonResult(result, { error: !result.ok });
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  const createCalendarMeet = calendarMeetCreationRequested({
    args: process.argv,
    env: process.env,
  });
  const preflightOnly = process.argv.includes("--preflight-only");
  let calendarRoom = null;
  let calendarMeetCreation = createCalendarMeet
    ? {
        requested: true,
        preflightOnly,
        config: calendarRoomConfigSummary(await googleCalendarRoomConfigFromEnv(process.env)),
      }
    : null;
  let realMeetUrl = await resolveRealMeetUrl();
  if (!realMeetUrl.meetUrl && createCalendarMeet && !preflightOnly) {
    calendarRoom = await createTemporaryCalendarMeet({ env: process.env });
    calendarMeetCreation = {
      requested: true,
      preflightOnly: false,
      ok: calendarRoom.ok === true,
      blocker: calendarRoom.blocker || "",
      requiredFix: calendarRoom.requiredFix || "",
      eventId: calendarRoom.eventId || "",
      source: calendarRoom.source || "",
      config: calendarRoom.config || calendarMeetCreation?.config || null,
    };
    if (!calendarRoom.ok) {
      const result = withAcceptanceLane({
        ok: false,
        skipped: false,
        diagnosticOnly: false,
        acceptanceSatisfied: false,
        blocker: calendarRoom.blocker || "calendar_meet_create_failed",
        blockerSource: "calendar_meet",
        requiredFix: calendarRoom.requiredFix || "",
        meetUrl: "",
        meetUrlSource: "",
        calendarMeetCreation,
        error: calendarRoom.error || "",
        status: calendarRoom.status || 0,
        completedAt: new Date().toISOString(),
      });
      await emitJsonResult(result, { error: true });
      process.exitCode = 1;
      return result;
    }
    realMeetUrl = {
      meetUrl: calendarRoom.meetUrl,
      source: "google-calendar-auto-room",
      checkedSources: [],
    };
  }
  const meetUrl = realMeetUrl.meetUrl || "";
  if (!meetUrl && !(createCalendarMeet && preflightOnly)) {
    return await skipMissingRealMeetUrl(realMeetUrl);
  }

  const startedAt = new Date().toISOString();
  const preflight = buildSidecarAcceptancePreflight({
    meetUrl,
    meetUrlSource: realMeetUrl.source || "",
    calendarMeetCreation,
  });
  if (process.argv.includes("--preflight-only")) {
    const output = withAcceptanceLane(preflight);
    await emitJsonResult(output, { error: !output.ok });
    if (!preflight.ok) process.exitCode = 1;
    return output;
  }
  if (!preflight.ok) {
    const calendarCleanup = calendarRoom?.cleanup
      ? await calendarRoom.cleanup("sidecar_preflight_failed").catch((error) => ({
          ok: false,
          error: String(error?.message || error),
        }))
      : null;
    const result = withAcceptanceLane({
      ...preflight,
      calendarCleanup,
      completedAt: new Date().toISOString(),
    });
    await emitJsonResult(result, { error: true });
    process.exitCode = 1;
    return result;
  }

  const sessionBase = process.env.MAB_REAL_MEET_SESSION_ID || `real_meet_sidecar_${Date.now()}`;
  const syntheticSpeaker = await runGate(
    "synthetic-speaker",
    [],
    `${sessionBase}_synthetic`,
    meetUrl,
  );
  const appControl = await runGate(
    "app-control",
    ["--real-meet-app-control-suite"],
    `${sessionBase}_app_control`,
    meetUrl,
  );
  const gates = {
    syntheticSpeaker: compactSyntheticResult(syntheticSpeaker),
    appControl: compactAppControlResult(appControl),
  };
  const ok = gates.syntheticSpeaker.acceptanceSatisfied && gates.appControl.acceptanceSatisfied;
  const blocker = summarizeSidecarBlocker(gates);
  let calendarCleanup = null;
  if (calendarRoom?.cleanup) {
    calendarCleanup = await calendarRoom
      .cleanup(ok ? "sidecar_acceptance_passed" : "sidecar_acceptance_failed")
      .catch((error) => ({
        ok: false,
        error: String(error?.message || error),
      }));
  }
  const result = withAcceptanceLane({
    ok,
    acceptanceSatisfied: ok,
    skipped: false,
    diagnosticOnly: false,
    blocker: blocker.blocker,
    blockerSource: blocker.blockerSource,
    requiredFix: blocker.requiredFix,
    meetUrl,
    meetUrlSource: realMeetUrl.source || "",
    calendarMeetCreation,
    calendarCleanup,
    startedAt,
    completedAt: new Date().toISOString(),
    sessionBase,
    gates,
    results: {
      syntheticSpeaker,
      appControl,
    },
  });
  await emitJsonResult(result, { error: !ok });
  if (!ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && pathResolve(process.argv[1]) === SELF) {
  await runRealMeetSidecarAcceptanceMain();
}
