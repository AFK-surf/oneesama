import { CommandBar } from "./CommandBar.tsx";
import { ConversationPanel } from "./ConversationPanel.tsx";
import { DiagnosticsPanel } from "./DiagnosticsPanel.tsx";
import { Stage } from "./Stage.tsx";
import { VoiceBar } from "./VoiceBar.tsx";
import { WorkPanel } from "./WorkPanel.tsx";
import { appShellView } from "./appShellView.ts";
import { useLegacySurfaceBridge } from "./useLegacySurfaceBridge.ts";
import { useOperatorRuntime } from "./useOperatorRuntime.ts";
import { useRealtime, type OperatorBoot } from "./useRealtime.ts";
import { useVoice } from "./useVoice.ts";
import { useWork } from "./useWork.ts";

export function App({ boot }: { boot: OperatorBoot }) {
  const rt = useRealtime(boot);
  const runtime = useOperatorRuntime(boot, rt);
  const voice = useVoice(boot, rt.subscribe, rt.send);
  const work = useWork(rt);
  const shell = appShellView(runtime, rt);

  useLegacySurfaceBridge({ realtime: rt, runtime, voice });

  return (
    <div className={shell.shellClass}>
      <CommandBar boot={boot} realtime={rt} runtime={runtime} />
      <main className="op-main">
        <div className="op-left-rail">
          <Stage boot={boot} debug={runtime.debug} />
          <VoiceBar voice={voice} connected={shell.connected} />
        </div>
        <div className="op-center-rail">
          <ConversationPanel realtime={rt} runtime={runtime} />
          <WorkPanel work={work} runtime={runtime} />
        </div>
        <DiagnosticsPanel runtime={runtime} />
      </main>
    </div>
  );
}
