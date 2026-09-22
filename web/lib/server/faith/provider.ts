import "server-only";

/// 費思的模型呼叫層。**只有這一支檔案知道我們在跟哪一家 LLM 說話。**
///
/// 為什麼要抽這一層：模型供應商會換（換廠商、換自架、換版本），而換的時候
/// 不該動到工具定義、系統提示或前端。上面那三樣是產品，這一支是接線。
///
/// 兩種介面都支援，由環境變數決定：
///   · Anthropic Messages API —— `FAITH_API_KEY`（或 `ANTHROPIC_API_KEY`）
///   · OpenAI 相容 chat/completions —— `FAITH_API_KEY` + `FAITH_BASE_URL`
/// 自架閘道器多半是後者的形狀，所以只要給 base URL 就接得上，不必改程式。
///
/// **沒設金鑰不是錯誤。** 這是一個展示站，多數人 clone 下來不會有金鑰；
/// 那時候費思要明白地說「未啟用」並退場，而不是每一頁都跳一則 500。

export type FaithTool = {
  name: string;
  description: string;
  /// JSON Schema（兩種供應商都吃這個形狀）
  parameters: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; id: string; name: string; content: string };

export type Reply = { text: string; toolCalls: ToolCall[] };

const KEY = process.env.FAITH_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || "";
const BASE = process.env.FAITH_BASE_URL || "";
const MODEL = process.env.FAITH_MODEL || "claude-sonnet-4-5";
/// OpenAI 相容端點有 base URL 就走它；否則走 Anthropic 原生。
const KIND: "anthropic" | "openai" | null = !KEY ? null : BASE ? "openai" : "anthropic";

export const faithEnabled = () => KIND !== null;

/// 未啟用時要顯示的那句話。寫在這裡而不是前端，因為原因只有伺服器知道。
export const disabledReason =
  "費思還沒啟用：請在 web/.env.local 設定 FAITH_API_KEY（自架或 OpenAI 相容端點再加 FAITH_BASE_URL）。" +
  "沒有金鑰時本站其餘功能完全不受影響。";

/// 逾時要自己管：模型卡住時，沒有 timeout 的 fetch 會一路等到前端放棄，
/// 而使用者看到的是一個永遠轉圈的對話框，不知道該不該再問一次。
const TIMEOUT_MS = Number(process.env.FAITH_TIMEOUT_MS ?? 60_000);

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      // 把供應商的原文留在伺服器 log，但**不要**原封不動丟給使用者：
      // 那裡面可能含端點位址、組織 id、配額細節。
      console.error(`[faith] ${r.status} ${text.slice(0, 500)}`);
      throw new Error(
        r.status === 401 || r.status === 403 ? "費思的模型金鑰被拒絕了，請確認 FAITH_API_KEY。"
        : r.status === 429 ? "費思現在太忙（模型端限流），過一下再問一次。"
        : "費思暫時無法回應，請稍後再試。",
      );
    }
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("費思想太久了，請把問題問得更具體一點再試一次。");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ───────────────────────── Anthropic ─────────────────────────

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function toAnthropic(turns: Turn[]) {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      const blocks: unknown[] = [];
      if (t.content) blocks.push({ type: "text", text: t.content });
      for (const c of t.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks });
    } else {
      // 工具結果在 Anthropic 這邊是 user 回合裡的一個 block。
      const prev = out[out.length - 1];
      const block = { type: "tool_result", tool_use_id: t.id, content: t.content };
      if (prev && prev.role === "user" && Array.isArray(prev.content)) (prev.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

async function anthropic(system: string, turns: Turn[], tools: FaithTool[]): Promise<Reply> {
  const j = await post("https://api.anthropic.com/v1/messages",
    { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    {
      model: MODEL, max_tokens: 1400, system,
      messages: toAnthropic(turns),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    });
  const blocks = (j.content ?? []) as AnthropicBlock[];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim(),
    toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => {
      const u = b as { id: string; name: string; input: Record<string, unknown> };
      return { id: u.id, name: u.name, args: u.input ?? {} };
    }),
  };
}

// ───────────────────────── OpenAI 相容 ─────────────────────────

function toOpenAI(system: string, turns: Turn[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      out.push({
        role: "assistant", content: t.content || null,
        ...(t.toolCalls?.length
          ? { tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: t.id, content: t.content });
  }
  return out;
}

async function openai(system: string, turns: Turn[], tools: FaithTool[]): Promise<Reply> {
  const j = await post(`${BASE.replace(/\/$/, "")}/chat/completions`,
    { authorization: `Bearer ${KEY}` },
    {
      model: MODEL, max_tokens: 1400, messages: toOpenAI(system, turns),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    });
  const m = j.choices?.[0]?.message ?? {};
  return {
    text: (m.content ?? "").trim(),
    toolCalls: (m.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => {
      let args: Record<string, unknown> = {};
      // 模型偶爾會吐出不合法的 JSON。當成「沒帶參數」讓工具自己去驗，
      // 比整個對話因為一個逗號而 500 好。
      try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
      return { id: c.id, name: c.function.name, args };
    }),
  };
}

export function chat(system: string, turns: Turn[], tools: FaithTool[]): Promise<Reply> {
  if (KIND === "anthropic") return anthropic(system, turns, tools);
  if (KIND === "openai") return openai(system, turns, tools);
  throw new Error(disabledReason);
}
