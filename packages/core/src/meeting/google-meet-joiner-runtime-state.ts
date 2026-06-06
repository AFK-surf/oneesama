/* eslint-disable max-lines */
import { dismissMeetPrompts } from "./meet-prompts.ts";
import {
  normalizeSpeakerDisplayName,
  resolveSpeakerIdentity,
  type SpeakerIdentityResolution,
} from "../realtime/speaker-identity.ts";
import type { RealtimeCurrentUser } from "../realtime/realtime-contract.ts";
import { evaluateMeetAccessibilityState, withTimeout } from "./google-meet-joiner-ui.ts";
import { createMeetUIInteraction, type MeetUIInteraction } from "./google-meet-humanized-input.ts";
import {
  nowIso,
  type Diagnostics,
  type GuestNameEvalResult,
  type MeetJoinButtonEvalResult,
  type MeetPageState,
  type MeetParticipantSignal,
  type MeetSpeakerSignal,
  type MeetingAwarenessState,
  type Page,
  type PresentationButton,
} from "./google-meet-joiner-base.ts";
import { compactCaptionState } from "./google-meet-joiner-status-compaction.ts";
export {
  compactCaptionState,
  compactJoinStatusActive,
  compactJoinStatusRealtimeBridge,
  compactJoinStatusWorkerResultBridge,
} from "./google-meet-joiner-status-compaction.ts";

const GUEST_NAME_FIELD_SELECTOR = [
  'input[aria-label*="name" i]',
  'input[placeholder*="name" i]',
  'input[type="text"]',
  "textarea",
  '[contenteditable="true"]',
].join(",");

type GuestNameReadiness = GuestNameEvalResult & { fieldIndex?: number };

type JoinClickOutcome = {
  state:
    | "admitted"
    | "waiting_for_admit"
    | "sign_in_required"
    | "cannot_join_meeting"
    | "timeout"
    | "unknown";
  signal?: string;
  textHead?: string;
  pageState?: MeetPageState;
  error?: string;
};

async function evaluateGuestNameReadiness(page: Page): Promise<GuestNameReadiness> {
  return await withTimeout<GuestNameReadiness, GuestNameReadiness>(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const href = String(location.href || "");
      const productRedirect =
        !/meet\.google\.com/i.test(href) &&
        ((/workspace\.google\.com/i.test(href) && /\/products\/meet/i.test(href)) ||
          /google\.com\/meet/i.test(href));
      if (productRedirect) {
        return {
          ok: false,
          reason: "meet_product_redirect",
          currentUrl: href,
          textHead: text.slice(0, 500),
        };
      }
      if (
        /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
          text,
        )
      ) {
        return {
          ok: false,
          reason: "cannot_join_meeting",
          textHead: text.slice(0, 500),
        };
      }
      const hasGuestJoinForm = /What'?s your name\?|Ask to join|Join now/i.test(text);
      const hasAntiBotInterlock =
        /Getting ready\.\.\./i.test(text) ||
        (/confirm you'?re not a bot/i.test(text) && !hasGuestJoinForm);
      if (hasAntiBotInterlock) {
        return {
          ok: false,
          reason: "meet_anti_bot_prejoin",
          textHead: text.slice(0, 500),
        };
      }
      if (
        /Forgot email|Create account|Use your Google Account/i.test(text) &&
        /accounts\.google\.com/i.test(location.href)
      ) {
        return {
          ok: false,
          reason: "google_sign_in_required",
          textHead: text.slice(0, 500),
        };
      }
      const isVisible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const getValueLength = (node: HTMLElement) =>
        "value" in node && typeof node.value === "string"
          ? node.value.length
          : (node.textContent || "").length;
      const fields = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            'input[aria-label*="name" i]',
            'input[placeholder*="name" i]',
            'input[type="text"]',
            "textarea",
            '[contenteditable="true"]',
          ].join(","),
        ),
      );
      const visibleFields = fields.filter(isVisible);
      const field =
        visibleFields.find((node) => {
          const label =
            `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.toLowerCase();
          return label.includes("name") || label.includes("your name") || fields.length === 1;
        }) || visibleFields[0];
      const fieldIndex = fields.indexOf(field);
      if (!field) {
        const joinButton = Array.from(
          document.querySelectorAll<HTMLElement>("button, [role=button]"),
        )
          .map((node) => ({
            node,
            label:
              `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                .replace(/\s+/g, " ")
                .trim(),
          }))
          .find(
            ({ node, label }) =>
              isVisible(node) &&
              /join now|ask to join|join the call now|join anyway|加入|申请加入/i.test(label) &&
              !node.hasAttribute("disabled") &&
              node.getAttribute("aria-disabled") !== "true",
          );
        if (joinButton) {
          return {
            ok: false,
            reason: "join_button_ready_without_guest_name",
            joinButtonReady: true,
            joinButtonLabel: joinButton.label,
            textHead: (document.body?.innerText || "").slice(0, 500),
          };
        }
        return {
          ok: false,
          reason: "guest_name_field_absent",
          textHead: (document.body?.innerText || "").slice(0, 500),
        };
      }
      return {
        ok: true,
        tag: field.tagName.toLowerCase(),
        aria: field.getAttribute("aria-label") || "",
        placeholder: field.getAttribute("placeholder") || "",
        valueLength: getValueLength(field),
        fieldIndex,
      };
    }),
    2500,
    {
      ok: false,
      reason: "guest_name_eval_timeout",
    },
  ).catch(
    (error): GuestNameReadiness => ({
      ok: false,
      reason: "guest_name_eval_error",
      error: String(error?.message || error).slice(0, 300),
    }),
  );
}

async function waitForGuestNameReadiness(
  page: Page,
  timeoutMs: number,
): Promise<GuestNameReadiness> {
  if (typeof page.waitForFunction !== "function") {
    return await evaluateGuestNameReadiness(page);
  }
  try {
    const handle = await page.waitForFunction(
      () => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const href = String(location.href || "");
        const productRedirect =
          !/meet\.google\.com/i.test(href) &&
          ((/workspace\.google\.com/i.test(href) && /\/products\/meet/i.test(href)) ||
            /google\.com\/meet/i.test(href));
        if (productRedirect) {
          return {
            ok: false,
            reason: "meet_product_redirect",
            currentUrl: href,
            textHead: text.slice(0, 500),
          };
        }
        if (
          /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
            text,
          )
        ) {
          return {
            ok: false,
            reason: "cannot_join_meeting",
            textHead: text.slice(0, 500),
          };
        }
        if (
          /Forgot email|Create account|Use your Google Account/i.test(text) &&
          /accounts\.google\.com/i.test(location.href)
        ) {
          return {
            ok: false,
            reason: "google_sign_in_required",
            textHead: text.slice(0, 500),
          };
        }
        const isVisible = (node: HTMLElement) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        };
        const getValueLength = (node: HTMLElement) =>
          "value" in node && typeof node.value === "string"
            ? node.value.length
            : (node.textContent || "").length;
        const fields = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              'input[aria-label*="name" i]',
              'input[placeholder*="name" i]',
              'input[type="text"]',
              "textarea",
              '[contenteditable="true"]',
            ].join(","),
          ),
        );
        const visibleFields = fields.filter(isVisible);
        const field =
          visibleFields.find((node) => {
            const label =
              `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.toLowerCase();
            return label.includes("name") || label.includes("your name") || fields.length === 1;
          }) || visibleFields[0];
        if (!field) {
          const joinButton = Array.from(
            document.querySelectorAll<HTMLElement>("button, [role=button]"),
          )
            .map((node) => ({
              node,
              label:
                `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                  .replace(/\s+/g, " ")
                  .trim(),
            }))
            .find(
              ({ node, label }) =>
                isVisible(node) &&
                /join now|ask to join|join the call now|join anyway|加入|申请加入/i.test(label) &&
                !node.hasAttribute("disabled") &&
                node.getAttribute("aria-disabled") !== "true",
            );
          return joinButton
            ? {
                ok: false,
                reason: "join_button_ready_without_guest_name",
                joinButtonReady: true,
                joinButtonLabel: joinButton.label,
                textHead: (document.body?.innerText || "").slice(0, 500),
              }
            : false;
        }
        return {
          ok: true,
          tag: field.tagName.toLowerCase(),
          aria: field.getAttribute("aria-label") || "",
          placeholder: field.getAttribute("placeholder") || "",
          valueLength: getValueLength(field),
          fieldIndex: fields.indexOf(field),
        };
      },
      undefined,
      { polling: 100, timeout: Math.max(1, timeoutMs) },
    );
    return (await handle.jsonValue()) as GuestNameReadiness;
  } catch {
    return await evaluateGuestNameReadiness(page);
  }
}

export async function fillGuestName(
  page: Page,
  botName: string,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 35_000,
  meetUIInteractionEnv: NodeJS.ProcessEnv = process.env,
) {
  const interaction = createMeetUIInteraction(diagnostics, meetUIInteractionEnv);
  const deadline = Date.now() + timeoutMs;
  let lastResult: GuestNameEvalResult | null = null;
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await waitForGuestNameReadiness(page, Math.max(1, deadline - Date.now()));
    lastResult = result;
    if (["cannot_join_meeting", "google_sign_in_required"].includes(result.reason)) {
      diagnostics?.record("guest_name_terminal_state", result);
      return result;
    }
    if (result.reason === "join_button_ready_without_guest_name") {
      diagnostics?.record("guest_name_skipped_join_button_ready", result);
      return result;
    }
    if (result.ok) {
      const fieldIndex = Number(
        (result as GuestNameEvalResult & { fieldIndex?: number }).fieldIndex || 0,
      );
      try {
        const locator = page.locator(GUEST_NAME_FIELD_SELECTOR).nth(fieldIndex);
        let fillError = "";
        const fillMode = interaction.details.mode === "humanized" ? "humanized" : "playwright";
        let verify;
        const fillStartedAt = Date.now();
        if (interaction.details.mode === "humanized") {
          await interaction.fill(locator, botName).catch((error) => {
            fillError = String(error?.message || error).slice(0, 200);
          });
          verify = await waitForGuestNameValue(page, fieldIndex, botName, 2500);
          if (!verify.ok && verify.joinButtonReady === true) {
            const filled = {
              ...result,
              valueLength: verify.valueLength || result.valueLength,
              interaction: interaction.details,
              fillMode,
              fillError,
              fillElapsedMs: Date.now() - fillStartedAt,
            };
            diagnostics?.record("guest_name_filled", { botName, ...filled, verify });
            diagnostics?.record("guest_name_assume_filled", {
              botName,
              ...filled,
              verify,
              reason: "humanized_fill_completed_join_button_gate_will_verify",
            });
            return {
              ...filled,
              assumed: true,
              verify,
              reason: "humanized_fill_completed_join_button_gate_will_verify",
            };
          }
        } else {
          await locator.fill(botName).catch((error) => {
            fillError = String(error?.message || error).slice(0, 200);
          });
          verify = await waitForGuestNameValue(page, fieldIndex, botName, 2500);
        }
        const filled = {
          ...result,
          valueLength: verify.valueLength || result.valueLength,
          interaction: interaction.details,
          fillMode,
          fillError,
          fillElapsedMs: Date.now() - fillStartedAt,
        };
        diagnostics?.record("guest_name_filled", { botName, ...filled, verify });
        if (verify.ok) return filled;
        const canAssumeHumanizedFill =
          interaction.details.mode === "humanized" &&
          verify.joinButtonReady === true &&
          Number(verify.valueLength || 0) > 0;
        if (canAssumeHumanizedFill) {
          diagnostics?.record("guest_name_assume_filled", {
            botName,
            ...filled,
            verify,
            reason: "humanized_fill_completed_join_button_gate_will_verify",
          });
          return {
            ...filled,
            assumed: true,
            verify,
            reason: "humanized_fill_completed_join_button_gate_will_verify",
          };
        }
        lastResult = {
          ok: false,
          reason: verify.reason || "guest_name_value_mismatch",
          error: verify.error,
        };
        diagnostics?.record("guest_name_wait", { ...lastResult, verify });
      } catch (error) {
        lastResult = {
          ok: false,
          reason: "guest_name_humanized_fill_error",
          error: String(error?.message || error).slice(0, 300),
        };
        diagnostics?.record("guest_name_wait", { ...lastResult, interaction: interaction.details });
      }
    } else {
      lastResult = result;
      diagnostics?.record("guest_name_wait", result);
    }
  }
  diagnostics?.record("guest_name_absent", lastResult || { reason: "timeout" });
  return { ok: false, ...(lastResult || { reason: "timeout" }) };
}

export function normalizeGuestNameValueForCompare(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function guestNameValuesMatch(actual: unknown, expected: unknown): boolean {
  return normalizeGuestNameValueForCompare(actual) === normalizeGuestNameValueForCompare(expected);
}

export function guestNameVerificationLooksAccepted(
  verify: { value?: unknown; valueLength?: unknown; joinButtonReady?: unknown },
  expected: unknown,
): boolean {
  if (guestNameValuesMatch(verify.value, expected)) {
    return true;
  }
  const expectedLength = normalizeGuestNameValueForCompare(expected).length;
  const actualLength = Number(verify.valueLength || 0);
  return Boolean(verify.joinButtonReady) && expectedLength > 0 && actualLength === expectedLength;
}

async function readGuestNameValueState(page: Page, fieldIndex: number) {
  return await withTimeout(
    page.evaluate(
      ({ fieldIndex: index }) => {
        const fields = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              'input[aria-label*="name" i]',
              'input[placeholder*="name" i]',
              'input[type="text"]',
              "textarea",
              '[contenteditable="true"]',
            ].join(","),
          ),
        );
        const field = fields[index] || fields[0];
        if (!field) return { ok: false, reason: "guest_name_field_absent" };
        const value =
          "value" in field && typeof field.value === "string"
            ? field.value
            : field.textContent || "";
        const buttonVisible = (node: HTMLElement) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        };
        const joinButton = Array.from(
          document.querySelectorAll<HTMLElement>("button, [role=button]"),
        )
          .map((node) => ({
            node,
            label:
              `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                .replace(/\s+/g, " ")
                .trim(),
          }))
          .find(
            ({ node, label }) =>
              buttonVisible(node) &&
              /join now|ask to join|join the call now|join anyway|加入|申请加入/i.test(label),
          );
        const joinButtonReady = Boolean(
          joinButton &&
          !joinButton.node.hasAttribute("disabled") &&
          joinButton.node.getAttribute("aria-disabled") !== "true",
        );
        return {
          ok: true,
          value,
          valueLength: value.length,
          joinButtonReady,
          joinButtonLabel: joinButton?.label || "",
        };
      },
      { fieldIndex },
    ),
    800,
    { ok: false, reason: "guest_name_verify_timeout" },
  ).catch((error) => ({
    ok: false,
    reason: "guest_name_verify_error",
    error: String(error?.message || error).slice(0, 200),
  }));
}

async function waitForGuestNameValue(
  page: Page,
  fieldIndex: number,
  expected: string,
  timeoutMs: number,
) {
  let last = null;
  if (typeof page.waitForFunction === "function") {
    try {
      const accepted = await page.waitForFunction(
        ({ fieldIndex: index, expectedValue }) => {
          const normalize = (value: unknown) =>
            String(value || "")
              .normalize("NFKC")
              .replace(/[\u00a0\u2007\u202f]/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          const fields = Array.from(
            document.querySelectorAll<HTMLElement>(
              [
                'input[aria-label*="name" i]',
                'input[placeholder*="name" i]',
                'input[type="text"]',
                "textarea",
                '[contenteditable="true"]',
              ].join(","),
            ),
          );
          const field = fields[index] || fields[0];
          if (!field) return false;
          const value =
            "value" in field && typeof field.value === "string"
              ? field.value
              : field.textContent || "";
          const buttonVisible = (node: HTMLElement) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const joinButton = Array.from(
            document.querySelectorAll<HTMLElement>("button, [role=button]"),
          )
            .map((node) => ({
              node,
              label:
                `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                  .replace(/\s+/g, " ")
                  .trim(),
            }))
            .find(
              ({ node, label }) =>
                buttonVisible(node) &&
                /join now|ask to join|join the call now|join anyway|加入|申请加入/i.test(label),
            );
          const joinButtonReady = Boolean(
            joinButton &&
            !joinButton.node.hasAttribute("disabled") &&
            joinButton.node.getAttribute("aria-disabled") !== "true",
          );
          const normalizedValue = normalize(value);
          const normalizedExpected = normalize(expectedValue);
          const valueAccepted =
            normalizedValue === normalizedExpected ||
            (joinButtonReady &&
              normalizedExpected.length > 0 &&
              normalizedValue.length === normalizedExpected.length);
          return valueAccepted
            ? {
                ok: true,
                value,
                valueLength: value.length,
                joinButtonReady,
                joinButtonLabel: joinButton?.label || "",
              }
            : false;
        },
        { fieldIndex, expectedValue: expected },
        { polling: 100, timeout: Math.max(1, timeoutMs) },
      );
      last = await accepted.jsonValue();
    } catch {
      last = await readGuestNameValueState(page, fieldIndex);
    }
  } else {
    last = await readGuestNameValueState(page, fieldIndex);
  }
  if (last?.ok && guestNameVerificationLooksAccepted(last, expected)) {
    return { ...last, value: undefined };
  }
  return {
    ...(last || { ok: false }),
    ok: false,
    reason: "guest_name_value_mismatch",
    value: undefined,
  };
}

async function waitForMeetJoinButtonCandidate(
  page: Page,
  timeoutMs: number,
): Promise<MeetJoinButtonEvalResult> {
  if (typeof page.waitForFunction === "function") {
    try {
      const handle = await page.waitForFunction(
        () => {
          const isVisible = (node: HTMLElement) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const buttons = Array.from(
            document.querySelectorAll<HTMLElement>("button, [role=button]"),
          );
          const candidates = buttons
            .map((node, index) => {
              const label =
                `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                  .replace(/\s+/g, " ")
                  .trim();
              const rect = node.getBoundingClientRect();
              return {
                index,
                label: label.slice(0, 160),
                disabled: Boolean(
                  ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
                  node.getAttribute("aria-disabled") === "true",
                ),
                visible: isVisible(node),
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              };
            })
            .filter(
              (button) =>
                button.visible &&
                /\b(ask to join|join now|join)\b|申请加入|立即加入|加入/i.test(button.label),
            );
          const enabled = candidates.find((button) => !button.disabled);
          return enabled
            ? { selector: "dom:meet-join-button", button: enabled, candidates }
            : false;
        },
        undefined,
        { polling: 100, timeout: Math.max(1, timeoutMs) },
      );
      const result = (await handle.jsonValue()) as {
        selector: string;
        button: PresentationButton;
        candidates: PresentationButton[];
      };
      return { ok: true, ...result };
    } catch {
      // Fall through to one final synchronous snapshot so diagnostics include candidates.
    }
  }
  return await withTimeout<MeetJoinButtonEvalResult, MeetJoinButtonEvalResult>(
    page.evaluate(() => {
      const isVisible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const candidates = buttons
        .map((node, index) => {
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          const rect = node.getBoundingClientRect();
          return {
            index,
            label: label.slice(0, 160),
            disabled: Boolean(
              ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
              node.getAttribute("aria-disabled") === "true",
            ),
            visible: isVisible(node),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter(
          (button) =>
            button.visible &&
            /\b(ask to join|join now|join)\b|申请加入|立即加入|加入/i.test(button.label),
        );
      const enabled = candidates.find((button) => !button.disabled);
      if (!enabled) return { ok: false, candidates };
      return { ok: true, selector: "dom:meet-join-button", button: enabled, candidates };
    }),
    2500,
    {
      ok: false,
      error: "join_button_eval_timeout",
      candidates: [],
    },
  ).catch(
    (error): MeetJoinButtonEvalResult => ({
      ok: false,
      error: String(error?.message || error).slice(0, 300),
      candidates: [],
    }),
  );
}

async function waitForJoinClickOutcome(page: Page, timeoutMs: number): Promise<JoinClickOutcome> {
  const fixtureAdmissionOutcome = async (
    pageState?: MeetPageState,
  ): Promise<JoinClickOutcome | null> => {
    const fixtureState = await evaluateFixtureState(page);
    if (fixtureState?.joined !== true) return null;
    return {
      state: "admitted",
      signal: "fixture_joined",
      pageState: pageState ?? (await evaluateMeetPageState(page)),
    };
  };
  const initialFixtureOutcome = await fixtureAdmissionOutcome();
  if (initialFixtureOutcome) return initialFixtureOutcome;

  if (typeof page.waitForFunction !== "function") {
    const pageState = await evaluateMeetPageState(page);
    const fixtureOutcome = await fixtureAdmissionOutcome(pageState);
    if (fixtureOutcome) return fixtureOutcome;
    if (pageState.waitingForAdmit) return { state: "waiting_for_admit", pageState };
    if (pageState.inMeeting && !pageState.preJoin) return { state: "admitted", pageState };
    if (pageState.signIn) return { state: "sign_in_required", pageState };
    if (pageState.cannotJoin) return { state: "cannot_join_meeting", pageState };
    return { state: "unknown", pageState };
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const handle = await page.waitForFunction(
        () => {
          const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
          const href = String(location.href || "");
          if (
            /accounts\.google\.com/i.test(href) ||
            /Forgot email|Use your Google Account/i.test(text)
          ) {
            return { state: "sign_in_required", signal: "text", textHead: text.slice(0, 240) };
          }
          if (
            /You can't join this video call|No one can join a meeting unless invited or admitted by the host|Returning to home screen/i.test(
              text,
            )
          ) {
            return { state: "cannot_join_meeting", signal: "text", textHead: text.slice(0, 240) };
          }
          const visibleButton = (pattern: RegExp) =>
            Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]")).some(
              (node) => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                if (
                  rect.width <= 0 ||
                  rect.height <= 0 ||
                  style.visibility === "hidden" ||
                  style.display === "none"
                ) {
                  return false;
                }
                const label =
                  `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                    .replace(/\s+/g, " ")
                    .trim();
                return pattern.test(label);
              },
            );
          const preJoin =
            /What'?s your name\?/i.test(text) ||
            visibleButton(/\b(ask to join|join now)\b|申请加入|立即加入/i);
          const waitingForAdmit =
            /please wait until a meeting host brings you into the call|someone will let you in soon|asking to join|you'?ll join|waiting for.*(?:admit|host)|host.*(?:let|admit).*you|正在请求加入|等待.*(?:主持人|允许)/i.test(
              text,
            );
          if (waitingForAdmit) {
            return {
              state: "waiting_for_admit",
              signal: "waiting_text",
              textHead: text.slice(0, 240),
            };
          }
          const captionVisible = visibleButton(/captions?|字幕/i);
          if (captionVisible && !preJoin) return { state: "admitted", signal: "captions" };
          const leaveVisible = visibleButton(/leave (?:call|meeting)|离开通话/i);
          if (leaveVisible && !preJoin) {
            return { state: "admitted", signal: "leave_control" };
          }
          return false;
        },
        undefined,
        { polling: 100, timeout: Math.min(1500, Math.max(1, deadline - Date.now())) },
      );
      const outcome = (await handle.jsonValue()) as JoinClickOutcome;
      const pageState = await evaluateMeetPageState(page);
      const fixtureOutcome = await fixtureAdmissionOutcome(pageState);
      if (fixtureOutcome) return fixtureOutcome;
      if (pageState.waitingForAdmit) {
        return { state: "waiting_for_admit", signal: "page_state_waiting", pageState };
      }
      return { ...outcome, pageState };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 200);
    }
    const pageState = await evaluateMeetPageState(page);
    const fixtureOutcome = await fixtureAdmissionOutcome(pageState);
    if (fixtureOutcome) return fixtureOutcome;
    if (pageState.waitingForAdmit) return { state: "waiting_for_admit", pageState };
    if (pageState.inMeeting && !pageState.preJoin) return { state: "admitted", pageState };
    if (pageState.error === "meet_page_state_timeout") {
      return {
        state: "unknown",
        signal: "meet_spa_blocks_runtime_evaluation_after_join_click",
        pageState,
      };
    }
    if (pageState.signIn) return { state: "sign_in_required", pageState };
    if (pageState.cannotJoin) return { state: "cannot_join_meeting", pageState };
  }
  const pageState = await evaluateMeetPageState(page);
  return {
    state: "timeout",
    pageState,
    error: lastError,
  };
}

async function clickMeetJoinButtonWithPlaywright(page: Page, button?: PresentationButton) {
  try {
    const rect = button?.rect;
    if (
      rect &&
      Number.isFinite(rect.x) &&
      Number.isFinite(rect.y) &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      await page.mouse.click(x, y);
      return { ok: true, backend: "playwright_mouse", x, y };
    }
    if (typeof button?.index === "number") {
      await page.locator("button, [role=button]").nth(button.index).click({ timeout: 1500 });
      return { ok: true, backend: "playwright_locator", index: button.index };
    }
    return { ok: false, backend: "playwright", error: "join_button_target_missing" };
  } catch (error) {
    return {
      ok: false,
      backend: "playwright",
      error: String(error?.message || error).slice(0, 180),
    };
  }
}

async function clickMeetJoinButtonWithPlaywrightAndObserve(
  page: Page,
  diagnostics: Diagnostics | null,
  button: PresentationButton,
  deadline: number,
  fallback = false,
): Promise<JoinClickOutcome> {
  const syntheticClick = await clickMeetJoinButtonWithPlaywright(page, button);
  diagnostics?.record("click_attempt", {
    selector: "playwright:meet-join-button",
    ok: syntheticClick.ok === true,
    fallback,
    result: syntheticClick,
  });
  return await waitForJoinClickOutcome(
    page,
    Math.min(syntheticClick.ok ? 3500 : 500, deadline - Date.now()),
  );
}

async function clickMeetJoinButtonWithHumanizedInputAndObserve(
  page: Page,
  diagnostics: Diagnostics | null,
  button: PresentationButton,
  interaction: MeetUIInteraction,
  deadline: number,
): Promise<JoinClickOutcome> {
  if (typeof button.index !== "number") {
    diagnostics?.record("click_miss", {
      selector: `${interaction.details.backend}:meet-join-button`,
      error: "join_button_index_missing",
    });
    return await waitForJoinClickOutcome(page, Math.min(500, deadline - Date.now()));
  }

  try {
    const startedAt = Date.now();
    await interaction.click(page.locator("button, [role=button]").nth(button.index));
    diagnostics?.record("click_attempt", {
      selector: `${interaction.details.backend}:meet-join-button`,
      ok: true,
      fallback: false,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    diagnostics?.record("click_miss", {
      selector: `${interaction.details.backend}:meet-join-button`,
      error: String(error?.message || error).slice(0, 180),
    });
  }
  return await waitForJoinClickOutcome(page, Math.min(5000, deadline - Date.now()));
}

export async function clickMeetJoinButton(
  page: Page,
  diagnostics: Diagnostics | null = null,
  timeoutMs = 45_000,
  meetUIInteractionEnv: NodeJS.ProcessEnv = process.env,
  meetUIInteraction?: MeetUIInteraction,
) {
  const interaction =
    meetUIInteraction ?? createMeetUIInteraction(diagnostics, meetUIInteractionEnv);
  const deadline = Date.now() + timeoutMs;
  let lastCandidates: PresentationButton[] = [];
  let clickedSelector = "";
  while (Date.now() < deadline) {
    await dismissMeetPrompts(page, diagnostics);
    const result = await waitForMeetJoinButtonCandidate(
      page,
      Math.min(5000, deadline - Date.now()),
    );
    lastCandidates = result.candidates || [];
    if (result.ok) {
      clickedSelector = result.selector;
      diagnostics?.record("click", {
        selector: result.selector,
        button: result.button,
        interaction: interaction.details,
      });
      let outcome: JoinClickOutcome;
      const humanizedClick = interaction.details.mode === "humanized";
      if (humanizedClick) {
        outcome = await clickMeetJoinButtonWithHumanizedInputAndObserve(
          page,
          diagnostics,
          result.button,
          interaction,
          deadline,
        );
      } else {
        outcome = await clickMeetJoinButtonWithPlaywrightAndObserve(
          page,
          diagnostics,
          result.button,
          deadline,
        );
      }
      diagnostics?.record("join_after_click_state", { outcome, pageState: outcome.pageState });
      if (outcome.state === "waiting_for_admit") return result.selector;
      if (outcome.state === "admitted") return result.selector;
      if (outcome.signal === "meet_spa_blocks_runtime_evaluation_after_join_click") {
        diagnostics?.record("join_state_probe_timeout_assume_clicked", {
          selector: result.selector,
          reason: "meet_spa_blocks_runtime_evaluation_after_join_click",
        });
        return result.selector;
      }
      if (outcome.state === "sign_in_required") {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState: outcome.pageState,
        });
        return "";
      }
      if (outcome.state === "cannot_join_meeting") {
        diagnostics?.record("join_terminal_state", {
          reason: "cannot_join_meeting",
          pageState: outcome.pageState,
        });
        return "terminal:cannot_join_meeting";
      }
      continue;
    }
    if (clickedSelector) {
      const pageState = await evaluateMeetPageState(page);
      if (pageState.waitingForAdmit) return clickedSelector;
      if (pageState.inMeeting && !pageState.preJoin) return clickedSelector;
      if (pageState.signIn) {
        diagnostics?.record("join_terminal_state", {
          reason: "google_sign_in_required",
          pageState,
        });
        return "";
      }
      if (pageState.cannotJoin) {
        diagnostics?.record("join_terminal_state", {
          reason: "cannot_join_meeting",
          pageState,
        });
        return "terminal:cannot_join_meeting";
      }
    }
    diagnostics?.record("join_wait", {
      error: "error" in result ? result.error || "" : "",
      candidates: lastCandidates.slice(0, 8),
    });
    const pageState = await evaluateMeetPageState(page);
    diagnostics?.record("join_wait_state", {
      inMeeting: pageState?.inMeeting === true,
      waitingForAdmit: pageState?.waitingForAdmit === true,
      preJoin: pageState?.preJoin === true,
      signIn: pageState?.signIn === true,
      cannotJoin: pageState?.cannotJoin === true,
      textHead: String(pageState?.textHead || "").slice(0, 240),
    });
    if (pageState?.cannotJoin === true) {
      diagnostics?.record("join_terminal_state", {
        reason: "cannot_join_meeting",
        pageState,
      });
      return "terminal:cannot_join_meeting";
    }
  }
  diagnostics?.record("join_wait_timeout", { candidates: lastCandidates.slice(0, 8) });
  return "";
}

export async function evaluateAvatarReady(page) {
  return await evaluateWindowState(page, "MAB_AVATAR_READY");
}

export async function startAvatarRenderer(page, diagnostics: Diagnostics | null = null) {
  const result = await withTimeout(
    page.evaluate(async () => {
      if (!window.MAB_AVATAR_START_RENDERER) {
        return { ok: false, error: "avatar_renderer_start_missing" };
      }
      const ready = await window.MAB_AVATAR_START_RENDERER();
      return { ok: true, ready: ready || window.MAB_AVATAR_READY || null };
    }),
    25_000,
    { ok: false, error: "avatar_renderer_start_timeout" },
  ).catch((error) => ({
    ok: false,
    error: String(error?.message || error).slice(0, 300),
  }));
  diagnostics?.record("avatar_renderer_start", result);
  return result;
}

export async function evaluateAvatarAudio(page) {
  return await evaluateWindowState(page, "MAB_AVATAR_AUDIO");
}

export async function evaluateFixtureState(page) {
  return await evaluateWindowState(page, "__MAB_MEET_FIXTURE");
}

export async function evaluateRealtimeBridgeState(page) {
  return await evaluateWindowState(page, "MAB_REALTIME_BRIDGE");
}

export async function evaluateWorkerResultBridgeState(page) {
  return await evaluateWindowState(page, "MAB_WORKER_RESULT_BRIDGE");
}

export async function evaluateWindowState(page, key: string) {
  if (!page) return null;
  return await withTimeout(
    page.evaluate((name) => window[name] || null, key),
    2500,
    null,
  ).catch(() => null);
}

export async function evaluateLocalDialogState(page) {
  return await withTimeout(
    page.evaluate(() => {
      if (window.MAB_LOCAL_DIALOG) return window.MAB_LOCAL_DIALOG;
      const config = window.MAB_LOCAL_DIALOG_CONFIG || null;
      const controller = window.MAB_LOCAL_DIALOG_CONTROLLER || null;
      if (!config && !controller) return null;
      return {
        ok: false,
        bootstrapOnly: true,
        enabled: Boolean(config?.enabled),
        provider: "",
        utterancesReceived: 0,
        responsesSpoken: 0,
        controllerReady: typeof controller?.sendUtterance === "function",
        config,
        errors: [{ message: "local_dialog_state_missing" }],
      };
    }),
    2500,
    null,
  ).catch(() => null);
}

export async function evaluateScreenShareState(page) {
  return await evaluateWindowState(page, "MAB_SCREEN_SHARE");
}

export function captionEventTimeMs(event: any): number {
  const parsed = Date.parse(String(event?.ts || event?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function captionSpeakerSignal(event: any): MeetSpeakerSignal | null {
  const name = normalizeSpeakerDisplayName(event?.speaker);
  if (!name) return null;
  return {
    name,
    source: event?.source || "google-meet-caption-dom",
    confidence: "high",
    observedAt: String(event?.ts || event?.timestamp || nowIso()),
  };
}

export function buildMeetingAwarenessState({
  meetPage,
  captions,
  currentUser,
  nowMs = Date.now(),
  recentWindowMs = 30_000,
}: {
  meetPage?: MeetPageState | null;
  captions?: any;
  currentUser?: RealtimeCurrentUser | null;
  nowMs?: number;
  recentWindowMs?: number;
} = {}): MeetingAwarenessState {
  const participantMap = new Map<string, MeetParticipantSignal>();
  const addParticipant = (candidate: Partial<MeetParticipantSignal> | null | undefined) => {
    const name = normalizeSpeakerDisplayName(candidate?.name);
    if (!name) return;
    const key = name.toLowerCase();
    const existing = participantMap.get(key);
    const next: MeetParticipantSignal = {
      name,
      source: candidate?.source || "unknown",
      confidence: candidate?.confidence || "low",
      participantId: candidate?.participantId || existing?.participantId || "",
      rawLabel: candidate?.rawLabel || existing?.rawLabel || "",
      lastSeenAt: candidate?.lastSeenAt || existing?.lastSeenAt || nowIso(),
      identity: resolveSpeakerIdentity(name, currentUser) || existing?.identity || null,
    };
    const rank = { low: 1, medium: 2, high: 3 };
    if (!existing || rank[next.confidence] >= rank[existing.confidence]) {
      participantMap.set(key, next);
    }
  };

  for (const participant of meetPage?.participants || []) addParticipant(participant);

  const captionEvents = [
    ...(Array.isArray(captions?.tail) ? captions.tail : []),
    ...(Array.isArray(captions?.captions) ? captions.captions.slice(-12) : []),
    captions?.latest,
  ].filter(Boolean);
  const recentSpeakers: MeetSpeakerSignal[] = [];
  const seenRecent = new Set<string>();
  for (const event of captionEvents) {
    const signal = captionSpeakerSignal(event);
    if (!signal) continue;
    addParticipant({
      name: signal.name,
      source: "caption_speaker",
      confidence: "medium",
      lastSeenAt: signal.observedAt,
    });
    const key = signal.name.toLowerCase();
    if (!seenRecent.has(key)) {
      seenRecent.add(key);
      recentSpeakers.push(signal);
    }
  }

  const latestCaption = captionSpeakerSignal(captions?.latest);
  const latestCaptionAge = latestCaption
    ? nowMs - captionEventTimeMs(captions?.latest)
    : Number.POSITIVE_INFINITY;
  const captionIsFresh =
    latestCaption && (!Number.isFinite(latestCaptionAge) || latestCaptionAge <= recentWindowMs);
  const domSpeaker = meetPage?.activeSpeaker || null;
  const activeSpeaker = captionIsFresh ? latestCaption : domSpeaker || latestCaption || null;
  if (activeSpeaker?.name) {
    activeSpeaker.identity = resolveSpeakerIdentity(activeSpeaker.name, currentUser);
  }
  if (activeSpeaker?.name) {
    addParticipant({
      name: activeSpeaker.name,
      source: activeSpeaker.source,
      confidence: activeSpeaker.confidence,
      lastSeenAt: activeSpeaker.observedAt,
      rawLabel: activeSpeaker.rawLabel,
    });
  }

  const participants = Array.from(participantMap.values()).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const participantCount =
    typeof meetPage?.participantCount === "number" && Number.isFinite(meetPage.participantCount)
      ? meetPage.participantCount
      : participants.length || null;
  return {
    ok: Boolean(meetPage?.ok || captions?.ok),
    observedAt: nowIso(),
    source: "meet_dom_and_caption_tail",
    participants,
    participantCount,
    activeSpeaker,
    recentSpeakers: recentSpeakers.slice(-8),
    caveat:
      "Best-effort Google Meet DOM/caption heuristic; active speaker is not an official Google API signal.",
  };
}

export function meetingAwarenessContextText(awareness: MeetingAwarenessState | null): string {
  if (!awareness?.ok) return "";
  const displayName = (entry?: { name?: string; identity?: SpeakerIdentityResolution | null }) =>
    entry?.identity?.preferredName || entry?.identity?.canonicalName || entry?.name || "";
  const names = awareness.participants
    .map((participant) => displayName(participant))
    .filter(Boolean);
  const speaker = displayName(awareness.activeSpeaker || undefined) || "暂时不确定";
  const lines = [
    "会议实时状态更新：",
    `- 当前可见参会者：${names.length ? names.join("、") : "暂时不确定"}。`,
    `- 当前或最近说话的人：${speaker}。`,
  ];
  const identity = awareness.activeSpeaker?.identity;
  if (identity?.resolved) {
    lines.splice(
      3,
      0,
      identity.isCurrentUser
        ? "- 这位说话者就是当前用户；第一人称表达按当前用户理解。"
        : `- 这位说话者可以按 ${identity.preferredName || identity.canonicalName} 理解。`,
    );
  }
  return lines.join("\n");
}

export function meetingAwarenessSignature(awareness: MeetingAwarenessState | null): string {
  if (!awareness?.ok) return "";
  const participants = awareness.participants
    .map((participant) => participant.name.toLowerCase())
    .toSorted()
    .join("|");
  const speakerIdentity = awareness.activeSpeaker?.identity;
  const speaker = [
    awareness.activeSpeaker?.name?.toLowerCase() || "",
    speakerIdentity?.canonicalName?.toLowerCase() || "",
    speakerIdentity?.preferredName?.toLowerCase() || "",
    speakerIdentity?.isCurrentUser ? "current_user" : "",
  ].join("|");
  if (!participants && !speaker) return "";
  return `${speaker}::${participants}`;
}

export async function publishMeetingAwarenessToPage(
  page: Page,
  awareness: MeetingAwarenessState | null,
  pushContext = true,
) {
  if (!page) return { ok: false, skipped: true, reason: "realtime_sidecar_page_missing" };
  if (!awareness?.ok) return { ok: false, skipped: true, reason: "awareness_empty" };
  const contextText = meetingAwarenessContextText(awareness);
  return await withTimeout(
    page.evaluate(
      ({ state, text, push, signature }) => {
        window.MAB_MEETING_AWARENESS = state;
        if (!push) return { ok: true, stored: true, pushed: false, reason: "unchanged" };
        if (!text) return { ok: true, stored: true, pushed: false, reason: "empty_context" };
        const client = window.MAB_REALTIME_CLIENT;
        if (typeof client?.pushSessionContext === "function") {
          const result = client.pushSessionContext({
            text,
            signature,
            reason: "meeting_awareness",
            kind: "meetingAwareness",
            value: state,
          });
          return {
            ok: true,
            stored: true,
            pushed: result?.ok === true,
            channel: result?.channel || "",
            result,
          };
        }
        return { ok: true, stored: true, pushed: false, reason: "session_context_api_missing" };
      },
      {
        state: awareness,
        text: contextText,
        push: pushContext,
        signature: meetingAwarenessSignature(awareness),
      },
    ),
    2500,
    { ok: false, error: "meeting_awareness_publish_timeout" },
  ).catch((error) => ({ ok: false, error: String(error?.message || error) }));
}

export function logMeetingAwarenessDebug(
  label: string,
  awareness: MeetingAwarenessState | null,
  pushResult?: unknown,
) {
  if (!awareness?.ok) return;
  const activeSpeaker = awareness.activeSpeaker || null;
  const detail = {
    label,
    observedAt: awareness.observedAt,
    participantCount: awareness.participantCount,
    participants: awareness.participants.map((participant) => ({
      name: participant.name,
      source: participant.source,
      confidence: participant.confidence,
      identity: participant.identity || null,
    })),
    activeSpeaker: activeSpeaker
      ? {
          name: activeSpeaker.name,
          source: activeSpeaker.source,
          confidence: activeSpeaker.confidence,
          identity: activeSpeaker.identity || null,
        }
      : null,
    pushResult: pushResult || null,
  };
  console.error(`[meeting-awareness] ${JSON.stringify(detail)}`);
  if (activeSpeaker?.name && !activeSpeaker.identity?.resolved) {
    console.warn(
      `[meeting-awareness-identity-unresolved] ${JSON.stringify({
        activeSpeaker: activeSpeaker.name,
        source: activeSpeaker.source,
        confidence: activeSpeaker.confidence,
        identity: activeSpeaker.identity || null,
      })}`,
    );
  }
}

export function compactRuntimeState({
  avatarReady,
  avatarAudio,
  realtimeBridge,
  workerResultBridge,
  localDialog,
  captions,
  screenShare,
}) {
  return {
    avatarState: avatarReady?.avatarState || null,
    avatarRenderer: avatarReady?.renderer || null,
    avatarAudio: avatarAudio
      ? {
          ok: avatarAudio.ok,
          routedStreams: avatarAudio.routedStreams,
          routedElements: avatarAudio.routedElements,
          routedBuffers: avatarAudio.routedBuffers,
          routedPcmChunks: avatarAudio.routedPcmChunks || 0,
          routedPcmSamples: avatarAudio.routedPcmSamples || 0,
          injectedTones: avatarAudio.injectedTones,
          sampleRate: avatarAudio.sampleRate,
          audioContextState: avatarAudio.audioContextState || "",
          outputTrackId: avatarAudio.outputTrackId || "",
          outputTrackReadyState: avatarAudio.outputTrackReadyState || "",
          outputTrackMuted: avatarAudio.outputTrackMuted === true,
          mouthLevel: avatarAudio.mouthLevel || 0,
          mouthRms: avatarAudio.mouthRms || 0,
          outputEnergy: avatarAudio.outputEnergy || null,
          syntheticSpeechActive: avatarAudio.syntheticSpeechActive === true,
          lastResumeAt: avatarAudio.lastResumeAt || "",
          lastResumeError: avatarAudio.lastResumeError || "",
          lastRoute: avatarAudio.lastRoute || null,
          lastPcmRoute: avatarAudio.lastPcmRoute || null,
          errors: avatarAudio.errors || [],
        }
      : null,
    realtime: realtimeBridge
      ? {
          mode: realtimeBridge.mode,
          realtimeRuntimePlacement: realtimeBridge.realtimeRuntimePlacement || "",
          realtimePageRole: realtimeBridge.realtimePageRole || "",
          sdkOwner: realtimeBridge.sdkOwner || "",
          connected: realtimeBridge.connected,
          connecting: realtimeBridge.connecting,
          feedback: realtimeBridge.feedback || null,
          contextHealth: realtimeBridge.contextHealth
            ? {
                enabled: realtimeBridge.contextHealth.enabled === true,
                itemsCount: realtimeBridge.contextHealth.itemsCount || 0,
                tokenEstimate: realtimeBridge.contextHealth.tokenEstimate || 0,
                lastHistoryTail: realtimeBridge.contextHealth.lastHistoryTail || [],
                latestFunctionalTurn: realtimeBridge.contextHealth.latestFunctionalTurn || null,
                compactCount: realtimeBridge.contextHealth.compactCount || 0,
                lastCompactAt: realtimeBridge.contextHealth.lastCompactAt || "",
                lastRefreshAt: realtimeBridge.contextHealth.lastRefreshAt || "",
                lastRefreshReason: realtimeBridge.contextHealth.lastRefreshReason || "",
              }
            : null,
          session: realtimeBridge.session || null,
          connection: realtimeBridge.connection || null,
          protection: realtimeBridge.protection || null,
          inboundTail: (realtimeBridge.inbound || []).slice(-12),
          transcripts: realtimeBridge.transcripts || null,
          workerResults: realtimeBridge.workerResults || [],
          outboundTail: (realtimeBridge.outbound || []).slice(-12).map((entry) => ({
            ts: entry.ts,
            type: entry.event?.type || "",
            itemType: entry.event?.item?.type || "",
          })),
          timelineTail: (realtimeBridge.timeline || []).slice(-20),
          errors: realtimeBridge.errors || [],
          avatarTools: realtimeBridge.avatarTools || null,
          workerTools: realtimeBridge.workerTools || null,
          meetTools: realtimeBridge.meetTools || null,
          workspaceTools: realtimeBridge.workspaceTools || null,
        }
      : null,
    workerResultBridge: workerResultBridge
      ? {
          ok: workerResultBridge.ok,
          enabled: workerResultBridge.enabled,
          deliveredTail: (workerResultBridge.delivered || []).slice(-10),
          errors: workerResultBridge.errors || [],
          lastPollAt: workerResultBridge.lastPollAt || "",
          lastDeliveryAt: workerResultBridge.lastDeliveryAt || "",
        }
      : null,
    localDialog: localDialog
      ? {
          ok: localDialog.ok,
          enabled: localDialog.enabled,
          provider: localDialog.provider,
          utterancesReceived: localDialog.utterancesReceived,
          responsesSpoken: localDialog.responsesSpoken,
          errors: localDialog.errors || [],
        }
      : null,
    captions: compactCaptionState(captions),
    screenShare: screenShare
      ? {
          ok: screenShare.ok,
          enabled: screenShare.enabled,
          active: screenShare.active,
          streamId: screenShare.streamId || "",
          trackIds: screenShare.trackIds || [],
          frames: screenShare.frames || 0,
          displayMediaCalls: screenShare.displayMediaCalls || 0,
          mode: screenShare.mode || "",
          title: screenShare.title || "",
          subtitle: screenShare.subtitle || "",
          videoUrl: screenShare.videoUrl || "",
          videoReady: Boolean(screenShare.videoReady),
          videoError: screenShare.videoError || "",
          imageUrl: screenShare.imageUrl || "",
          imageReady: Boolean(screenShare.imageReady),
          imageError: screenShare.imageError || "",
          errors: screenShare.errors || [],
        }
      : null,
  };
}

export async function evaluateMeetPageState(page: Page): Promise<MeetPageState> {
  const jsState = await withTimeout<MeetPageState, MeetPageState>(
    page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 5000);
      const url = location.href;
      const title = document.title || "";
      const realtimeBridge = (window as any).MAB_REALTIME_BRIDGE || {};
      const realtimeClient = (window as any).MAB_REALTIME_CLIENT || {};
      const agentRuntime = realtimeBridge.agentRuntime || {};
      const realtimeSurface = {
        runtimePlacement: String(
          realtimeBridge.realtimeRuntimePlacement ||
            realtimeBridge.runtimePlacement ||
            realtimeClient.realtimeRuntimePlacement ||
            realtimeClient.runtimePlacement ||
            "",
        ),
        pageRole: String(
          realtimeBridge.realtimePageRole ||
            realtimeBridge.pageRole ||
            realtimeClient.realtimePageRole ||
            realtimeClient.pageRole ||
            "",
        ),
        sdkOwner: String(realtimeBridge.sdkOwner || realtimeClient.sdkOwner || ""),
        sdkSuppressedOnMeetSurface: agentRuntime.sdkSuppressedOnMeetSurface === true,
        hasSDKGlobal: Boolean(
          (window as any).OpenAIAgentsRealtime || (window as any).openaiAgentsRealtime,
        ),
        bundleGlobal: String(agentRuntime.bundleGlobal || ""),
      };
      function compactHudCell(cell: any) {
        return {
          key: String(cell?.key || "").slice(0, 48),
          label: String(cell?.label || "").slice(0, 80),
          value: String(cell?.value || "").slice(0, 80),
          level: String(cell?.level || "").slice(0, 32),
        };
      }
      function collectAvatarHud() {
        const cells =
          typeof (window as any).MAB_AVATAR_HUD_VISIBLE_CELLS === "function"
            ? ((window as any).MAB_AVATAR_HUD_VISIBLE_CELLS() || []).map(compactHudCell)
            : [];
        const signals =
          typeof (window as any).MAB_AVATAR_HUD_SIGNALS === "function"
            ? ((window as any).MAB_AVATAR_HUD_SIGNALS() || []).map(compactHudCell)
            : [];
        return {
          available:
            typeof (window as any).MAB_AVATAR_HUD_VISIBLE_CELLS === "function" ||
            typeof (window as any).MAB_AVATAR_HUD_SIGNALS === "function",
          cells: cells.slice(0, 12),
          signals: signals.slice(0, 12),
        };
      }
      function collectKWWKCursor() {
        const snapshot =
          typeof (window as any).MAB_KWWK_CURSOR_SNAPSHOT === "function"
            ? (window as any).MAB_KWWK_CURSOR_SNAPSHOT()
            : null;
        const artifact =
          typeof (window as any).MAB_KWWK_CURSOR_ARTIFACT === "function"
            ? (window as any).MAB_KWWK_CURSOR_ARTIFACT()
            : null;
        return {
          available:
            typeof (window as any).MAB_KWWK_CURSOR_SNAPSHOT === "function" ||
            typeof (window as any).MAB_KWWK_CURSOR_ARTIFACT === "function",
          snapshot: snapshot
            ? {
                visible: snapshot.visible === true,
                x: Number(snapshot.x || 0),
                y: Number(snapshot.y || 0),
                kind: String(snapshot.kind || "").slice(0, 32),
                label: String(snapshot.label || "").slice(0, 80),
                ageMs: Number(snapshot.ageMs || 0),
                holdMs: Number(snapshot.holdMs || 0),
              }
            : undefined,
          artifact: artifact
            ? {
                schema: String(artifact.schema || ""),
                coordinateSpaces: artifact.coordinateSpaces || {},
                events: Array.isArray(artifact.events) ? artifact.events.slice(-20) : [],
                trail: Array.isArray(artifact.trail) ? artifact.trail.slice(-20) : [],
                styles: artifact.styles || {},
                latest: artifact.latest || null,
              }
            : undefined,
        };
      }
      const avatarHud = collectAvatarHud();
      const kwwkCursor = collectKWWKCursor();
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))
        .map((node, index) => {
          const rect = node.getBoundingClientRect();
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return {
            index,
            label: label.slice(0, 160),
            disabled: Boolean(
              ("disabled" in node && typeof node.disabled === "boolean" && node.disabled) ||
              node.getAttribute("aria-disabled") === "true",
            ),
            visible:
              rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        })
        .filter((button) => button.visible && button.label);
      function cleanPersonName(raw: unknown): string {
        let value = String(raw || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!value) return "";
        value = value
          .replace(
            /\s*\((?:you|me|host|presenting|speaking|muted|muted microphone|microphone off)\)\s*$/i,
            "",
          )
          .replace(/\s+(?:is )?(?:speaking|talking|presenting)$/i, "")
          .replace(/\s+(?:muted|microphone off|camera off)$/i, "")
          .replace(/'s (?:video|screen|presentation)$/i, "")
          .replace(/(?:的视频|正在发言|正在讲话|正在演示|已静音|麦克风已关闭)$/g, "")
          .trim();
        if (!value || value.length > 80 || value.split(" ").length > 8) return "";
        const lowered = value.toLowerCase();
        const blacklist = new Set([
          "leave call",
          "leave meeting",
          "turn off microphone",
          "turn on microphone",
          "turn off camera",
          "turn on camera",
          "raise hand",
          "more options",
          "present now",
          "share screen",
          "people",
          "chat",
          "activities",
          "host controls",
          "settings",
          "unknown",
        ]);
        if (blacklist.has(lowered)) return "";
        if (/^(press down arrow|external participants joined|your audio is merged)/i.test(value)) {
          return "";
        }
        return value;
      }
      function firstNameFromNode(node: HTMLElement | null): string {
        if (!node) return "";
        const direct = [
          node.getAttribute("data-self-name"),
          node.getAttribute("data-participant-name"),
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
        ];
        for (const candidate of direct) {
          const name = cleanPersonName(candidate);
          if (name) return name;
        }
        const line = (node.innerText || node.textContent || "")
          .split("\n")
          .map((candidateLine) => cleanPersonName(candidateLine))
          .find(Boolean);
        return line || "";
      }
      function addParticipant(
        map: Map<string, MeetParticipantSignal>,
        input: Partial<MeetParticipantSignal>,
      ) {
        const name = cleanPersonName(input.name);
        if (!name) return;
        const key = name.toLowerCase();
        if (map.has(key)) return;
        map.set(key, {
          name,
          source: input.source || "meet_dom",
          confidence: input.confidence || "low",
          participantId: input.participantId || "",
          rawLabel: input.rawLabel || "",
          lastSeenAt: new Date().toISOString(),
        });
      }
      function parseSpeakerFromLabel(label: string): string {
        const normalized = String(label || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!normalized) return "";
        const patterns = [
          /^(.+?)\s+(?:is\s+)?(?:speaking|talking)$/i,
          /^(.+?)\s+(?:is\s+)?presenting$/i,
          /^(.+?)'s (?:video|screen|presentation)$/i,
          /^正在(?:发言|讲话)[:：]?\s*(.+)$/i,
          /^(.+?)\s*正在(?:发言|讲话)$/i,
        ];
        for (const pattern of patterns) {
          const match = normalized.match(pattern);
          if (match) {
            const name = cleanPersonName(match[1]);
            if (name) return name;
          }
        }
        return "";
      }
      function collectParticipants(): MeetParticipantSignal[] {
        const map = new Map<string, MeetParticipantSignal>();
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-participant-id], [data-requested-participant-id], [data-self-name], [data-participant-name]",
          ),
        ).slice(0, 80);
        for (const node of nodes) {
          addParticipant(map, {
            name: firstNameFromNode(node),
            source: "meet_participant_tile",
            confidence: "medium",
            participantId:
              node.getAttribute("data-participant-id") ||
              node.getAttribute("data-requested-participant-id") ||
              "",
            rawLabel:
              node.getAttribute("aria-label") ||
              node.getAttribute("title") ||
              (node.innerText || "").split("\n").slice(0, 3).join(" / "),
          });
        }
        return Array.from(map.values());
      }
      function detectActiveSpeaker(): MeetSpeakerSignal | null {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-label], [data-tooltip], [title], [role="button"], [role="listitem"], [data-participant-id], [data-requested-participant-id]',
          ),
        ).slice(0, 400);
        for (const node of nodes) {
          const rawLabel = [
            node.getAttribute("aria-label"),
            node.getAttribute("data-tooltip"),
            node.getAttribute("title"),
            (node.innerText || "").split("\n").slice(0, 3).join(" "),
          ]
            .filter(Boolean)
            .join(" ");
          if (!/(speaking|talking|正在发言|正在讲话)/i.test(rawLabel)) continue;
          const tile = node.closest<HTMLElement>(
            "[data-participant-id], [data-requested-participant-id], [data-self-name], [data-participant-name]",
          );
          const name = parseSpeakerFromLabel(rawLabel) || firstNameFromNode(tile);
          if (!name) continue;
          return {
            name,
            source: "meet_speaker_tile_indicator",
            confidence: "medium",
            observedAt: new Date().toISOString(),
            rawLabel: rawLabel.slice(0, 240),
          };
        }
        return null;
      }
      function participantCount(): number | null {
        const peopleBtn = document.querySelector<HTMLElement>(
          'button[aria-label*="people" i], button[aria-label*="参与者"], button[aria-label*="用户"]',
        );
        if (peopleBtn) {
          const badge = peopleBtn.querySelector(".gv5Jzc, .uGOf1d, .wnPUne");
          if (badge?.textContent) {
            const parsed = Number.parseInt(badge.textContent.trim(), 10);
            if (Number.isFinite(parsed)) return parsed;
          }
          const label = peopleBtn.getAttribute("aria-label") || "";
          const match = label.match(/\((\d+)\)/);
          if (match) return Number.parseInt(match[1], 10);
        }

        const tiles = document.querySelectorAll(
          "[data-participant-id], [data-requested-participant-id]",
        );
        if (tiles.length > 0) return tiles.length;
        return null;
      }
      const participants = collectParticipants();
      const activeSpeaker = detectActiveSpeaker();
      const waitingForAdmit =
        /Please wait until a meeting host brings you into the call|Someone will let you in soon|waiting for.*host/i.test(
          text,
        );
      const inMeetingSignals = [
        /You have joined the call/i.test(text),
        /Leave call|退出通话|离开通话/i.test(text),
        /Leave meeting|退出会议|离开会议/i.test(text),
        /Present now|Share screen|共享屏幕|展示/i.test(text),
        /People|参与者|用户/i.test(text) && /Chat|聊天|通话期间的消息/i.test(text),
        buttons.some((button) =>
          /Leave call|Leave meeting|退出通话|离开通话|退出会议|离开会议|Turn off microphone|Turn on microphone|Turn off camera|Turn on camera|Raise hand|举手|More options|Share screen|Present now|共享屏幕|与所有人聊天|会议工具|发送回应/i.test(
            button.label,
          ),
        ),
      ];
      const fixtureJoined = Boolean(
        (window as unknown as { __MAB_MEET_FIXTURE?: { joined?: boolean } }).__MAB_MEET_FIXTURE
          ?.joined,
      );
      const preJoinSignals = [
        /Join now/i.test(text),
        /Ask to join/i.test(text),
        /Getting ready/i.test(text),
        /立即加入|申请加入|你的姓名/i.test(text),
      ];
      const signInSignals = [
        /Forgot email/i.test(text),
        /Create account/i.test(text),
        /Sign in/i.test(text) && /Next/i.test(text),
        /accounts\.google\.com/i.test(url),
      ];
      const preJoin = !fixtureJoined && preJoinSignals.some(Boolean);
      const inMeeting =
        !waitingForAdmit && (fixtureJoined || (!preJoin && inMeetingSignals.some(Boolean)));
      const cannotJoin =
        !inMeeting &&
        !waitingForAdmit &&
        !preJoin &&
        /You can't join this video call|No one can join a meeting unless invited or admitted by the host/i.test(
          text,
        );
      return {
        ok: true,
        url,
        title,
        inMeeting,
        participantCount: participantCount(),
        participants,
        activeSpeaker,
        waitingForAdmit,
        preJoin,
        signIn: signInSignals.some(Boolean),
        cannotJoin,
        textHead: text.slice(0, 1000),
        buttons: buttons.slice(0, 30),
        realtimeSurface,
        avatarHud,
        kwwkCursor,
      };
    }),
    2500,
    {
      ok: false,
      error: "meet_page_state_timeout",
    },
  ).catch(
    (error): MeetPageState => ({
      ok: false,
      error: String(error?.message || error),
    }),
  );
  if (jsState.ok || jsState.error !== "meet_page_state_timeout") return jsState;
  const accessibilityState = await evaluateMeetAccessibilityState(page);
  if (accessibilityState.ok) {
    return {
      ...accessibilityState,
      jsProbe: jsState,
    };
  }
  return {
    ...jsState,
    accessibilityProbe: accessibilityState,
  };
}

export async function openMeetPeoplePanelForAwareness(page: Page, diagnostics?: Diagnostics) {
  const result = await withTimeout(
    page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const peopleButton = buttons.find((node) => {
        const label =
          `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""}`
            .replace(/\s+/g, " ")
            .trim();
        return /people|participants|show everyone|参与者|用户|成员/i.test(label);
      });
      if (!peopleButton) return { ok: false, reason: "people_button_not_found" };
      const expanded =
        peopleButton.getAttribute("aria-expanded") === "true" ||
        peopleButton.getAttribute("aria-pressed") === "true";
      if (expanded) {
        return {
          ok: true,
          alreadyOpen: true,
          label: (peopleButton.getAttribute("aria-label") || peopleButton.innerText || "").slice(
            0,
            120,
          ),
        };
      }
      peopleButton.click();
      return {
        ok: true,
        clicked: true,
        label: (peopleButton.getAttribute("aria-label") || peopleButton.innerText || "").slice(
          0,
          120,
        ),
      };
    }),
    2500,
    { ok: false, reason: "people_panel_open_timeout" },
  ).catch((error) => ({
    ok: false,
    reason: "people_panel_open_error",
    error: String(error?.message || error),
  }));
  diagnostics?.record("meeting_awareness_people_panel", result);
  if ((result as any)?.clicked) await page.waitForTimeout(700).catch(() => {});
  return result;
}
