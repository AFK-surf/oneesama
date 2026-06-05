/// <reference lib="dom" />
// @ts-check

/**
 * @typedef {{ record?: (type: string, detail?: any) => void } | null} Diagnostics
 * @typedef {import('playwright').Page} Page
 */

/**
 * @param {Page} page
 */
async function evaluatePromptClick(page) {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const prompt = nodes
      .map((node, index) => {
        const label =
          `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
            .replace(/\s+/g, " ")
            .trim();
        return { node, index, label };
      })
      .find(
        ({ node, label }) =>
          isVisible(node) &&
          /^(got it|continue|continue without.*|dismiss|ok|okay|allow|close|not now|maybe later|skip|i agree|agree|accept all|reject all|同意する|同意しない|承諾|拒否|すべて拒否|すべて許可)$/i.test(
            label,
          ),
      );
    if (!prompt) return { ok: false };
    prompt.node.click();
    return { ok: true, selector: `dom:prompt:${prompt.index}`, label: prompt.label };
  });
}

/**
 * @param {Page} page
 * @param {Diagnostics} [diagnostics]
 */
export async function dismissMeetPrompts(page, diagnostics = null) {
  let clicked = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await evaluatePromptClick(page).catch((error) => ({
      ok: false,
      error: String(error?.message || error).slice(0, 180),
    }));
    if (!result.ok || !("selector" in result)) break;
    clicked = result.selector || "";
    diagnostics?.record?.("click", { selector: result.selector, label: result.label });
    await page.waitForTimeout(250);
  }
  return clicked;
}

/**
 * @param {Page} page
 * @param {Diagnostics} [diagnostics]
 */
export async function installMeetPromptAutoDismisser(page, diagnostics = null) {
  const result = await page
    .evaluate(() => {
      /** @typedef {{ timer: number, dismissOnce: () => boolean }} PromptDismisser */
      /** @type {Window & typeof globalThis & { __MAB_MEET_PROMPT_DISMISSER?: PromptDismisser }} */
      const globalScope = window;
      if (globalScope.__MAB_MEET_PROMPT_DISMISSER) return { ok: true, installed: false };
      /** @returns {HTMLElement[]} */
      const queryButtons = () =>
        Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"));
      const buttonPattern =
        /^(got it|continue|continue without.*|dismiss|ok|okay|allow|close|not now|maybe later|skip|i agree|agree|accept all|reject all|同意する|同意しない|承諾|拒否|すべて拒否|すべて許可)$/i;
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };
      const dismissOnce = () => {
        const nodes = queryButtons();
        const candidate = nodes.find((node) => {
          if (!isVisible(node)) return false;
          const label =
            `${node.innerText || node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
              .replace(/\s+/g, " ")
              .trim();
          return buttonPattern.test(label);
        });
        if (!candidate) return false;
        candidate.click();
        return true;
      };
      const timer = window.setInterval(dismissOnce, 1000);
      globalScope.__MAB_MEET_PROMPT_DISMISSER = { timer, dismissOnce };
      dismissOnce();
      return { ok: true, installed: true };
    })
    .catch((error) => ({
      ok: false,
      error: String(error?.message || error).slice(0, 180),
    }));
  diagnostics?.record?.("prompt_auto_dismisser", result);
  return result;
}
