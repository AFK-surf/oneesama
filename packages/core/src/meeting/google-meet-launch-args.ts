function splitChromiumArgs(value: unknown): string[] {
  return String(value || "")
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function filterFakeMediaDeviceArgs(args: string[], useFakeMediaDevice?: boolean): string[] {
  if (useFakeMediaDevice !== false) return args;
  return args.filter(
    (arg) =>
      !/^--use-fake-device-for-media-stream(?:=|$)/.test(arg) &&
      !/^--use-file-for-fake-audio-capture(?:=|$)/.test(arg),
  );
}

export function buildGoogleMeetChromiumArgs(input: {
  avatarUseSwiftShader?: boolean;
  browserExtraArgs?: unknown;
  chromiumExtraArgs?: unknown;
  useFakeMediaDevice?: boolean;
}): string[] {
  const callerArgs = filterFakeMediaDeviceArgs(
    [...splitChromiumArgs(input.browserExtraArgs), ...splitChromiumArgs(input.chromiumExtraArgs)],
    input.useFakeMediaDevice,
  );
  return [
    "--use-fake-ui-for-media-stream",
    ...(input.useFakeMediaDevice === false ? [] : ["--use-fake-device-for-media-stream"]),
    // Do not use --mute-audio: it can silence Meet remote tracks before WebAudio sees them.
    "--enable-usermedia-screen-capturing",
    "--auto-select-desktop-capture-source=Entire screen",
    "--auto-select-tab-capture-source-by-title=Meeting Avatar Bot",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-features=AudioServiceOutOfProcess",
    ...(input.avatarUseSwiftShader
      ? ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader"]
      : ["--use-angle=default", "--enable-gpu-rasterization"]),
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--disable-blink-features=AutomationControlled",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    ...callerArgs,
  ];
}
