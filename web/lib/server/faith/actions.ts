import "server-only";
import { PURPOSE_LABEL, flagOf, purposeAllowed } from "@/lib/deployment";
import { deployment } from "../chain";
import { ApiError } from "../api";
import { ledgerView } from "../ledger/view";
import { notional, retireFeeOf, tradeBpsOf } from "@/lib/ledger/engine";
import type { Ctx } from "./tools";

/// 費思可以**提議**的動作。這一支檔案是那條界線。
///
/// 使用者選擇了「全權代操，每筆仍跳 passkey」。要讓那個選擇成立，有一件事必須先講清楚：
/// **作業系統的 passkey 視窗上看不到金額、對手與數量。** 它只會問「要用 Face ID 確認嗎」。
/// 所以如果簽章視窗是唯一的關卡，那個關卡實際上在問的是「你信不信任剛才那段對話」——
/// 而使用者無從核對。真正有意義的那一關是**簽章之前的確認卡**，上面是伺服器端
/// 重新算出來的數量、單價、總價、手續費與對手。這支檔案負責產生它。
///
/// 三條規則，缺一不可：
///
/// 1. **模型不產生 calldata，也不產生地址。** 它只能給一個白名單裡的動作名稱，
///    加上純量參數（數量、價格、訂單編號）。要簽的 EIP-712 訊息一律由 /api/ledger 組，
///    這裡只給欄位。模型被注入時，它能表達的最壞情況是
///    「用錯的數字買一張真實存在的單」，而不是「把錢轉到某個地址」。
/// 2. **沒有轉帳這個動作。** 白名單裡沒有任何「把資產送到任意地址」的項目。
///    這是刻意的缺口：註冊了它，上面那條防線就沒有意義了。
/// 3. **確認時重算一次。** 從提議到按下確認之間，掛單可能被別人吃掉、價格可能變。
///    預覽的每個數字都在確認的那一刻重新從帳本讀，對不上就擋下來。

export type ActionKind =
  | "navigate"
  | "claim_faucet"
  | "buy_listing"
  | "place_bid"
  | "cancel_bid"
  | "sell_batch"
  | "retire"
  | "manage_identity";

/// 白名單本身。**清單以外的名字一律不重試**——見 /api/faith 的說明。
export const ACTION_KINDS = [
  "navigate", "claim_faucet", "buy_listing", "place_bid", "cancel_bid", "sell_batch", "retire", "manage_identity",
] as const satisfies readonly ActionKind[];

export const isActionKind = (k: string): k is ActionKind =>
  (ACTION_KINDS as readonly string[]).includes(k);

export type Preview = {
  kind: ActionKind;
  /// 一句話說這是什麼。確認卡的標題。
  title: string;
  /// 逐項對照。使用者真正要核對的就是這幾行，所以每一行都要是**具體的數字**，
  /// 不是「依市價」這種看起來像答案、其實沒有告訴你任何事的字。
  rows: { label: string; value: string; emphasis?: boolean }[];
  /// 按下去之前必須知道的、不可逆或會扣錢的部分。
  warnings: string[];
  /// 不需要簽章的動作（例如換頁）在這裡給目的地，前端直接導過去。
  href?: string;
  /// 要使用者簽的那一筆帳本事件（交給 /api/ledger 的 prepare → CAFECA 簽 → submit）。
  /// 只有純量欄位；nonce 與要簽的 typed data 由 /api/ledger 在 prepare 時才組，前端不自己組。
  ledger?: { kind: "place" | "cancel" | "retire"; fields: Record<string, string | number> };
  /// 領水：領到之後直接存進帳本合約
  deposit?: string;
};

const twd = (raw: bigint) => `${(Number(raw) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} mTWD`;
const tonnes = (kg: number | bigint) => `${(Number(kg) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 公噸`;

function need(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError("INVALID_PARAM", `${name} 要是大於 0 的數字`, { param: name });
  return n;
}

/// 每一個動作：驗參數 → 讀帳本現況 → 算出人看得懂的預覽 → 給出要簽的欄位。
/// 讀現況這一步不能省：它同時是「這張單還在嗎」的檢查，也是預覽裡那些數字的來源。
export async function buildAction(kind: ActionKind, p: Record<string, unknown>, ctx: Ctx): Promise<Preview> {
  const me = ctx.address;
  switch (kind) {
    case "navigate": {
      const path = String(p.path ?? "");
      // 只准站內的絕對路徑。少了這一行，被注入的模型就能把使用者導到站外的釣魚頁，
      // 而畫面上那顆按鈕看起來跟其他按鈕一模一樣。
      if (!/^\/[A-Za-z0-9\-/_]*$/.test(path)) throw new ApiError("INVALID_PARAM", "只能導向本站頁面", { param: "path" });
      return { kind, title: `前往 ${path}`, rows: [], warnings: [], href: path };
    }

    case "manage_identity": {
      if (!me) throw new ApiError("UNAUTHENTICATED", "要先登入");
      // 掛失、加／撤裝置、恢復——全部在 CAFECA 錢包裡做，本站只能把人帶過去。
      //
      // 這不是功能缺漏，是刻意的邊界：本站是一個交易所。一個能凍結任何人身分的
      // 交易所，就是一個能凍結任何人身分的交易所，不管它承諾不會這麼做。
      return {
        kind, title: "到 CAFECA 管理我的身分",
        rows: [
          { label: "帳戶", value: me },
          { label: "可以做的", value: "掛失、加入或撤銷裝置、發動或否決恢復" },
        ],
        warnings: ["這些都在 CAFECA 錢包裡操作。本站沒有能力替你執行，也不該有。"],
        href: "/account",
      };
    }
    default:
      return buildLedgerAction(kind, p, ctx);
  }
}

// ── 帳本動作 ──
//
// 模型只給動作名稱與純量；**要簽的內容由 /api/ledger 組**（這裡只給欄位）；
// 確認時重算——這裡的每個數字都從帳本現在的狀態讀。使用者簽的是一則 EIP-712 委託單，
// CAFECA 錢包會把每個欄位攤開給他核對，所以確認卡上的數字要和那些欄位一一對得上。

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

function buildLedgerAction(kind: ActionKind, p: Record<string, unknown>, ctx: Ctx): Preview {
  const me = ctx.address;
  if (!me) throw new ApiError("UNAUTHENTICATED", "要先登入");
  const { state: s } = ledgerView();
  const a = me.toLowerCase();
  const cash = s.cash.get(a) ?? 0n;
  const batchLabel = (batchId: bigint) => {
    const b = s.batches.get(String(batchId));
    const pr = b ? s.projects.get(String(b.projectId)) : undefined;
    return `#${batchId}　${flagOf(pr?.country ?? "")} ${pr?.country ?? ""}　${pr?.name ?? ""}　${b?.vintageYear ?? ""}`;
  };
  const held = (batchId: bigint) => s.credits.get(a)?.get(String(batchId)) ?? 0n;
  const countryOf = (batchId: bigint) => s.projects.get(String(s.batches.get(String(batchId))?.projectId ?? 0n))?.country ?? "";

  switch (kind) {
    case "navigate":
    case "manage_identity":
      break; // buildAction 已處理
    case "claim_faucet": {
      if (deployment().settlementMintable !== true) throw new ApiError("FORBIDDEN", "這條鏈上的結算幣不是本站發行的，沒有鑄幣權。請改由發行方入金。");
      const amount = 100_000n * 10n ** 6n;
      return {
        kind, title: "領取測試用 mTWD 並存進帳本",
        rows: [{ label: "帳戶", value: me }, { label: "數量", value: twd(amount) }, { label: "存入後帳本餘額", value: twd(cash + amount), emphasis: true }],
        warnings: ["mTWD 是模擬的結算幣，沒有任何實際價值。", "存入是一筆鏈上交易（轉進帳本合約託管），gas 由平台贊助。"],
        deposit: amount.toString(),
      };
    }

    case "buy_listing": {
      const seq = BigInt(Math.trunc(need(p.orderId, "orderId")));
      const o = s.book.get(String(seq));
      if (!o || o.side !== "sell" || o.remainingKg === 0n || o.expiry <= BigInt(nowSec())) {
        throw new ApiError("ORDER_INACTIVE", `帳本第 ${seq} 號賣單已經不在了（被買走、撤單或到期）。`, { orderId: Number(seq) });
      }
      if (o.account.toLowerCase() === a) throw new ApiError("INVALID_PARAM", "這是你自己的賣單。", { orderId: Number(seq) });
      const kg = BigInt(Math.min(Number(o.remainingKg), Math.max(1, Math.round(need(p.tonnes, "tonnes") * 1000))));
      if (o.minFillKg > 0n && kg < o.minFillKg && kg !== o.remainingKg) {
        throw new ApiError("INVALID_PARAM", `這張單的最小成交量是 ${tonnes(o.minFillKg)}，買不了 ${tonnes(kg)}。`, { param: "tonnes", minFillKg: Number(o.minFillKg) });
      }
      const cost = notional(kg, o.pricePerTonne);
      return {
        kind, title: `買進 ${tonnes(kg)}`,
        rows: [
          { label: "賣單", value: `帳本第 ${seq} 號　批次 ${batchLabel(o.batchId)}` },
          { label: "數量", value: tonnes(kg) },
          { label: "單價", value: `${twd(o.pricePerTonne)} / 公噸` },
          { label: "你要付（最多）", value: twd(cost), emphasis: true },
          { label: "帳本餘額", value: `${twd(cash)} → ${twd(cash - cost)}` },
        ],
        warnings: [
          ...(cash < cost ? [`帳本裡的結算幣不夠：你有 ${twd(cash)}，這筆要 ${twd(cost)}。先存入結算幣。`] : []),
          "你簽的是一張同批次、同價格的買單，由帳本撮合；手續費由賣方負擔。",
          "那張賣單若在你簽署之前被別人買走，沒成交的部分會以同價掛著一小時（期間你可以撤單），之後自動失效。",
        ],
        ledger: { kind: "place", fields: { side: "buy", batchId: o.batchId.toString(), country: "", amountKg: kg.toString(), pricePerTonne: o.pricePerTonne.toString(), minFillKg: "0", expiry: nowSec() + 3600 } },
      };
    }

    case "place_bid": {
      const kg = BigInt(Math.round(need(p.tonnes, "tonnes") * 1000));
      const pricePerTonne = BigInt(Math.round(need(p.pricePerTonne, "pricePerTonne") * 1e6));
      const c = String(p.country ?? "").toUpperCase();
      // 帳本裡不指定批次的買單一定要指定核發國（收單 API 的規則）：國外額度的用途受限，不能讓人不小心買到
      const country = !c || c === "ANY" ? "TW" : c;
      if (!/^[A-Z]{2}$/.test(country)) throw new ApiError("INVALID_COUNTRY", "country 要是兩碼國別", { param: "country" });
      const j = s.jurisdictions.get(country);
      if (!j || !j.enabled) throw new ApiError("INVALID_COUNTRY", `${country} 目前沒有開放交易`, { param: "country" });
      const lock = notional(kg, pricePerTonne);
      return {
        kind, title: `掛買單 ${tonnes(kg)}`,
        rows: [
          { label: "核發國", value: `${flagOf(country)} ${country}${!c || c === "ANY" ? "（沒有指定，預設國內額度）" : ""}` },
          { label: "數量", value: tonnes(kg) },
          { label: "出價", value: `${twd(pricePerTonne)} / 公噸` },
          { label: "現在在帳本裡鎖住", value: twd(lock), emphasis: true },
          { label: "帳本餘額", value: `${twd(cash)} → ${twd(cash - lock)}` },
          { label: "有效期限", value: "30 日" },
        ],
        warnings: [
          ...(cash < lock ? [`帳本裡的結算幣不夠：你有 ${twd(cash)}，這筆要鎖 ${twd(lock)}。`] : []),
          "錢會**當場**在帳本裡鎖住，直到成交、撤單或到期為止。撤單會全額退回。",
        ],
        ledger: { kind: "place", fields: { side: "buy", batchId: "0", country, amountKg: kg.toString(), pricePerTonne: pricePerTonne.toString(), minFillKg: "0", expiry: nowSec() + 30 * DAY } },
      };
    }

    case "cancel_bid": {
      // 帳本裡買單與賣單共用序號，撤哪一種都用這一個動作
      const seq = BigInt(Math.trunc(need(p.bidId ?? p.orderId, "bidId")));
      const o = s.book.get(String(seq));
      if (!o || o.remainingKg === 0n) throw new ApiError("ORDER_INACTIVE", `帳本第 ${seq} 號委託已經不在了。`, { bidId: Number(seq) });
      if (o.account.toLowerCase() !== a) throw new ApiError("FORBIDDEN", "這不是你的委託。");
      return {
        kind, title: `撤掉${o.side === "buy" ? "買單" : "賣單"}（帳本第 ${seq} 號）`,
        rows: [
          { label: "剩餘數量", value: tonnes(o.remainingKg) },
          { label: "退回", value: o.side === "buy" ? twd(o.locked) : `${tonnes(o.remainingKg)} 額度`, emphasis: true },
        ],
        warnings: [],
        ledger: { kind: "cancel", fields: { orderSeq: seq.toString() } },
      };
    }

    case "sell_batch": {
      const batchId = BigInt(Math.trunc(need(p.batchId, "batchId")));
      const have = held(batchId);
      if (have === 0n) throw new ApiError("INVALID_PARAM", `你沒有可動用的批次 #${batchId}。`, { param: "batchId", batchId: Number(batchId) });
      const kg = BigInt(Math.min(Number(have), Math.round(need(p.tonnes, "tonnes") * 1000)));
      const pricePerTonne = BigInt(Math.round(need(p.pricePerTonne, "pricePerTonne") * 1e6));
      const gross = notional(kg, pricePerTonne);
      const feeBps = tradeBpsOf(s, countryOf(batchId));
      return {
        kind, title: `上架批次 #${batchId} ${tonnes(kg)}`,
        rows: [
          { label: "批次", value: batchLabel(batchId) },
          { label: "你可動用", value: tonnes(have) },
          { label: "這次上架", value: tonnes(kg) },
          { label: "開價", value: `${twd(pricePerTonne)} / 公噸` },
          { label: `全部賣出可得（扣手續費 ${Number(feeBps) / 100}%）`, value: twd(gross - (gross * feeBps) / 10_000n), emphasis: true },
          { label: "有效期限", value: "30 日" },
        ],
        warnings: [
          "上架不是賣出：要有人來買才成交；簿子上已經有出價不低於你開價的買單的話，會當場成交。",
          "上架期間這些額度在帳本裡鎖住，撤單或到期就退回。",
        ],
        ledger: { kind: "place", fields: { side: "sell", batchId: batchId.toString(), country: "", amountKg: kg.toString(), pricePerTonne: pricePerTonne.toString(), minFillKg: "0", expiry: nowSec() + 30 * DAY } },
      };
    }

    case "retire": {
      const batchId = BigInt(Math.trunc(need(p.batchId, "batchId")));
      const purpose = Math.trunc(Number(p.purpose ?? -1));
      if (!(purpose >= 0 && purpose < PURPOSE_LABEL.length)) {
        throw new ApiError("INVALID_PARAM", `purpose 要是 0–${PURPOSE_LABEL.length - 1}：${PURPOSE_LABEL.map((l, i) => `${i}=${l}`).join("、")}`, { param: "purpose" });
      }
      const beneficiary = String(p.beneficiary ?? "").trim();
      if (!beneficiary) throw new ApiError("MISSING_PARAM", "註銷一定要指名受益人——憑證上會載明，而且不能改。", { param: "beneficiary" });
      const have = held(batchId);
      if (have === 0n) throw new ApiError("INVALID_PARAM", `你沒有可動用的批次 #${batchId}。`, { param: "batchId", batchId: Number(batchId) });
      const kg = BigInt(Math.min(Number(have), Math.round(need(p.tonnes, "tonnes") * 1000)));
      const country = countryOf(batchId);
      const allowed = purposeAllowed(s.jurisdictions.get(country)?.purposeMask ?? 0, purpose);
      const fee = retireFeeOf(s, country, kg);
      return {
        kind, title: `註銷 ${tonnes(kg)}`,
        rows: [
          { label: "批次", value: batchLabel(batchId) },
          { label: "數量", value: tonnes(kg), emphasis: true },
          { label: "用途", value: PURPOSE_LABEL[purpose] },
          { label: "受益人", value: beneficiary },
          { label: "註銷手續費", value: twd(fee) },
        ],
        warnings: [
          ...(allowed ? [] : [`${country} 核發的額度不允許用於「${PURPOSE_LABEL[purpose]}」。換一個用途，或換一批額度。`]),
          ...(cash < fee ? [`帳本裡的結算幣不夠付註銷手續費（${twd(fee)}）。`] : []),
          "**註銷不可逆。** 這些額度會永久退出流通，不能再轉讓、也不能再被任何人主張。",
          "受益人與用途會寫進憑證，之後改不了。憑證要等下一期承諾上鏈才定稿（最長一小時）。",
        ],
        ledger: { kind: "retire", fields: { batchId: batchId.toString(), amountKg: kg.toString(), beneficiary, purpose, memo: String(p.memo ?? "").slice(0, 200) } },
      };
    }
  }
  throw new ApiError("UNSUPPORTED_ACTION", `不支援的動作：${kind}`, { kind });
}

/// 給模型看的動作說明。**只有這些**——清單以外的事情費思只能解釋與導航。
export const ACTION_CATALOG = `
可提議的動作（propose_action 的 kind 與參數）：
- navigate {path}                     帶使用者去某一頁。不需要簽章。
- claim_faucet {}                     領測試用 mTWD 並存進帳本（只有本站發行結算幣的展示鏈可以）。
- buy_listing {orderId, tonnes}       買一張現有掛單。先用 order_book 取得 orderId。
- place_bid {country?, tonnes, pricePerTonne}  掛買單（錢會鎖住）。country 省略 = 國內（TW）。
- cancel_bid {bidId}                  取消自己的委託，退回鎖住的錢或額度。買單賣單共用序號，撤賣單也用這個（bidId 給 order_book 的 orderId）。
- sell_batch {batchId, tonnes, pricePerTonne}  上架自己持有的批次。
- retire {batchId, tonnes, purpose, beneficiary, memo?}  註銷。purpose 是 0–3 的整數。**不可逆**。
- manage_identity {}                  帶使用者去管理自己的 CAFECA 身分（掛失、裝置、恢復）。

pricePerTonne 的單位是 mTWD／公噸（給數字即可，例如 850）。tonnes 是公噸，可以有小數。
沒有「轉帳給某個地址」這種動作。金鑰管理（加／刪裝置、掛失、恢復）也不在這裡——
那些屬於使用者的 CAFECA 身分，本站碰不到，只能用 manage_identity 把人帶過去。
`.trim();
