#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import {
  createDiagnostics,
  loadPlaywright,
  saveDiagnostics,
} from "../packages/core/src/meeting/google-meet-joiner-base.ts";
import { buildGoogleMeetChromiumArgs } from "../packages/core/src/meeting/google-meet-launch-args.ts";

function envFlagValue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function envMs(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name] || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeProfileDir(path) {
  const raw = String(path || "").trim();
  if (!raw) return "";
  const resolved = pathResolve(raw);
  return process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function classifyHostAdmissionButtonLabel(label) {
  const text = String(label || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { admit: false, invite: false, people: false, ignored: true };
  const lower = text.toLowerCase();
  const ignored =
    /ask to join|join now|return to home|cancel|dismiss|deny|reject|leave|hang up|not now/i.test(
      text,
    ) || /申请加入|立即加入|返回|取消|拒绝|离开|挂断|暂不/i.test(text);
  const admit =
    !ignored &&
    (/\badmit\b|\badmit all\b|\blet in\b|\ballow\b|\baccept\b/i.test(text) ||
      /允许|准许|接纳|接受|同意|让.*加入|准入|放行/.test(text));
  const invite =
    !ignored &&
    (/\badd people\b|\badd others\b|\binvite\b|\bsend invite\b/i.test(text) ||
      /添加.*人|邀请|添加他人|发送邀请/.test(text));
  const people =
    /\bpeople\b|\bparticipants\b|\bshow everyone\b/i.test(lower) ||
    /参会者|参与者|人员|所有人|显示所有人/.test(text);
  return { admit, invite, people, ignored };
}

export function hostAdmissionConfigFromEnv(env = process.env) {
  const browserUserDataDir = firstEnv(env, [
    "MAB_HOST_ADMISSION_BROWSER_USER_DATA_DIR",
    "MAB_MEET_HOST_BROWSER_USER_DATA_DIR",
    "MAB_HOST_BROWSER_USER_DATA_DIR",
  ]);
  const inviteEmail = firstEnv(env, [
    "MAB_SYNTHETIC_SPEAKER_INVITE_EMAIL",
    "MAB_HOST_ADMISSION_INVITE_EMAIL",
  ]);
  const explicitlyEnabled = envFlagValue(env.MAB_REAL_MEET_HOST_ADMISSION);
  const enabled = explicitlyEnabled || Boolean(browserUserDataDir || inviteEmail);
  if (!enabled) {
    return { enabled: false };
  }
  const profileMode = String(env.MAB_HOST_ADMISSION_PROFILE_MODE || "persistent")
    .trim()
    .toLowerCase();
  if (profileMode !== "persistent" || !browserUserDataDir) {
    return {
      enabled: true,
      ok: false,
      blocker: "host_admission_profile_required",
      requiredFix:
        "Set MAB_HOST_ADMISSION_BROWSER_USER_DATA_DIR to a separate authenticated host Chrome profile.",
      profileMode,
      browserUserDataDirConfigured: Boolean(browserUserDataDir),
      inviteEmailConfigured: Boolean(inviteEmail),
    };
  }
  const mainProfile = normalizeProfileDir(env.MAB_BROWSER_USER_DATA_DIR);
  const speakerProfile = normalizeProfileDir(
    firstEnv(env, [
      "MAB_SYNTHETIC_SPEAKER_BROWSER_USER_DATA_DIR",
      "MAB_SYNTHETIC_SPEAKER_USER_DATA_DIR",
    ]),
  );
  const hostProfile = normalizeProfileDir(browserUserDataDir);
  const conflicts = [];
  if (mainProfile && mainProfile === hostProfile) conflicts.push("main_bot_profile");
  if (speakerProfile && speakerProfile === hostProfile) conflicts.push("synthetic_speaker_profile");
  if (conflicts.length > 0) {
    return {
      enabled: true,
      ok: false,
      blocker: "host_admission_profile_conflict",
      requiredFix:
        "Use a host admission Chrome profile that is separate from the main bot and synthetic speaker profiles.",
      conflicts,
      profileMode,
      browserUserDataDirConfigured: true,
      inviteEmailConfigured: Boolean(inviteEmail),
    };
  }
  return {
    enabled: true,
    ok: true,
    profileMode,
    browserUserDataDir,
    browserUserDataDirConfigured: true,
    browserChannel: firstEnv(env, [
      "MAB_HOST_ADMISSION_BROWSER_CHANNEL",
      "MAB_MEET_HOST_BROWSER_CHANNEL",
      "MAB_HOST_BROWSER_CHANNEL",
    ]),
    chromiumExecutablePath: firstEnv(env, [
      "MAB_HOST_ADMISSION_CHROMIUM_EXECUTABLE",
      "MAB_HOST_ADMISSION_CHROME_EXECUTABLE",
      "MAB_CHROMIUM_EXECUTABLE",
    ]),
    inviteEmail,
    inviteEmailConfigured: Boolean(inviteEmail),
    headless: envFlagValue(env.MAB_HOST_ADMISSION_HEADLESS),
    timeoutMs: envMs(env, "MAB_HOST_ADMISSION_TIMEOUT_MS", 90_000),
    pollMs: envMs(env, "MAB_HOST_ADMISSION_POLL_MS", 750),
  };
}

async function clickLabeledButton(page, predicateName) {
  return await page
    .evaluate((name) => {
      const classify = (label) => {
        const text = String(label || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return { admit: false, invite: false, people: false, ignored: true };
        const ignored =
          /ask to join|join now|return to home|cancel|dismiss|deny|reject|leave|hang up|not now/i.test(
            text,
          ) || /申请加入|立即加入|返回|取消|拒绝|离开|挂断|暂不/i.test(text);
        const admit =
          !ignored &&
          (/\badmit\b|\badmit all\b|\blet in\b|\ballow\b|\baccept\b/i.test(text) ||
            /允许|准许|接纳|接受|同意|让.*加入|准入|放行/.test(text));
        const invite =
          !ignored &&
          (/\badd people\b|\badd others\b|\binvite\b|\bsend invite\b/i.test(text) ||
            /添加.*人|邀请|添加他人|发送邀请/.test(text));
        const people =
          /\bpeople\b|\bparticipants\b|\bshow everyone\b/i.test(text.toLowerCase()) ||
          /参会者|参与者|人员|所有人|显示所有人/.test(text);
        return { admit, invite, people, ignored };
      };
      const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
      const candidates = nodes.map((node, index) => {
        const rect = node.getBoundingClientRect();
        const label =
          node.getAttribute("aria-label") || node.textContent || node.getAttribute("title") || "";
        const disabled =
          node.disabled === true ||
          node.getAttribute("aria-disabled") === "true" ||
          node.hasAttribute("disabled");
        const visible = rect.width > 0 && rect.height > 0;
        return {
          index,
          label: String(label || "")
            .replace(/\s+/g, " ")
            .trim(),
          disabled,
          visible,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          match: classify(label),
        };
      });
      const match = candidates.find((candidate) => {
        if (!candidate.visible || candidate.disabled) return false;
        return candidate.match?.[name] === true;
      });
      if (!match) return { ok: false, candidates };
      nodes[match.index].click();
      return { ok: true, clicked: match, candidates };
    }, predicateName)
    .catch((error) => ({ ok: false, error: String(error?.message || error), candidates: [] }));
}

async function tryJoinHostPage(page) {
  const joinSelectors = [
    'button:has-text("Join now")',
    'button:has-text("Ask to join")',
    'button:has-text("加入")',
    'button:has-text("立即加入")',
    '[aria-label*="Join now" i]',
    '[aria-label*="加入" i]',
  ];
  for (const selector of joinSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 800 }).catch(() => false)) {
      await locator.click().catch(() => {});
      await page.waitForTimeout(1200).catch(() => {});
      return { ok: true, selector };
    }
  }
  return { ok: false };
}

async function tryInviteEmail(page, email) {
  if (!email) return { ok: false, skipped: true, reason: "invite_email_not_configured" };
  const opened =
    (await clickLabeledButton(page, "invite")).ok || (await clickLabeledButton(page, "people")).ok;
  await page.waitForTimeout(800).catch(() => {});
  if (!opened) {
    return { ok: false, reason: "invite_entry_not_found" };
  }
  await clickLabeledButton(page, "invite");
  await page.waitForTimeout(800).catch(() => {});
  const filled = await page
    .evaluate((value) => {
      const inputs = Array.from(
        document.querySelectorAll('input,textarea,[contenteditable="true"]'),
      );
      const target = inputs.find((node) => {
        const rect = node.getBoundingClientRect();
        const label = [
          node.getAttribute("aria-label"),
          node.getAttribute("placeholder"),
          node.textContent,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          /email|name|people|person|邀请|添加|邮箱|电子邮件/i.test(label)
        );
      });
      if (!target) return { ok: false, reason: "email_input_not_found" };
      target.focus();
      if (target.isContentEditable) {
        target.textContent = value;
      } else {
        target.value = value;
      }
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }, email)
    .catch((error) => ({ ok: false, reason: "email_fill_error", error: String(error) }));
  if (!filled.ok) return filled;
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
  const sent =
    (await clickLabeledButton(page, "invite")).ok ||
    (await page
      .locator('button:has-text("Send"),button:has-text("发送"),button:has-text("Invite")')
      .first()
      .click({ timeout: 1200 })
      .then(() => true)
      .catch(() => false));
  return sent ? { ok: true, email } : { ok: false, reason: "send_invite_not_found", email };
}

export async function startHostAdmissionActor({
  meetUrl,
  sessionId = `host_admission_${Date.now()}`,
  env = process.env,
} = {}) {
  const config = hostAdmissionConfigFromEnv(env);
  if (!config.enabled) {
    return {
      enabled: false,
      summary: { enabled: false },
      stop: async () => ({ enabled: false, ok: false, reason: "host_admission_disabled" }),
    };
  }
  if (!config.ok) {
    return {
      enabled: true,
      summary: config,
      stop: async () => ({ enabled: true, ok: false, ...config }),
    };
  }

  const screenshotDir = pathJoin(
    env.MAB_HOST_ADMISSION_SCREENSHOT_DIR || env.MAB_SCREENSHOT_DIR || "/tmp",
    `${sessionId}-host-admission`,
  );
  await mkdir(screenshotDir, { recursive: true });
  const diagnostics = createDiagnostics(`${sessionId}_host_admission`, screenshotDir);
  const playwright = await loadPlaywright(env.MAB_PLAYWRIGHT_MODULE || "");
  const chromiumExecutablePath = config.chromiumExecutablePath || "";
  const browserChannel = config.browserChannel || "";
  const context = await playwright.chromium.launchPersistentContext(config.browserUserDataDir, {
    ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
    ...(!chromiumExecutablePath && browserChannel ? { channel: browserChannel } : {}),
    headless: config.headless,
    viewport: { width: 1280, height: 820 },
    permissions: ["microphone", "camera"],
    args: buildGoogleMeetChromiumArgs({
      chromiumExtraArgs: env.MAB_CHROMIUM_EXTRA_ARGS || "",
    }),
  });
  const page = await context.newPage();
  let stopped = false;
  const clicks = [];
  const probes = [];
  let inviteResult = null;
  let finalResult = null;

  diagnostics.record("host_admission_start", {
    meetUrl,
    profileMode: config.profileMode,
    browserUserDataDirConfigured: true,
    browserChannel,
    chromiumExecutablePathConfigured: Boolean(chromiumExecutablePath),
    browserChannelIgnoredByExecutablePath: Boolean(browserChannel && chromiumExecutablePath),
    inviteEmailConfigured: config.inviteEmailConfigured,
  });
  await page.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    diagnostics.record("host_admission_goto_error", { error: String(error?.message || error) });
  });
  await page.waitForTimeout(2000).catch(() => {});
  const joinClick = await tryJoinHostPage(page);
  diagnostics.record("host_admission_join_click", joinClick);
  if (config.inviteEmail) {
    inviteResult = await tryInviteEmail(page, config.inviteEmail);
    diagnostics.record("host_admission_invite", inviteResult);
  }
  await saveDiagnostics(diagnostics).catch(() => {});

  const loop = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < config.timeoutMs) {
      if (stopped) {
        break;
      }
      const admit = await clickLabeledButton(page, "admit");
      probes.push({
        at: new Date().toISOString(),
        ok: admit.ok === true,
        clicked: admit.clicked || null,
        candidateCount: Array.isArray(admit.candidates) ? admit.candidates.length : 0,
        candidateLabels: Array.isArray(admit.candidates)
          ? admit.candidates
              .filter((candidate) => candidate.visible)
              .map((candidate) => candidate.label)
              .filter(Boolean)
              .slice(0, 16)
          : [],
      });
      diagnostics.record("host_admission_probe", probes[probes.length - 1]);
      if (admit.ok) {
        clicks.push(admit.clicked);
        await page.waitForTimeout(1200).catch(() => {});
      } else if (probes.length % 4 === 0) {
        const people = await clickLabeledButton(page, "people");
        diagnostics.record("host_admission_people_panel_probe", {
          ok: people.ok === true,
          clicked: people.clicked || null,
        });
        await page.waitForTimeout(700).catch(() => {});
      }
      await saveDiagnostics(diagnostics).catch(() => {});
      await page.waitForTimeout(config.pollMs).catch(() => {});
    }
    finalResult = {
      enabled: true,
      ok: clicks.length > 0 || inviteResult?.ok === true,
      status: stopped ? "stopped" : "timeout",
      admittedClickCount: clicks.length,
      inviteResult,
      probeCount: probes.length,
      diagnosticsPath: diagnostics.jsonPath,
      screenshotDir,
    };
    diagnostics.record("host_admission_done", finalResult);
    await saveDiagnostics(diagnostics).catch(() => {});
    return finalResult;
  })();

  return {
    enabled: true,
    summary: {
      enabled: true,
      profileMode: config.profileMode,
      browserUserDataDirConfigured: true,
      inviteEmailConfigured: config.inviteEmailConfigured,
      timeoutMs: config.timeoutMs,
      diagnosticsPath: diagnostics.jsonPath,
    },
    stop: async (reason = "host_admission_stop") => {
      stopped = true;
      const result =
        finalResult ||
        (await Promise.race([
          loop,
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  enabled: true,
                  ok: clicks.length > 0 || inviteResult?.ok === true,
                  status: "stopped",
                  reason,
                  admittedClickCount: clicks.length,
                  inviteResult,
                  probeCount: probes.length,
                  diagnosticsPath: diagnostics.jsonPath,
                  screenshotDir,
                }),
              1500,
            ),
          ),
        ]));
      await context.close().catch(() => {});
      if (envFlagValue(env.MAB_CLEAN_HOST_ADMISSION_TMP)) {
        await rm(screenshotDir, { recursive: true, force: true }).catch(() => {});
      }
      return result;
    },
  };
}
