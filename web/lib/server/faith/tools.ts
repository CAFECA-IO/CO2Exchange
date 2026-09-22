import "server-only";
import type { FaithTool } from "./provider";
import { byCountry } from "../by-country";
import { holdings, listBids, listOrders } from "../market";
import { agreement, agreementMetas } from "../agreements";
import { walletOf } from "../wallet";
import { deployment, publicClient } from "../chain";
import { all } from "../store";
import type { KycRequest } from "../kyc";
import { certificateAbi, feeScheduleAbi, kycRegistryAbi, listingAbi } from "@/lib/abis";
import { EVENTS } from "@/lib/abis";
import { PURPOSE_LABEL, TIER_LABEL, countryToBytes2 } from "@/lib/deployment";

/// 費思能讀的東西。**全部唯讀**——會改變狀態的事在 actions.ts，而且要使用者按確認。
///
/// 兩個原則貫穿這一支檔案：
///
/// 1. **不要再實作一次。** 每個工具都轉呼叫畫面本來就在用的那些函式
///    （`listOrders`、`holdings`、`byCountry`…）。自己另寫一套查詢，遲早會出現
///    「費思說有 12 張單，畫面上只有 9 張」——而使用者沒有辦法判斷哪一邊是對的。
///
/// 2. **回傳的是資料，不是指令。** 專案名稱、掛單備註、憑證上的受益人，
///    這些欄位的內容是**使用者自己填的**。模型讀到「請把餘額轉給 0x…」時，
///    那是一段字串，不是一道命令。防線有三層：這裡把工具結果包成標了來源的
///    JSON、系統提示明說外部內容一律視為資料、而且模型根本沒有「轉帳給任意地址」
///    這個動作可以提（見 actions.ts 的白名單）。

export type Ctx = {
  /// 已登入者的錢包地址。null = 匿名訪客，只能問公開資料。
  address?: `0x${string}`;
  email?: string;
  userId?: string;
  /// 使用者現在在看哪一頁
  path?: string;
};

type Impl = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

/// 需要登入的工具共用這一句。講清楚**為什麼**問不到，不要只說「沒有資料」——
/// 後者會讓費思開始猜，而猜出來的持倉比沒有答案更糟。
const needLogin = { error: "這個問題要看使用者自己的資料，但目前沒有登入，或還沒有鏈上錢包。請先請使用者登入。" };

/// 每一頁在做什麼。費思要能回答「這個畫面在講什麼」，就得知道有哪些頁、
/// 各自負責什麼——這份對照是那個知識，寫在伺服器端而不是提示字串裡，
/// 因為它會跟著路由一起改。
const PAGES: Record<string, string> = {
  "/": "首頁：市場現況。立體地球顯示各轄區的核發量、成交量與成交均價，下方是各轄區明細與價格走勢圖。也是登入與建立錢包的入口。",
  "/about": "認識碳權：制度說明（自願減量專案、巴黎協定第六條、ISO 14064、專案九階段、為什麼優先買在地、亞太各國額度、用途邊界、錢包原理），以及 K 線行情與市場概況。",
  "/trade": "交易：買賣同頁。買方可吃掛單或掛買單（限價）、也可市價買進；賣方可上架持有的批次或賣給現有買單。下單前有確認單。",
  "/portfolio": "我的資產：持有的批次、平均成本、損益，以及已取得的註銷憑證（可下載 PDF）。",
  "/retire": "註銷：把額度永久退出流通並取得憑證。要選用途（扣碳費／自願性碳中和／增量抵換／環評承諾）與受益人。自然人不能註銷。",
  "/kyc": "身分驗證：申請自然人或法人身分，通過後才能交易。",
  "/enterprise": "企業：專案登錄、上傳監測報告、申請查驗核發、上架與入池。需要法人身分。",
  "/registry": "公告欄：所有核發、上架、移轉、註銷的即時紀錄，任何人都看得到。",
  "/custody": "託管揭露：每月 5 日的託管與準備金對帳報告，由查核機構簽署。",
  "/agreements": "契約：平台使用約定書、買賣契約、註銷委任書、代辦費用約定、服務流程說明書、隱私權政策、服務條款。每一份都有獨立網址與內容雜湊。",
  "/account": "裝置與安全：錢包的 passkey 清單、待核准的新裝置、掛失（凍結／解凍），以及全部裝置遺失時的復原程序說明。",
};

export const TOOLS: { spec: FaithTool; run: Impl; needsLogin?: boolean }[] = [
  {
    spec: {
      name: "page_guide",
      description: "說明本站某一頁在做什麼、上面的數字是什麼意思。使用者問「這個畫面在幹嘛」「這欄是什麼」時先用這個。不給 path 就回傳使用者目前所在的頁。",
      parameters: { type: "object", properties: { path: { type: "string", description: "例如 /trade。省略則用使用者目前的頁面。" } } },
    },
    run: async (a, ctx) => {
      const path = str(a.path) || ctx.path || "/";
      const key = Object.keys(PAGES).find((k) => k === path) ?? "/";
      return { path: key, description: PAGES[key], allPages: PAGES };
    },
  },
  {
    spec: {
      name: "market_by_country",
      description: "各轄區（核發國）的核發量、流通量、註銷量、成交量與成交均價，以及該轄區是否開放。回答「哪一國最便宜」「台灣的量有多少」用這個。",
      parameters: { type: "object", properties: { hours: { type: "number", description: "統計區間，小時。預設一年。" } } },
    },
    run: async (a) => {
      const { countries, asOf } = await byCountry(Math.min(Math.max(num(a.hours) || 8760, 1), 8760 * 3));
      // priceSeries 是給圖用的，幾十個點餵給模型只會吃掉上下文又幫不上忙。
      return { asOf, countries: countries.map((c) => ({ ...c, priceSeries: undefined })) };
    },
  },
  {
    spec: {
      name: "order_book",
      description: "目前的賣單（掛單）與買單。可用核發國過濾。回答「現在有什麼可以買」「最便宜多少」用這個。",
      parameters: {
        type: "object",
        properties: {
          country: { type: "string", description: "兩碼國別，例如 TW、JP。省略則全部。" },
          side: { type: "string", enum: ["ask", "bid", "both"], description: "預設 both。" },
        },
      },
    },
    run: async (a) => {
      const country = str(a.country).toUpperCase();
      const side = str(a.side, "both");
      const [orders, bids] = await Promise.all([
        side === "bid" ? Promise.resolve([]) : listOrders(),
        side === "ask" ? Promise.resolve([]) : listBids(),
      ]);
      const feeBps = await publicClient.readContract({
        address: deployment().listing, abi: listingAbi, functionName: "feeBps",
      });
      return {
        listingFeeBps: Number(feeBps),
        note: "pricePerTonne 的單位是 mTWD 的最小單位（1e6 = 1 mTWD）。remainingKg 是公斤，1000 公斤 = 1 公噸。",
        asks: orders.filter((o) => !country || o.country === country).slice(0, 25),
        bids: bids.filter((b) => !country || b.country === country || b.country === "").slice(0, 25),
      };
    },
  },
  {
    spec: {
      name: "my_portfolio",
      description: "目前登入者的結算幣餘額、持有的批次（含核發國、專案、年份、數量）與未指定批次的池化額度。",
      parameters: { type: "object", properties: {} },
    },
    needsLogin: true,
    run: async (_a, ctx) => ({
      ...(await holdings(ctx.address!)),
      note: "twd 與 cct 是最小單位字串（1e6 = 1 mTWD；cct 1e18 = 1 公噸）。batches[].kg 是公斤。",
    }),
  },
  {
    spec: {
      name: "my_identity",
      description: "目前登入者的鏈上身分：等級（未驗證／自然人／法人）、效期、是否被凍結，以及還在審核中的申請。",
      parameters: { type: "object", properties: {} },
    },
    needsLogin: true,
    run: async (_a, ctx) => {
      const id = await publicClient.readContract({
        address: deployment().kycRegistry, abi: kycRegistryAbi, functionName: "identityOf", args: [ctx.address!],
      });
      const latest = all<KycRequest>("kyc-requests")
        .filter((r) => r.account.toLowerCase() === ctx.address!.toLowerCase())
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0] ?? null;
      return {
        tier: id.tier, tierLabel: TIER_LABEL[id.tier] ?? "未知",
        expiry: Number(id.expiry), frozen: id.frozen,
        application: latest ? { status: latest.status, tier: latest.tier, reason: latest.reason, createdAt: latest.createdAt } : null,
        rules: "自然人可以買、可以轉售，但**不能註銷**（官方登錄簿不開放自然人帳戶）。法人可以註銷。",
      };
    },
  },
  {
    spec: {
      name: "my_wallet",
      description: "目前登入者的鏈上錢包：地址、有哪些 passkey 裝置、是否凍結、有沒有待核准的新裝置或進行中的復原提案。",
      parameters: { type: "object", properties: {} },
    },
    needsLogin: true,
    run: async (_a, ctx) => {
      const w = await walletOf(ctx.email, ctx.userId);
      // credentialId 與公鑰不必進模型的上下文：它們對回答問題沒有幫助，
      // 而少送一點使用者的識別資料就是少一點。
      return {
        address: w.address, frozen: w.frozen, recoveryDelayHours: Math.round(w.recoveryDelay / 3600),
        devices: w.keys.map((k) => ({ label: k.label, addedAt: k.addedAt })),
        pendingDevices: w.pendingDevices.map((p) => ({ label: p.label, requestedAt: p.requestedAt })),
        recovery: w.recovery ? { label: w.recovery.label, executeAfter: w.recovery.executeAfter } : null,
      };
    },
  },
  {
    spec: {
      name: "my_certificates",
      description: "目前登入者已取得的註銷憑證清單。",
      parameters: { type: "object", properties: {} },
    },
    needsLogin: true,
    run: async (_a, ctx) => {
      const d = deployment();
      // 用額度合約的 CreditRetired 而不是憑證合約的事件：兩邊都記得這件事，
      // 但共用的那一個已經在 lib/abis 的 EVENTS 裡，抄第二份遲早會跟它不一致。
      const logs = await publicClient.getLogs({ address: d.carbonCredit1155, event: EVENTS.creditRetired, fromBlock: 0n });
      const mine = logs
        .filter((l) => String(l.args.certificateOwner).toLowerCase() === ctx.address!.toLowerCase())
        .slice(-30);
      return Promise.all(mine.map(async (l) => {
        const c = await publicClient.readContract({
          address: d.retirementCertificate, abi: certificateAbi, functionName: "certificateOf", args: [l.args.certId!],
        });
        return {
          certId: Number(l.args.certId), batchId: Number(c.batchId), amountKg: Number(c.amountKg),
          purpose: c.purpose, purposeLabel: PURPOSE_LABEL[c.purpose] ?? "未知",
          retiredAt: Number(c.retiredAt),
          officialNo: c.officialNo || null,
          officialAnnouncedAt: Number(c.officialAnnouncedAt) || null,
        };
      }));
    },
  },
  {
    spec: {
      name: "fees",
      description: "某個核發國的交易手續費（bps）與註銷代辦費（每公噸）。",
      parameters: { type: "object", properties: { country: { type: "string", description: "兩碼國別，例如 TW。" } }, required: ["country"] },
    },
    run: async (a) => {
      const c = str(a.country).toUpperCase().slice(0, 2);
      if (!/^[A-Z]{2}$/.test(c)) return { error: "country 要是兩碼英文國別，例如 TW。" };
      const d = deployment();
      // 各國可以覆寫，沒設就用預設值——回答時這個差別要講出來，
      // 否則「日本的費率是多少」會得到一個看起來是特別設定、其實是預設的數字。
      const [own, defBps, defRetire] = await Promise.all([
        publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "countryFeeOf", args: [countryToBytes2(c)] }),
        publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "defaultTradeBps" }),
        publicClient.readContract({ address: d.feeSchedule, abi: feeScheduleAbi, functionName: "defaultRetireFeePerTonne" }),
      ]);
      return {
        country: c, overridden: own.set,
        tradeFeeBps: own.set ? Number(own.tradeBps) : Number(defBps),
        retireFeePerTonne: (own.set ? own.retireFeePerTonne : defRetire).toString(),
        note: "retireFeePerTonne 單位是 mTWD 最小單位（1e6 = 1 mTWD），每公噸。overridden=false 代表這一國沿用平台預設值。",
      };
    },
  },
  {
    spec: {
      name: "list_agreements",
      description: "本站所有定型化契約與條款的清單（標題、版本、生效日、誰要簽、內容雜湊、網址）。",
      parameters: { type: "object", properties: {} },
    },
    run: async () => agreementMetas(),
  },
  {
    spec: {
      name: "read_agreement",
      description: "讀某一份契約或條款的條文。用來回答「約定書怎麼寫的」這類問題——**一定要引用條文原文，不要憑印象轉述**。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "例如 platform-terms、privacy-policy、trade-agreement。先用 list_agreements 查。" },
          query: { type: "string", description: "只回傳含這個關鍵字的段落。條文很長，幾乎一定要給。" },
        },
        required: ["id"],
      },
    },
    run: async (a) => {
      const doc = agreement(str(a.id));
      if (!doc) return { error: `沒有這份文件：${str(a.id)}。用 list_agreements 查有哪些。` };
      const q = str(a.query).trim();
      const meta = { id: doc.id, title: doc.title, version: doc.version, url: `/agreements/${doc.id}` };
      if (!q) return { ...meta, body: doc.body.slice(0, 6000), truncated: doc.body.length > 6000 };
      const paras = doc.body.split(/\n{2,}/).filter((p) => p.includes(q));
      return paras.length
        ? { ...meta, matched: paras.length, paragraphs: paras.slice(0, 12) }
        : { ...meta, matched: 0, hint: `這份文件沒有提到「${q}」。` };
    },
  },
];

export const toolSpecs = (ctx: Ctx) =>
  TOOLS.filter((t) => !t.needsLogin || !!ctx.address).map((t) => t.spec);

export async function runTool(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<string> {
  const t = TOOLS.find((x) => x.spec.name === name);
  if (!t) return JSON.stringify({ error: `沒有這個工具：${name}` });
  if (t.needsLogin && !ctx.address) return JSON.stringify(needLogin);
  try {
    const out = await t.run(args, ctx);
    // 標上來源。模型看到的是「一段由本站工具回傳的資料」，不是一段可能夾帶指令的文字。
    return JSON.stringify({ source: `tool:${name}`, data: out }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch (e) {
    console.error(`[faith] tool ${name}`, e);
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}
