import { useMemo, useState } from "react";

import type { OperatorBoot } from "./useRealtime.ts";
import { authSuffix } from "./protocol.ts";

type StageSource = "app" | "avatar";

/**
 * The stage shows the bot embodied — its app view and its avatar face — which
 * the user considers critical to verifying realtime. Phase 2 reuses the
 * existing /host-visual renderer page as an iframe per source (the avatar face
 * is really rendered there) rather than re-porting the WebRTC composition; the
 * composited Meet camera comes later.
 */
export function Stage({ boot }: { boot: OperatorBoot }) {
  const [active, setActive] = useState<StageSource>("avatar");

  const avatarPreset =
    new URLSearchParams(location.search).get("avatarPreset") || "fallback-canvas";

  const srcFor = useMemo(
    () => ({
      app: authSuffix(
        boot.token,
        "/host-visual?embed=1&sourceId=host-app&label=App%20view&kind=desktop_app",
      ),
      avatar: authSuffix(
        boot.token,
        `/host-visual?embed=1&avatar=1&sourceId=avatar&label=Avatar&kind=avatar&avatarPreset=${encodeURIComponent(avatarPreset)}`,
      ),
    }),
    [boot.token, avatarPreset],
  );

  return (
    <section className="op-stage">
      <div className="op-stage-tabs">
        <button
          className={active === "avatar" ? "active" : ""}
          onClick={() => setActive("avatar")}
          type="button"
        >
          Avatar
        </button>
        <button
          className={active === "app" ? "active" : ""}
          onClick={() => setActive("app")}
          type="button"
        >
          App view
        </button>
      </div>
      <div className="op-stage-frame">
        {/* Both iframes stay mounted so the avatar keeps rendering when you
            peek at the app view; only the active one is shown. */}
        <iframe
          title="Avatar"
          src={srcFor.avatar}
          style={{ display: active === "avatar" ? "block" : "none" }}
          allow="autoplay; camera; microphone"
        />
        <iframe
          title="App view"
          src={srcFor.app}
          style={{ display: active === "app" ? "block" : "none" }}
          allow="autoplay; display-capture"
        />
      </div>
    </section>
  );
}
