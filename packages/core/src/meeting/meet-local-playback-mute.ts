/// <reference lib="dom" />
// @ts-check

import type { LocalPlaybackMuteState } from "../browser-runtime-types.ts";

type LocalPlaybackMute = {
  observer: MutationObserver;
  state: LocalPlaybackMuteState;
  sweep: () => { ok: true; muted: number; state: LocalPlaybackMuteState };
};

/**
 * @typedef {{ record?: (type: string, detail?: any) => void } | null} Diagnostics
 * @typedef {import('playwright').Page} Page
 */

/**
 * @param {Page} page
 * @param {Diagnostics} [diagnostics]
 */
export async function installMeetLocalPlaybackMute(page, diagnostics = null) {
  const result = await page
    .evaluate(() => {
      const globalScope = window as Window & typeof globalThis & {
        __MAB_MEET_LOCAL_PLAYBACK_MUTE?: LocalPlaybackMute;
      };
      if (globalScope.__MAB_MEET_LOCAL_PLAYBACK_MUTE) {
        return {
          ok: true,
          alreadyInstalled: true,
          state: globalScope.__MAB_MEET_LOCAL_PLAYBACK_MUTE.state,
        };
      }
      const state: LocalPlaybackMuteState = {
        ok: true,
        installedAt: new Date().toISOString(),
        mutedElements: 0,
        lastMutedAt: "",
        errors: [],
      };
      const muteElement = (node) => {
        if (!(node instanceof HTMLMediaElement)) return false;
        try {
          node.defaultMuted = true;
          node.muted = true;
          node.volume = 0;
          node.setAttribute("muted", "");
          node.dataset.meetingAvatarLocalPlaybackMuted = "true";
          state.mutedElements += 1;
          state.lastMutedAt = new Date().toISOString();
          return true;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error || "local_playback_mute_failed");
          state.errors.push(message.slice(0, 160));
          state.errors = state.errors.slice(-10);
          return false;
        }
      };
      const sweep = () => {
        const mediaElements = Array.from(document.querySelectorAll("audio, video"));
        let muted = 0;
        for (const element of mediaElements) {
          if (muteElement(element)) muted += 1;
        }
        return muted;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes || []) {
            if (node instanceof HTMLMediaElement) {
              muteElement(node);
              continue;
            }
            if (!(node instanceof Element)) continue;
            for (const child of node.querySelectorAll("audio, video")) muteElement(child);
          }
        }
      });
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
      /** @param {unknown} fn */
      const asPatched = (fn) =>
        /** @type {{ __meetingAvatarPatched?: boolean }} */ (/** @type {any} */ (fn));
      /** @param {{ play?: HTMLMediaElement["play"] } | undefined | null} proto */
      const installPlayGuard = (proto) => {
        if (!proto) return;
        const original = proto?.play;
        if (typeof original !== "function" || asPatched(original).__meetingAvatarPatched) return;
        /** @this {HTMLMediaElement} */
        const wrapped = function patchedPlay(...args) {
          muteElement(this);
          return Reflect.apply(
            /** @type {(this: HTMLMediaElement, ...args: any[]) => unknown} */ (original),
            this,
            args,
          );
        };
        asPatched(wrapped).__meetingAvatarPatched = true;
        proto.play = /** @type {HTMLMediaElement["play"]} */ (wrapped);
      };
      try {
        installPlayGuard(window.HTMLMediaElement?.prototype);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error || "install_play_guard_failed");
        state.errors.push(message.slice(0, 160));
      }
      sweep();
      globalScope.__MAB_MEET_LOCAL_PLAYBACK_MUTE = {
        observer,
        state,
        sweep: () => ({ ok: true, muted: sweep(), state }),
      };
      return {
        ok: true,
        installed: true,
        muted: state.mutedElements,
        state,
      };
    })
    .catch((error) => ({
      ok: false,
      error: String(error?.message || error).slice(0, 180),
    }));
  diagnostics?.record?.("local_playback_mute", result);
  return result;
}
