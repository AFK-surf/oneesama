export const SLACK_APP_REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "pins:read",
  "pins:write",
  "reactions:read",
  "reactions:write",
  "users:read",
];

export const SLACK_APP_RECOMMENDED_BOT_SCOPES = [
  "bookmarks:read",
  "bookmarks:write",
  "canvases:read",
  "canvases:write",
  "users:read.email",
];

export const SLACK_APP_RECOMMENDED_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "im:history",
];

export const SLACK_APP_REQUIRED_BOT_EVENTS = [
  "app_mention",
  "assistant_thread_context_changed",
  "assistant_thread_started",
  "message.channels",
  "message.groups",
  "message.im",
];

function cleanUrl(url, fallback = "http://127.0.0.1:8780") {
  const value = String(url || "").trim() || fallback;
  return value.replace(/\/+$/, "");
}

function uniqSorted(values) {
  return [
    ...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)),
  ].toSorted();
}

function hasPathValue(object, path, expected) {
  const actual = path.split(".").reduce((current, key) => current?.[key], object);
  return actual === expected;
}

function diffItems(actual, required) {
  const actualSet = new Set(uniqSorted(actual));
  return uniqSorted(required).filter((item) => !actualSet.has(item));
}

export function createOneeSamaSlackManifest({
  publicBaseUrl = "http://127.0.0.1:8780",
  displayName = "Onee-sama",
  command = "/avatar",
} = {}) {
  const baseUrl = cleanUrl(publicBaseUrl);
  return {
    display_information: {
      name: displayName,
      background_color: "#302f2f",
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: displayName,
        always_online: true,
      },
      assistant_view: {
        assistant_description: `${displayName} helps summarize conversations, answer questions, and delegate complex work to Codex.`,
        suggested_prompts: [
          {
            title: "总结当前频道",
            message: "请总结这个频道最近的重要讨论。",
          },
          {
            title: "委托 Codex",
            message: "请把这个任务委托给 Codex，并把结果发回这个线程。",
          },
        ],
      },
      slash_commands: [
        {
          command,
          url: `${baseUrl}/slack/commands/avatar`,
          description: "Control the Meeting Avatar bot",
          usage_hint: "join <meet-url> | status | stop | delegate <task> | jobs",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}/slack/oauth`],
      scopes: {
        user: SLACK_APP_RECOMMENDED_USER_SCOPES,
        bot: uniqSorted([...SLACK_APP_REQUIRED_BOT_SCOPES, ...SLACK_APP_RECOMMENDED_BOT_SCOPES]),
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}/slack/events`,
        bot_events: SLACK_APP_REQUIRED_BOT_EVENTS,
      },
      interactivity: {
        is_enabled: true,
        request_url: `${baseUrl}/slack/interactions`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      is_mcp_enabled: false,
    },
  };
}

export function parseSlackAppManifest(input) {
  if (!input) return null;
  if (typeof input === "string") return JSON.parse(input);
  if (typeof input === "object") return input.manifest || input.app_manifest || input;
  return null;
}

export function validateSlackAppManifest(
  input,
  { expected = createOneeSamaSlackManifest(), requireRecommended = false } = {},
) {
  const manifest = parseSlackAppManifest(input);
  if (!manifest) return { ok: false, error: "manifest_required", checks: [] };

  const botScopes = manifest.oauth_config?.scopes?.bot || [];
  const userScopes = manifest.oauth_config?.scopes?.user || [];
  const botEvents = manifest.settings?.event_subscriptions?.bot_events || [];
  const slashCommands = manifest.features?.slash_commands || [];
  const expectedCommand = expected.features?.slash_commands?.[0]?.command || "/avatar";
  const missingBotScopes = diffItems(botScopes, SLACK_APP_REQUIRED_BOT_SCOPES);
  const missingRecommendedBotScopes = diffItems(botScopes, SLACK_APP_RECOMMENDED_BOT_SCOPES);
  const missingRecommendedUserScopes = diffItems(userScopes, SLACK_APP_RECOMMENDED_USER_SCOPES);
  const missingEvents = diffItems(botEvents, SLACK_APP_REQUIRED_BOT_EVENTS);
  const hasSlashCommand = slashCommands.some((entry) => entry?.command === expectedCommand);

  const checks = [
    {
      name: "bot_scopes",
      ok: missingBotScopes.length === 0,
      missing: missingBotScopes,
      required: SLACK_APP_REQUIRED_BOT_SCOPES,
    },
    {
      name: "bot_events",
      ok: missingEvents.length === 0,
      missing: missingEvents,
      required: SLACK_APP_REQUIRED_BOT_EVENTS,
    },
    {
      name: "app_home_messages_tab",
      ok: hasPathValue(manifest, "features.app_home.messages_tab_enabled", true),
      expected: true,
      actual: manifest.features?.app_home?.messages_tab_enabled,
      hint: "Slack App Home Messages tab must be enabled before users can DM the bot from its app surface.",
    },
    {
      name: "app_home_messages_writable",
      ok: hasPathValue(manifest, "features.app_home.messages_tab_read_only_enabled", false),
      expected: false,
      actual: manifest.features?.app_home?.messages_tab_read_only_enabled,
      hint: "Messages tab must not be read-only.",
    },
    {
      name: "assistant_view",
      ok: Boolean(manifest.features?.assistant_view?.assistant_description),
      hint: "Assistant view should be configured for Slack Assistant threads and suggested prompts.",
    },
    {
      name: "bot_user",
      ok: Boolean(manifest.features?.bot_user?.display_name),
      hint: "Manifest needs a bot user display name.",
    },
    {
      name: "slash_command",
      ok: hasSlashCommand,
      expected: expectedCommand,
      actual: slashCommands.map((entry) => entry?.command).filter(Boolean),
    },
    {
      name: "socket_mode",
      ok: hasPathValue(manifest, "settings.socket_mode_enabled", true),
      expected: true,
      actual: manifest.settings?.socket_mode_enabled,
    },
    {
      name: "interactivity",
      ok: hasPathValue(manifest, "settings.interactivity.is_enabled", true),
      expected: true,
      actual: manifest.settings?.interactivity?.is_enabled,
    },
  ];

  const warnings = [
    {
      name: "recommended_bot_scopes",
      ok: missingRecommendedBotScopes.length === 0,
      missing: missingRecommendedBotScopes,
      recommended: SLACK_APP_RECOMMENDED_BOT_SCOPES,
    },
    {
      name: "recommended_user_scopes",
      ok: missingRecommendedUserScopes.length === 0,
      missing: missingRecommendedUserScopes,
      recommended: SLACK_APP_RECOMMENDED_USER_SCOPES,
    },
  ];

  const blocking = checks.filter((check) => !check.ok);
  const warningFailures = requireRecommended ? warnings.filter((check) => !check.ok) : [];
  return {
    ok: blocking.length === 0 && warningFailures.length === 0,
    checks,
    warnings,
    blocking: blocking.map((check) => check.name),
    installSteps: buildSlackInstallChecklist({ validation: { checks, warnings } }),
  };
}

export function buildSlackInstallChecklist({ validation = null } = {}) {
  const missing = (validation?.checks || [])
    .filter((check) => !check.ok)
    .map((check) => ({
      name: check.name,
      missing: check.missing || [],
      expected: check.expected,
      actual: check.actual,
      hint: check.hint || "",
    }));
  return [
    "Apply or update the Slack app manifest.",
    "Save OAuth scopes and bot event subscriptions.",
    "Reinstall the app to the workspace after any scope/event/App Home change.",
    "Restart the Slack Agent only after local validation is green.",
    ...missing.map(
      (item) =>
        `Fix ${item.name}: ${item.hint || item.missing.join(", ") || "see expected/actual values"}`,
    ),
  ];
}

export function buildSlackOAuthAuthorizeUrl({
  clientId = "",
  redirectUri = "",
  state = "",
  userScopes = SLACK_APP_RECOMMENDED_USER_SCOPES,
  botScopes = SLACK_APP_REQUIRED_BOT_SCOPES,
} = {}) {
  const id = String(clientId || "").trim();
  if (!id) return "";
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", id);
  url.searchParams.set("scope", uniqSorted(botScopes).join(","));
  if (userScopes?.length) url.searchParams.set("user_scope", uniqSorted(userScopes).join(","));
  if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

interface ExchangeSlackOAuthCodeOptions {
  code?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
}

interface SlackOAuthResponseBody extends Record<string, unknown> {
  ok?: boolean;
  access_token?: string;
  bot_access_token?: string;
  refresh_token?: string;
  authed_user?: {
    access_token?: string;
    [key: string]: unknown;
  };
}

interface SlackOAuthExchangeResult {
  ok?: boolean;
  status?: number;
  body?: SlackOAuthResponseBody;
  [key: string]: unknown;
}

export async function exchangeSlackOAuthCode({
  code = "",
  clientId = "",
  clientSecret = "",
  redirectUri = "",
  fetchImpl = fetch,
}: ExchangeSlackOAuthCodeOptions = {}) {
  if (!code) return { ok: false, error: "code_required" };
  if (!clientId || !clientSecret) return { ok: false, error: "slack_client_credentials_required" };
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (redirectUri) params.set("redirect_uri", redirectUri);
  const response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = (await response.json().catch(() => ({}))) as SlackOAuthResponseBody;
  return {
    ok: Boolean(response.ok && body.ok),
    status: response.status,
    body,
  };
}

export function maskSlackOAuthResult(result: SlackOAuthExchangeResult = {}) {
  const body = { ...result.body };
  for (const key of ["access_token", "bot_access_token", "refresh_token"]) {
    if (body[key]) body[key] = `${String(body[key]).slice(0, 8)}...`;
  }
  if (body.authed_user?.access_token) {
    body.authed_user = {
      ...body.authed_user,
      access_token: `${String(body.authed_user.access_token).slice(0, 8)}...`,
    };
  }
  return { ...result, body };
}
