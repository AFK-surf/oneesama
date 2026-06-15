const STOPPABLE_KWWK_STATUS =
  /queued|started|streaming|running|observing|planning|executing|verifying/i;

export function canStopKwwkStatus(status: string | null | undefined): boolean {
  return STOPPABLE_KWWK_STATUS.test(status || "");
}
