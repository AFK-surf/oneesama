#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright";

import { createLanOperatorSurfaceServer } from "../packages/core/src/operator/lan-operator-surface.ts";
import {
  configureMicrophoneDevice,
  lanOperatorVoiceBrowserLaunchArgs,
  lanOperatorVoiceOperatorPageUrl,
} from "./lan-operator-voice-acceptance.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_JSON_OUT = "/tmp/oneesama-realtime-local-real-mic-preflight-latest.json";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 0,
    timeoutMs: 10_000,
    jsonOut: DEFAULT_JSON_OUT,
    headed: true,
    micDeviceId: process.env.MAB_LAN_OPERATOR_MIC_DEVICE_ID || "",
    micLabel: process.env.MAB_LAN_OPERATOR_MIC_LABEL || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++index]);
    else if (arg === "--json-out") args.jsonOut = argv[++index];
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--headless") args.headed = false;
    else if (arg === "--mic-device-id") args.micDeviceId = String(argv[++index] || "");
    else if (arg === "--mic-label") args.micLabel = String(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be positive");
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/lan-operator-real-mic-preflight.mjs [options]

Options:
  --host <host>         Bind host (default: 127.0.0.1)
  --port <port>         Bind port, 0 means random (default: 0)
  --timeout-ms <n>      Preflight timeout (default: 10000)
  --json-out <path>     Write structured report (default: ${DEFAULT_JSON_OUT})
  --mic-device-id <id>  Select an exact browser audioinput device id
  --mic-label <text>    Select first browser audioinput label containing text.
                        Also available as MAB_LAN_OPERATOR_MIC_LABEL.
  --headed              Run Chromium headed (default)
  --headless            Run Chromium headless for CI/debug probes
`);
}

function includesAny(value, terms) {
  const normalized = String(value || "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function isVirtualOrNonMicInput(device) {
  const label = String(device?.label || device?.name || "");
  const manufacturer = String(device?.manufacturer || "");
  const transport = String(device?.transport || "");
  return (
    includesAny(label, ["virtual", "steam streaming", "speaker", "output"]) ||
    includesAny(manufacturer, ["valve"]) ||
    includesAny(transport, ["virtual", "unknown"])
  );
}

export function normalizeMacAudioDevice(item = {}) {
  return {
    name: String(item._name || ""),
    manufacturer: String(item.coreaudio_device_manufacturer || ""),
    transport: String(item.coreaudio_device_transport || ""),
    inputChannels: Number(item.coreaudio_device_input || 0),
    outputChannels: Number(item.coreaudio_device_output || 0),
    sampleRate: Number(item.coreaudio_device_srate || 0) || null,
    defaultInput: item.coreaudio_default_audio_input_device === "spaudio_yes",
    defaultOutput: item.coreaudio_default_audio_output_device === "spaudio_yes",
  };
}

function flattenMacAudioDevices(profile) {
  const roots = Array.isArray(profile?.SPAudioDataType) ? profile.SPAudioDataType : [];
  return roots.flatMap((root) => (Array.isArray(root?._items) ? root._items : []));
}

export function summarizeAudioInputs(systemDevices = [], browserDevices = []) {
  const systemInputs = systemDevices
    .map(normalizeMacAudioDevice)
    .filter((device) => Number(device.inputChannels || 0) > 0)
    .map((device) =>
      Object.assign({}, device, { realInputCandidate: !isVirtualOrNonMicInput(device) }),
    );
  const browserInputs = (Array.isArray(browserDevices) ? browserDevices : []).map((device) => ({
    deviceId: String(device?.deviceId || ""),
    label: String(device?.label || ""),
    groupId: String(device?.groupId || ""),
    realInputCandidate: !isVirtualOrNonMicInput({ label: device?.label }),
  }));
  const selectedBrowserInput =
    browserInputs.find((device) => device.deviceId === "default") || browserInputs[0] || null;
  const systemRealInputCount = systemInputs.filter((device) => device.realInputCandidate).length;
  const browserRealInputCount = browserInputs.filter((device) => device.realInputCandidate).length;
  const defaultSystemInput = systemInputs.find((device) => device.defaultInput) || null;
  const ok = systemRealInputCount >= 1 && browserRealInputCount >= 1;
  const blocker = ok
    ? null
    : systemRealInputCount < 1
      ? "macos_no_real_microphone_input"
      : "browser_no_real_microphone_input";
  return {
    ok,
    blocker,
    system: {
      inputs: systemInputs,
      defaultInput: defaultSystemInput,
      realInputCount: systemRealInputCount,
      virtualOrNonMicInputCount: systemInputs.length - systemRealInputCount,
    },
    browser: {
      inputs: browserInputs,
      selectedInput: selectedBrowserInput,
      realInputCount: browserRealInputCount,
      virtualOrNonMicInputCount: browserInputs.length - browserRealInputCount,
    },
  };
}

async function readSystemAudioProfile() {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      devices: [],
      error: "system_audio_preflight_requires_macos",
    };
  }
  const { stdout } = await execFileAsync("system_profiler", ["SPAudioDataType", "-json"], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const profile = JSON.parse(stdout);
  return {
    platform: process.platform,
    devices: flattenMacAudioDevices(profile),
    rawProfile: profile,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  let surface = null;
  let browser = null;
  let context = null;
  let listenResult = null;
  let report = null;
  try {
    const systemAudio = await readSystemAudioProfile();
    surface = createLanOperatorSurfaceServer({
      host: args.host,
      port: args.port,
      sessionId: `local_real_mic_preflight_${Date.now().toString(36)}`,
      botName: "Local Oneesama",
    });
    listenResult = await surface.listen();
    browser = await chromium.launch({
      headless: !args.headed,
      args: lanOperatorVoiceBrowserLaunchArgs(listenResult.url, { inputMode: "real_mic" }),
    });
    context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1100, height: 760 },
    });
    const page = await context.newPage();
    await page.goto(lanOperatorVoiceOperatorPageUrl(listenResult.url));
    await page.waitForFunction(() => window.MAB_LAN_OPERATOR_SURFACE?.state?.ready === true, null, {
      timeout: args.timeoutMs,
    });
    const micDeviceSelection = await configureMicrophoneDevice(page, {
      inputMode: "real_mic",
      micDeviceId: args.micDeviceId,
      micLabel: args.micLabel,
    });
    const clientState = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      pageUrl: location.href,
      voiceDeviceId: window.MAB_LAN_OPERATOR_SURFACE.state.voiceDeviceId,
      voiceDevices: window.MAB_LAN_OPERATOR_SURFACE.state.voiceDevices,
      voiceCapture: window.MAB_LAN_OPERATOR_SURFACE.state.voiceCapture,
    }));
    const summary = summarizeAudioInputs(
      systemAudio.devices,
      micDeviceSelection.availableDevices || clientState.voiceDevices,
    );
    const requestedMissing =
      micDeviceSelection.requested === true && micDeviceSelection.ok === false;
    const ok = summary.ok === true && !requestedMissing;
    const blocker = requestedMissing ? "requested_microphone_device_not_found" : summary.blocker;
    report = {
      schema: "oneesama.local_real_mic_preflight.v1",
      gate: "local_real_mic_preflight",
      ok,
      generatedAt: new Date().toISOString(),
      status: ok ? "ready" : "blocked",
      blocker,
      host: { url: listenResult.url },
      systemAudio: {
        platform: systemAudio.platform,
        ...summary.system,
      },
      browserAudio: {
        ...summary.browser,
        micDeviceSelection,
        selectedDeviceId: clientState.voiceDeviceId || "",
        selectedDeviceLabel: clientState.voiceCapture?.deviceLabel || "",
        userAgent: clientState.userAgent,
        pageUrl: clientState.pageUrl,
      },
      nextActions: ok
        ? [
            "Run vp run acceptance:realtime-local-voice:real-mic.",
            "Run vp run acceptance:realtime-local-kwwk-action:real-mic.",
          ]
        : [
            "Connect or enable a real microphone on the host Mac.",
            "Set macOS Sound Input to the real microphone.",
            "Re-run this preflight; use MAB_LAN_OPERATOR_MIC_LABEL or MAB_LAN_OPERATOR_MIC_DEVICE_ID if Chromium sees multiple inputs.",
          ],
      args: {
        headed: args.headed,
        micDeviceId: args.micDeviceId,
        micLabel: args.micLabel,
      },
    };
  } catch (error) {
    report = {
      schema: "oneesama.local_real_mic_preflight.v1",
      gate: "local_real_mic_preflight",
      ok: false,
      generatedAt: new Date().toISOString(),
      status: "failed",
      blocker: "real_mic_preflight_failed",
      error: String(error?.message || error),
      host: { url: listenResult?.url || "" },
      args: {
        headed: args.headed,
        micDeviceId: args.micDeviceId,
        micLabel: args.micLabel,
      },
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await surface?.close().catch(() => undefined);
  }
  await writeJson(args.jsonOut, report);
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        status: report.status,
        blocker: report.blocker,
        systemDefaultInput: report.systemAudio?.defaultInput?.name || null,
        browserSelectedInput:
          report.browserAudio?.selectedInput?.label ||
          report.browserAudio?.selectedDeviceLabel ||
          null,
        jsonOut: args.jsonOut,
      },
      null,
      2,
    ),
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("lan-operator-real-mic-preflight.mjs")) {
  await run();
}
