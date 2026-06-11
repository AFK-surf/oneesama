export type WorkRunMessage = Record<string, unknown> & {
  type: "work_run";
  command: string;
};

export function workRunMessage(command: string): WorkRunMessage | null {
  const value = command.trim();
  if (!value) return null;
  return { type: "work_run", command: value };
}
