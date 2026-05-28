import type { Locator, Page } from "playwright";

type Diagnostics = { record?: (type: string, detail?: unknown) => void } | null;

type MeetCameraOffResult =
  | {
      ok: true;
      stage: string;
      clicked: true;
      selector: string;
      label: string;
    }
  | {
      ok: true;
      stage: string;
      clicked: false;
      reason: "already_off" | "camera_toggle_not_found";
      label: string;
    }
  | {
      ok: false;
      stage: string;
      clicked: false;
      selector: string;
      label: string;
      error: string;
    };

const TURN_OFF_CAMERA_RE = /turn off camera|关闭摄像头|关闭相机|关闭视频/i;
const TURN_ON_CAMERA_RE =
  /turn on camera|开启摄像头|打开摄像头|开启相机|打开相机|开启视频|打开视频/i;

async function isVisibleWithin(locator: Locator, timeoutMs: number) {
  return await locator
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function readLocatorLabel(locator: Locator) {
  const ariaLabel = await locator.getAttribute("aria-label", { timeout: 500 }).catch(() => null);
  const title = await locator.getAttribute("title", { timeout: 500 }).catch(() => null);
  const text = await locator.textContent({ timeout: 500 }).catch(() => null);
  return String(ariaLabel || title || text || "")
    .trim()
    .slice(0, 160);
}

export async function ensureMeetCameraOff(
  page: Page,
  diagnostics: Diagnostics = null,
  stage = "unspecified",
): Promise<MeetCameraOffResult> {
  const offButton = page.getByRole("button", { name: TURN_OFF_CAMERA_RE }).first();
  if (await isVisibleWithin(offButton, 800)) {
    const label = await readLocatorLabel(offButton);
    const result = await offButton
      .click({ timeout: 2500 })
      .then(
        () =>
          ({
            ok: true,
            stage,
            clicked: true,
            selector: "role:button[name=turn-off-camera]",
            label,
          }) as const,
      )
      .catch(
        (error) =>
          ({
            ok: false,
            stage,
            clicked: false,
            selector: "role:button[name=turn-off-camera]",
            label,
            error: String(error?.message || error).slice(0, 180),
          }) as const,
      );
    diagnostics?.record?.("meet_camera_off", result);
    if (result.clicked) await page.waitForTimeout(700).catch(() => {});
    return result;
  }

  const onButton = page.getByRole("button", { name: TURN_ON_CAMERA_RE }).first();
  const alreadyOff = await isVisibleWithin(onButton, 300);
  const result: MeetCameraOffResult = {
    ok: true,
    stage,
    clicked: false,
    reason: alreadyOff ? ("already_off" as const) : ("camera_toggle_not_found" as const),
    label: alreadyOff ? await readLocatorLabel(onButton) : "",
  };
  diagnostics?.record?.("meet_camera_off", result);
  return result;
}
