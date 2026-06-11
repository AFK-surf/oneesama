export interface RuntimeReportClipboard {
  writeText?: (text: string) => Promise<unknown> | unknown;
}

export interface RuntimeReportDownloadAnchor {
  href: string;
  download: string;
  click: () => void;
}

export interface RuntimeReportDownloadDocument {
  createElement: (tagName: "a") => RuntimeReportDownloadAnchor;
}

export interface RuntimeReportDownloadUrl {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (href: string) => void;
}

export async function copyRuntimeReportText(input: {
  fetchReportText: () => Promise<string>;
  clipboard?: RuntimeReportClipboard | null;
}): Promise<number> {
  const text = await input.fetchReportText();
  await Promise.resolve(input.clipboard?.writeText?.(text)).catch(() => undefined);
  return text.length;
}

export async function downloadRuntimeReportText(input: {
  fetchReportText: () => Promise<string>;
  document: RuntimeReportDownloadDocument;
  url: RuntimeReportDownloadUrl;
  nowMs?: number;
}): Promise<void> {
  const text = await input.fetchReportText();
  const blob = new Blob([text], { type: "application/json" });
  const href = input.url.createObjectURL(blob);
  try {
    const anchor = input.document.createElement("a");
    anchor.href = href;
    anchor.download = runtimeReportFilename(input.nowMs);
    anchor.click();
  } finally {
    input.url.revokeObjectURL(href);
  }
}

export function runtimeReportFilename(nowMs = Date.now()): string {
  return `lan-operator-report-${nowMs}.json`;
}
