import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { OperatorErrorBoundary } from "./OperatorErrorBoundary.tsx";
import type { OperatorBoot } from "./useRealtime.ts";

declare global {
  interface Window {
    __OPERATOR_BOOT__?: OperatorBoot;
  }
}

const boot: OperatorBoot = window.__OPERATOR_BOOT__ || { sessionId: "" };
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <OperatorErrorBoundary>
        <App boot={boot} />
      </OperatorErrorBoundary>
    </StrictMode>,
  );
}
