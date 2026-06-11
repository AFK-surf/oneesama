export interface CommandBarClipboard {
  writeText?: (text: string) => Promise<unknown> | unknown;
}

export async function copyProviderRunCommand(
  runCommand: string,
  clipboard?: CommandBarClipboard | null,
): Promise<boolean> {
  if (!runCommand || !clipboard?.writeText) return false;
  await Promise.resolve(clipboard.writeText(runCommand)).catch(() => undefined);
  return true;
}

export function shouldResetRealtimeSession(
  confirm: (message: string) => boolean,
  message = "Reset the Realtime session?",
): boolean {
  return confirm(message);
}
