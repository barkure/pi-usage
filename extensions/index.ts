import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-usage";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;

type Snapshot = {
  at: number;
  text: string;
  detail: string;
};

let cache: Snapshot | undefined;
let inflight: Promise<Snapshot> | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx, false);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx, false);
  });

  pi.registerCommand("usage", {
    description: "Refresh DeepSeek, Grok, and OpenCode Go quota",
    handler: async (_args, ctx) => {
      const snap = await refresh(ctx, true);
      ctx.ui.notify(snap.detail, "info");
    },
  });
}

async function refresh(ctx: ExtensionContext, force: boolean): Promise<Snapshot> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    ctx.ui.setStatus(STATUS_KEY, cache.text);
    return cache;
  }
  inflight ??= load().finally(() => {
    inflight = undefined;
  });
  const snap = await inflight;
  cache = snap;
  ctx.ui.setStatus(STATUS_KEY, snap.text);
  return snap;
}

async function load(): Promise<Snapshot> {
  const [deepseek, grok, go] = await Promise.all([
    safe("DS", fetchDeepSeek),
    safe("Grok", fetchGrok),
    safe("Go", fetchOpenCodeGo),
  ]);
  const parts = [deepseek, grok, go].filter((part) => part.short);
  return {
    at: Date.now(),
    text: parts.map((part) => part.short).join("  ") || "usage: no credentials",
    detail: [deepseek, grok, go].map((part) => part.detail).join("\n"),
  };
}

async function safe(name: string, fn: () => Promise<{ short: string; detail: string } | undefined>) {
  try {
    return (await fn()) ?? { short: "", detail: `${name}: not signed in` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return { short: `${name} ?`, detail: `${name}: ${message}` };
  }
}

function apiKey(providerId: string): string | undefined {
  const credential = readStoredCredential(providerId);
  if (credential?.type === "api_key" && credential.key) return credential.key;
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
  return {
    short: `DS ${currency}${info.total_balance}`,
    detail: `DeepSeek: ${currency}${info.total_balance} available (${info.granted_balance ?? "?"} granted, ${info.topped_up_balance ?? "?"} topped up)`,
  };
}

async function fetchOpenCodeGo() {
  const key = apiKey("opencode-go");
  if (!key) return undefined;
  const body = await getJson("https://opencode.ai/zen/go/v1/usage", {
    Authorization: `Bearer ${key}`,
    "User-Agent": "pi-usage/0.1.0",
  });
  const usage = isRecord(body.usage) ? body.usage : body;
  const monthly = isRecord(usage.monthly) ? usage.monthly : undefined;
  const weekly = isRecord(usage.weekly) ? usage.weekly : undefined;
  const rolling = isRecord(usage.rolling) ? usage.rolling : undefined;
  const percent = numberField(monthly?.percent);
  if (percent === undefined) throw new Error("usage response missing monthly percent");
  return {
    short: `Go ${percent}%`,
    detail: [
      `OpenCode Go monthly ${percent}%${reset(monthly?.resetsAt)}`,
      weekly ? `  weekly ${numberField(weekly.percent) ?? "?"}%${reset(weekly.resetsAt)}` : "",
      rolling ? `  5h ${numberField(rolling.percent) ?? "?"}%${reset(rolling.resetsAt)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

async function fetchGrok() {
  const token = oauthAccess("xai");
  if (!token) return undefined;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "pi-usage/0.1.0",
  };
  const user = await getJson("https://cli-chat-proxy.grok.com/v1/user", headers);
  const userId = typeof user.userId === "string" ? user.userId : undefined;
  if (!userId) throw new Error("could not resolve account for billing");
  const billing = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    ...headers,
    "x-userid": userId,
  });
  const config = isRecord(billing.config) ? billing.config : undefined;
  const percent = numberField(config?.creditUsagePercent);
  const period = isRecord(config?.currentPeriod) ? config.currentPeriod : undefined;
  const end = typeof period?.end === "string" ? period.end : undefined;
  const shown = percent === undefined ? "—" : `${percent}%`;
  return {
    short: `Grok ${shown}`,
    detail: `Grok: ${percent === undefined ? "weekly percent omitted (often 0 on this unofficial API)" : `${percent}% used`}${end ? `, resets ${end}` : ""}`,
  };
}

function reset(value: unknown): string {
  return typeof value === "string" && value ? `, resets ${value}` : "";
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
