import { AzureOpenAI, OpenAI } from "openai";
import type { z } from "zod";
import { now } from "../clock";
import { config } from "../config";
import { getDb } from "../db";

/*
 * The only place that talks to the AI service. Everything here is optional:
 * every caller has deterministic built-in text to fall back to, so a missing key,
 * a timeout, a bad response, the daily budget or the circuit breaker all just
 * mean "use the built-in text".
 */

export interface ChatClient {
  chat: { completions: { create: (body: Record<string, unknown>, opts?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }) => Promise<unknown> } };
}

interface Provider {
  client: ChatClient;
  model: string;
  label: string;
}

const g = globalThis as unknown as {
  __gpAi?: { provider: Provider | null | undefined; failures: number; openUntil: number; last: "ok" | "fail" | null; testClient?: ChatClient | null };
};
const state = (g.__gpAi ??= { provider: undefined, failures: 0, openUntil: 0, last: null });

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

function isPlaceholder(v: string | undefined): boolean {
  return !v || v.trim() === "" || /your-|placeholder|xxxx/i.test(v);
}

function buildProvider(): Provider | null {
  if (state.testClient !== undefined) return state.testClient ? { client: state.testClient, model: "test-model", label: "test" } : null;
  if (config.aiDisabled) return null;
  const { AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_VERSION, OPENAI_API_KEY, OPENAI_MODEL } = process.env;
  if (!isPlaceholder(AZURE_OPENAI_API_KEY) && !isPlaceholder(AZURE_OPENAI_ENDPOINT) && AZURE_OPENAI_DEPLOYMENT) {
    const client = new AzureOpenAI({
      apiKey: AZURE_OPENAI_API_KEY,
      endpoint: AZURE_OPENAI_ENDPOINT,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: AZURE_OPENAI_VERSION || "2025-01-01-preview",
      maxRetries: 0,
      timeout: config.aiTimeoutMs,
    });
    return { client: client as unknown as ChatClient, model: AZURE_OPENAI_DEPLOYMENT, label: `Azure OpenAI (${AZURE_OPENAI_DEPLOYMENT})` };
  }
  if (!isPlaceholder(OPENAI_API_KEY)) {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY, maxRetries: 0, timeout: config.aiTimeoutMs });
    const model = OPENAI_MODEL || "gpt-4o-mini";
    return { client: client as unknown as ChatClient, model, label: `OpenAI (${model})` };
  }
  return null;
}

function provider(): Provider | null {
  if (state.provider === undefined) state.provider = buildProvider();
  return state.provider;
}

export type NarratorState = "off" | "standby" | "online" | "degraded";

export async function aiStatus(): Promise<{ configured: boolean; state: NarratorState; label: string; breakerOpen: boolean; usedToday: number; dailyBudget: number }> {
  const p = provider();
  const breakerOpen = state.openUntil > now();
  const narrator: NarratorState = !p ? "off" : breakerOpen || state.last === "fail" ? "degraded" : state.last === "ok" ? "online" : "standby";
  return {
    configured: !!p,
    state: narrator,
    label: p?.label ?? "Built-in story (AI off)",
    breakerOpen,
    usedToday: await usageToday(),
    dailyBudget: config.aiDailyBudget,
  };
}

function dayKey(): string {
  return new Date(now()).toISOString().slice(0, 10);
}

async function usageToday(): Promise<number> {
  const row = await getDb().prepare(`SELECT count FROM counters WHERE key = ?`).get<{ count: number }>(`ai:day:${dayKey()}`);
  return row?.count ?? 0;
}

/** Reserve one AI call against the daily and per-player budgets. */
async function reserveBudget(userId: string | null): Promise<boolean> {
  const db = getDb();
  const t = now();
  return db.transaction(async () => {
    const dayK = `ai:day:${dayKey()}`;
    const day = await db.prepare(`SELECT count FROM counters WHERE key = ?`).get<{ count: number }>(dayK);
    if ((day?.count ?? 0) >= config.aiDailyBudget) return false;
    if (userId) {
      const userK = `ai:user:${userId}`;
      const u = await db.prepare(`SELECT count, window_start FROM counters WHERE key = ?`).get<{ count: number; window_start: number }>(userK);
      if (u && t - u.window_start < 3600_000 && u.count >= config.aiUserHourlyLimit) return false;
      if (!u || t - u.window_start >= 3600_000) {
        await db.prepare(`INSERT INTO counters (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`).run(userK, t);
      } else {
        await db.prepare(`UPDATE counters SET count = count + 1 WHERE key = ?`).run(userK);
      }
    }
    await db.prepare(`INSERT INTO counters (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = counters.count + 1`).run(dayK, t);
    return true;
  }, "ai-budget");
}

export type AiResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface StructuredRequest<T> {
  name: string;
  /** JSON Schema sent to the model (strict mode: every property required, no extras). */
  jsonSchema: Record<string, unknown>;
  /** Zod schema the reply must also pass on our side. */
  schema: z.ZodType<T>;
  system: string;
  user: string;
  maxTokens: number;
  userId: string | null;
  timeoutMs?: number;
}

function extractContent(resp: unknown): string | null {
  const r = resp as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
  const msg = r?.choices?.[0]?.message;
  if (!msg || msg.refusal) return null;
  return typeof msg.content === "string" ? msg.content : null;
}

export async function callStructured<T>(req: StructuredRequest<T>): Promise<AiResult<T>> {
  const p = provider();
  if (!p) return { ok: false, reason: "ai-off" };
  if (state.openUntil > now()) return { ok: false, reason: "breaker-open" };
  if (!(await reserveBudget(req.userId))) return { ok: false, reason: "budget" };

  const timeout = req.timeoutMs ?? config.aiTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    temperature: 0.8,
    max_tokens: req.maxTokens,
    response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: req.jsonSchema } },
  };
  // Hard deadline even if the transport ignores the abort signal.
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  const send = (b: Record<string, unknown>) => Promise.race([p.client.chat.completions.create(b, { timeout, maxRetries: 0, signal: controller.signal }), deadline]);
  try {
    let resp: unknown;
    try {
      resp = await send(body);
    } catch (err) {
      // Newer model families reject max_tokens; retry once with the newer parameter name.
      const msg = String((err as Error)?.message ?? "");
      if (/max_tokens/.test(msg) && /max_completion_tokens/.test(msg)) {
        delete body.max_tokens;
        body.max_completion_tokens = req.maxTokens;
        resp = await send(body);
      } else {
        throw err;
      }
    }
    const content = extractContent(resp);
    if (!content) throw new Error("empty or refused response");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("response was not JSON");
    }
    const checked = req.schema.safeParse(parsed);
    if (!checked.success) throw new Error("response failed schema validation");
    state.failures = 0;
    state.last = "ok";
    return { ok: true, data: checked.data };
  } catch (err) {
    state.failures += 1;
    state.last = "fail";
    if (state.failures >= BREAKER_THRESHOLD) {
      state.openUntil = now() + BREAKER_COOLDOWN_MS;
      state.failures = 0;
    }
    const reason = controller.signal.aborted ? "timeout" : String((err as Error)?.message ?? err).slice(0, 160);
    if (process.env.NODE_ENV !== "test") console.warn(`[glitch] AI ${req.name} fell back to built-in text: ${reason}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: pass a fake client, or null to simulate "no AI configured". */
export function __setAiClientForTests(client: ChatClient | null | undefined): void {
  state.testClient = client;
  state.provider = undefined;
  state.failures = 0;
  state.openUntil = 0;
  state.last = null;
}
