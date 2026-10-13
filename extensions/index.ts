import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "pi-usage/26.10.13";

type Theme = ExtensionContext["ui"]["theme"];

type TimeParts = {
  n1: string;
  u1: string;
  n2: string;
  u2: string;
};

type UsageRow = {
  window: string;
  left: string;
  resets: string;
  time?: TimeParts;
};

type Part = {
  short: string;
  rows: UsageRow[];
};

type Snapshot = {
  at: number;
  detail: string;
};

let cache: Snapshot | undefined;
let inflight: Promise<Snapshot> | undefined;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show configured provider quota",
    handler: async (_args, ctx) => {
      const snap = await refresh(ctx, true);
      ctx.ui.notify(`\x1b[22m${snap.detail}`, "info");
    },
  });
}

async function refresh(ctx: ExtensionContext, force: boolean): Promise<Snapshot> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  inflight ??= load(ctx.ui.theme).finally(() => {
    inflight = undefined;
  });
  cache = await inflight;
  return cache;
}

async function load(theme: Theme): Promise<Snapshot> {
  const groups = (await Promise.all([
    optional(theme, "DeepSeek", fetchDeepSeek),
    optional(theme, "xAI", fetchXai),
    optional(theme, "OpenCode Go", fetchOpenCodeGo),
    optional(theme, "Z.AI", () => fetchZai("zai", "https://api.z.ai")),
    optional(theme, "Z.AI Coding CN", () => fetchZai("zai-coding-cn", "https://open.bigmodel.cn")),
    optional(theme, "Kimi For Coding", fetchKimi),
    optional(theme, "Moonshot AI", () => fetchMoonshot("moonshotai", "https://api.moonshot.ai", "$")),
    optional(theme, "Moonshot AI CN", () => fetchMoonshot("moonshotai-cn", "https://api.moonshot.cn", "¥")),
  ])).filter((group): group is [string, Part] => group !== undefined);
  return {
    at: Date.now(),
    detail: table(theme, groups.map(([name, part]) => [name, part.rows])),
  };
}

async function optional(
  theme: Theme,
  name: string,
  fn: () => Promise<Part | undefined>,
): Promise<[string, Part] | undefined> {
  try {
    const part = await fn();
    if (!part) return undefined;
    return [name, { short: theme.fg("dim", `${name}: ${part.short}`), rows: part.rows }];
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return [name, { short: theme.fg("dim", `${name}: ?`), rows: [{ window: "", left: "?", resets: message }] }];
  }
}

function table(theme: Theme, groups: Array<[string, UsageRow[]]>): string {
  if (groups.length === 0) return theme.fg("dim", "No signed-in providers.");
  const labeled = groups.map(([provider, group]) => {
    const nameRow = Math.floor((group.length - 1) / 2);
    return group.map((row, index) => ({ ...row, provider: index === nameRow ? provider : "" }));
  });
  const rows = labeled.flat();
  const gap = "    ";
  const providerWidth = Math.max("Provider".length, ...rows.map((row) => row.provider.length)) + 6;
  const hasWindow = (row: (typeof rows)[number]) => Boolean(row.window && row.window !== "-");
  const windowRows = rows.filter(hasWindow);
  const amountWidth = Math.max(1, ...windowRows.map((row) => row.left.length));
  const labelWidth = Math.max(0, ...windowRows.map((row) => row.window.length));
  const remainingText = (row: (typeof rows)[number]) =>
    hasWindow(row) ? `${row.left.padStart(amountWidth)}, ${row.window.padEnd(labelWidth)}` : row.left;
  const n1Width = Math.max(1, ...rows.map((row) => row.time?.n1.length ?? 0));
  const n2Width = Math.max(1, ...rows.map((row) => row.time?.n2.length ?? 0));
  const timeWidth = n1Width + 1 + 1 + n2Width + 1;
  const resetWidth = Math.max("Resets in".length, timeWidth) + 6;
  const remainingWidth = Math.max("Remaining".length, ...rows.map((row) => remainingText(row).length)) + 4;
  const header = [
    center("Provider", providerWidth),
    center("Remaining", remainingWidth),
    center("Resets in", resetWidth),
  ].join(gap);
  const render = (row: (typeof rows)[number]) => {
    const time = row.time
      ? center(`${row.time.n1.padStart(n1Width)}${row.time.u1} ${row.time.n2.padStart(n2Width)}${row.time.u2}`, resetWidth)
      : center(row.resets, resetWidth);
    return [center(row.provider, providerWidth), center(remainingText(row), remainingWidth), time].join(gap);
  };
  const blocks = labeled.map((group) => group.map((row) => theme.fg("text", render(row))).join("\n"));
  const width = Math.max(header.length, ...blocks.map((block) => Math.max(...block.split("\n").map(visibleWidth))));
  const rule = theme.fg("dim", "\u2500".repeat(width));
  return [rule, theme.fg("dim", header), rule, ...blocks.flatMap((block) => [block, rule])].join("\n");
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function center(text: string, width: number): string {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
}

function leftPercent(used: number | undefined): string {
  if (used === undefined) return "-";
  const left = Math.max(0, 100 - used);
  return `${Number.isInteger(left) ? left : left.toFixed(1)}%`;
}

function apiKey(providerId: string): string | undefined {
  return credentialToken(providerId);
}

function credentialToken(providerId: string): string | undefined {
  const credential = readStoredCredential(providerId);
  if (credential?.type === "api_key" && credential.key) return credential.key;
  if (credential?.type === "oauth" && credential.access) return credential.access;
  return undefined;
}

function oauthAccess(providerId: string): string | undefined {
  const credential = readStoredCredential(providerId);
  if (credential?.type === "oauth" && credential.access) return credential.access;
  return undefined;
}

async function fetchDeepSeek() {
  const key = apiKey("deepseek");
  if (!key) return undefined;
  const body = await getJson("https://api.deepseek.com/user/balance", {
    Authorization: `Bearer ${key}`,
  });
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const info = infos.find((item) => isRecord(item) && item.currency === "USD") ?? infos[0];
  if (!isRecord(info) || typeof info.total_balance !== "string") {
    throw new Error("balance response missing total_balance");
  }
  const currency = info.currency === "CNY" ? "¥" : "$";
  const value = `${currency}${info.total_balance}`;
  return {
    short: value,
    rows: [{ window: "", left: value, resets: "-" }],
  };
}

async function fetchXai() {
  const token = oauthAccess("xai");
  if (!token) return undefined;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const user = await getJson("https://cli-chat-proxy.grok.com/v1/user", headers);
  const userId = typeof user.userId === "string" ? user.userId : undefined;
  if (!userId) throw new Error("could not resolve account for billing");
  const billing = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    ...headers,
    "x-userid": userId,
  });
  const config = isRecord(billing.config) ? billing.config : undefined;
  const period = isRecord(config?.currentPeriod) ? config.currentPeriod : undefined;
  const end = typeof period?.end === "string"
    ? period.end
    : typeof config?.billingPeriodEnd === "string"
      ? config.billingPeriodEnd
      : undefined;
  // proto3 omits a zero creditUsagePercent. A period without it is 0% used, not a failed read.
  const percent = numberField(config?.creditUsagePercent) ?? (end ? 0 : undefined);
  if (percent === undefined) throw new Error("billing response missing credit usage");
  const shown = leftPercent(percent);
  const window = period?.type === "USAGE_PERIOD_TYPE_WEEKLY"
    ? "Weekly"
    : period?.type === "USAGE_PERIOD_TYPE_MONTHLY"
      ? "Monthly"
      : "";
  return {
    short: shown,
    rows: [{ window, left: shown, ...timed(end) }],
  };
}

async function fetchOpenCodeGo() {
  const key = apiKey("opencode-go");
  if (!key) return undefined;
  const body = await getJson("https://opencode.ai/zen/go/v1/usage", {
    Authorization: `Bearer ${key}`,
    "User-Agent": USER_AGENT,
  });
  const usage = isRecord(body.usage) ? body.usage : body;
  const monthly = isRecord(usage.monthly) ? usage.monthly : undefined;
  const weekly = isRecord(usage.weekly) ? usage.weekly : undefined;
  const rolling = isRecord(usage.rolling) ? usage.rolling : undefined;
  const percent = numberField(monthly?.percent);
  if (percent === undefined) throw new Error("usage response missing monthly percent");
  const rows: UsageRow[] = [];
  if (rolling) rows.push({ window: "Rolling", left: leftPercent(numberField(rolling.percent)), ...timed(rolling.resetsAt) });
  if (weekly) rows.push({ window: "Weekly", left: leftPercent(numberField(weekly.percent)), ...timed(weekly.resetsAt) });
  rows.push({ window: "Monthly", left: leftPercent(percent), ...timed(monthly?.resetsAt) });
  return {
    short: leftPercent(percent),
    rows,
  };
}

async function fetchZai(providerId: string, origin: string) {
  const token = credentialToken(providerId);
  if (!token) return undefined;
  const body = await getJson(`${origin}/api/monitor/usage/quota/limit`, {
    Authorization: token,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  const data = isRecord(body.data) ? body.data : body;
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const rows: UsageRow[] = [];
  for (const raw of limits) {
    if (!isRecord(raw) || raw.type === "TIME_LIMIT") continue;
    const used = numberField(raw.percentage);
    if (used === undefined) continue;
    const window = raw.unit === 6 ? "Weekly" : raw.unit === 3 ? "5h" : "Window";
    rows.push({ window, left: leftPercent(used), ...timed(raw.nextResetTime) });
  }
  if (rows.length === 0) throw new Error("usage response had no quota");
  if (rows.length === 1) rows[0].window = "";
  return { short: rows[rows.length - 1].left, rows };
}

async function fetchKimi() {
  const token = credentialToken("kimi-coding");
  if (!token) return undefined;
  const body = await getJson("https://api.kimi.com/coding/v1/usages", {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  const usages = isRecord(body.usages) ? body.usages : undefined;
  const rows: UsageRow[] = [];
  for (const [window, raw] of [
    ["5h", usages?.limit_5h],
    ["Weekly", usages?.limit_week],
    ["Monthly", usages?.limit_month_total],
  ] as const) {
    if (!isRecord(raw) || numberField(raw.used_ratio) === undefined) continue;
    rows.push({ window, left: leftPercent((numberField(raw.used_ratio) ?? 0) * 100), ...timed(raw.reset_time) });
  }
  if (rows.length === 0) throw new Error("usage response had no quota");
  if (rows.length === 1) rows[0].window = "";
  return { short: rows[0].left, rows };
}

async function fetchMoonshot(providerId: string, origin: string, symbol: string) {
  const token = credentialToken(providerId);
  if (!token) return undefined;
  const body = await getJson(`${origin}/v1/users/me/balance`, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  if (body.code !== 0 || body.status !== true) throw new Error("balance request rejected");
  const data = isRecord(body.data) ? body.data : undefined;
  const available = data ? numberField(data.available_balance) : undefined;
  if (available === undefined) throw new Error("balance response missing available_balance");
  const value = `${symbol}${available}`;
  return { short: value, rows: [{ window: "", left: value, resets: "-" }] };
}

function timed(value: unknown): { resets: string; time?: TimeParts } {
  return reset(value);
}

function parseWhen(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function reset(value: unknown): { resets: string; time?: TimeParts } {
  const date = parseWhen(value);
  if (!date) return { resets: "unknown" };
  const remainingMs = date.getTime() - Date.now();
  return {
    resets: remainingMs <= 0 ? "now" : "",
    time: remainingMs <= 0 ? undefined : timeParts(remainingMs),
  };
}

function timeParts(ms: number): TimeParts {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return { n1: String(days), u1: "d", n2: String(hours), u2: "h" };
  return { n1: String(hours), u1: "h", n2: String(minutes), u2: "m" };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!isRecord(body)) throw new Error("response was not an object");
  return body;
}
