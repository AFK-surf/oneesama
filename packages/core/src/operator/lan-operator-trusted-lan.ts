export type TrustedLanModeDecision = {
  bindHost: string;
  allowed: boolean;
  localOnlyMode: boolean;
  trustedLanOperatorMode: boolean;
  lanModeExplicitlyEnabled: boolean;
  blocker: string | null;
  hint: string | null;
};

const TRUSTED_LAN_ENV_KEYS = [
  "MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN",
  "MAB_LAN_OPERATOR_TRUSTED_LAN",
];

function truthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

export function isLoopbackLanOperatorHost(host: string | undefined) {
  const normalized = String(host || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function trustedLanOperatorModeEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return TRUSTED_LAN_ENV_KEYS.some((key) => truthy(env[key]));
}

export function decideTrustedLanOperatorMode(input: {
  host?: string;
  env?: Record<string, string | undefined>;
}): TrustedLanModeDecision {
  const bindHost = String(input.host || "0.0.0.0").trim() || "0.0.0.0";
  const localOnlyMode = isLoopbackLanOperatorHost(bindHost);
  const trustedLanOperatorMode = trustedLanOperatorModeEnabled(input.env || process.env);
  const allowed = localOnlyMode || trustedLanOperatorMode;
  return {
    bindHost,
    allowed,
    localOnlyMode,
    trustedLanOperatorMode,
    lanModeExplicitlyEnabled: trustedLanOperatorMode,
    blocker: allowed ? null : "trusted_lan_operator_mode_not_enabled",
    hint: allowed
      ? null
      : "Set MAB_LAN_OPERATOR_ENABLE_TRUSTED_LAN=1 to expose the LAN Operator Surface beyond loopback.",
  };
}
