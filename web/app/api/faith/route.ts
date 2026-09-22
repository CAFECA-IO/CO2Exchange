import { chat, disabledReason, faithEnabled, type FaithTool, type Turn } from "@/lib/server/faith/provider";
import { runTool, toolSpecs, type Ctx } from "@/lib/server/faith/tools";
import { systemPrompt } from "@/lib/server/faith/prompt";
import { buildAction, isActionKind, type ActionKind } from "@/lib/server/faith/actions";
import { handle, HttpError, me } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 費思的對話端點。工具迴圈跑在**伺服器端**，不是前端。
///
/// 為什麼不讓瀏覽器直接跟模型說話：金鑰會外流（這是最明顯的一條），
/// 而且工具要讀鏈上資料與本機紀錄——那些本來就只在伺服器端有。
/// 順帶的好處是這一支是唯一的收斂點：限流、稽核、關掉費思都只改這裡。

export const maxDuration = 60;

/// 一次對話最多讓模型呼叫幾輪工具。沒有上限的話，一個壞掉的迴圈
/// 會把使用者的額度（與我們的帳單）燒光，而畫面上只是一直轉圈。
const MAX_STEPS = 6;

/// 粗糙但有效的限流。**這是一個會花錢的端點**，而展示站是公開的。
/// 記憶體版只在單一行程有效；正式環境換成 Redis 或閘道器層的限流。
const HITS = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const PER_WINDOW = Number(process.env.FAITH_RATE_PER_MIN ?? 12);
function rateLimit(key: string) {
  const now = Date.now();
  const hits = (HITS.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= PER_WINDOW) throw new HttpError(429, "問得太快了，休息一下再問。");
  hits.push(now);
  HITS.set(key, hits);
  if (HITS.size > 5000) HITS.clear(); // 別讓這張表無限長大
}

type WireTurn = { role: "user" | "assistant"; content: string };

const PROPOSE: FaithTool = {
  name: "propose_action",
  description:
    "提出一個要使用者確認的動作。你提出之後不會立刻執行——系統會重新計算金額與對手，" +
    "畫成確認卡，使用者按下確認並通過 passkey 才會送出。參數不齊就先問，不要猜。",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "動作名稱，見系統提示裡的清單。" },
      params: { type: "object", description: "該動作的參數。", additionalProperties: true },
      why: { type: "string", description: "一句話說明你為什麼挑這個標的／這些數字。會顯示在確認卡上方。" },
    },
    required: ["kind"],
  },
};

export async function POST(req: Request) {
  try {
    if (!faithEnabled()) return Response.json({ enabled: false, reply: disabledReason }, { status: 200 });

    const body = (await req.json()) as { messages?: WireTurn[]; path?: string };
    const history = (body.messages ?? []).filter((m) => typeof m.content === "string" && m.content.trim());
    if (!history.length) throw new HttpError(400, "沒有訊息");
    // 上下文長度自己管：對話越長成本越高，而十輪以前的寒暄對回答沒有幫助。
    const recent = history.slice(-12);

    const who = await me();
    const wallet = who ? await walletOf(who.email, who.id).catch(() => null) : null;
    const ctx: Ctx = {
      address: wallet?.exists ? wallet.address : undefined,
      email: who?.email, userId: who?.id,
      path: typeof body.path === "string" ? body.path.slice(0, 120) : undefined,
    };
    rateLimit(who?.email ?? req.headers.get("x-forwarded-for") ?? "anon");

    const tools = [...toolSpecs(ctx), PROPOSE];
    const turns: Turn[] = recent.map((m) => ({ role: m.role, content: m.content }));
    const used: string[] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await chat(systemPrompt(ctx), turns, tools);
      const proposal = r.toolCalls.find((c) => c.name === "propose_action");

      if (proposal) {
        // 提議就停。後面不再讓模型接著講話——它接下來會說的多半是
        // 「已經幫你買好了」，而那不是真的：使用者還沒按確認。
        const kind = String(proposal.args.kind ?? "");
        const params = (proposal.args.params ?? {}) as Record<string, unknown>;

        // 清單**以外**的名字不重試，直接停。
        //
        // 參數錯了（數量太大、掛單沒了）是可以改的，餵回去讓模型修正很合理。
        // 但一個不存在的動作名稱不是打錯字的問題：它代表模型想做的事情，
        // 這個產品沒有提供——最常見的來源是有人把指令寫進了專案名稱或備註欄，
        // 而模型照著做了。這種時候讓它重試只是給它第二次機會去繞過白名單，
        // 所以停下來、記一筆、照實告訴使用者。
        if (!isActionKind(kind)) {
          console.warn(`[faith] 白名單以外的動作被擋下：${kind} ${JSON.stringify(params).slice(0, 200)}`);
          return Response.json({
            enabled: true,
            reply: `我想做的那件事（${kind || "未命名動作"}）不在我能做的範圍內，所以沒有執行，也不會有確認卡。` +
              `我能做的只有查詢、解說，以及買賣、掛單、註銷、掛失這幾件事。` +
              `如果你沒有要求這件事，請留意：這類提議有時候來自別人寫在專案名稱或備註欄裡的文字。`,
            blocked: kind, usedTools: used,
          });
        }

        try {
          const preview = await buildAction(kind as ActionKind, params, ctx);
          return Response.json({
            enabled: true,
            reply: r.text || String(proposal.args.why ?? ""),
            // params 原樣帶回去：確認的那一刻要用它**重算**一次（見 /api/faith/act）。
            // 從畫面上的文字反推參數會很脆——文案一改就壞。
            action: { ...preview, params, why: String(proposal.args.why ?? "") },
            usedTools: used,
          });
        } catch (e) {
          // 動作組不起來（參數不對、掛單沒了、餘額不夠）不是錯誤畫面，
          // 是對話的一部分：把原因餵回去讓模型改口或改問。
          const why = e instanceof HttpError ? e.message : e instanceof Error ? e.message : String(e);
          turns.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
          turns.push({ role: "tool", id: proposal.id, name: proposal.name, content: JSON.stringify({ error: why }) });
          used.push(`propose_action(${kind})✗`);
          continue;
        }
      }

      if (!r.toolCalls.length) {
        return Response.json({ enabled: true, reply: r.text || "（沒有回應，再問一次看看）", usedTools: used });
      }

      turns.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
      for (const c of r.toolCalls) {
        used.push(c.name);
        turns.push({ role: "tool", id: c.id, name: c.name, content: await runTool(c.name, c.args, ctx) });
      }
    }

    return Response.json({
      enabled: true,
      reply: "這個問題我查了幾輪還是收斂不了。換個更具體的問法，或告訴我你想看哪一頁的資料。",
      usedTools: used,
    });
  } catch (e) { return handle(e); }
}
