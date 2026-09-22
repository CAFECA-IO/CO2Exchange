import "server-only";
import { encodeFunctionData, keccak256, toBytes, toHex, type Hex } from "viem";
import { bidWriteAbi, creditAbi, erc20Abi, erc1155ApprovalAbi, listingAbi, listingWriteAbi, registryAbi } from "@/lib/abis";
import { PURPOSE_LABEL, countryToBytes2, flagOf, purposeAllowed } from "@/lib/deployment";
import { deployment, publicClient } from "../chain";
import { holdings } from "../market";
import { HttpError } from "../roles";
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
///    加上純量參數（數量、價格、訂單編號）。合約地址一律來自部署檔，
///    calldata 一律在這裡用 ABI 編。模型被注入時，它能表達的最壞情況是
///    「用錯的數字買一張真實存在的單」，而不是「把錢轉到某個地址」。
/// 2. **沒有轉帳這個動作。** 白名單裡沒有任何「把資產送到任意地址」的項目。
///    這是刻意的缺口：註冊了它，上面那條防線就沒有意義了。
/// 3. **確認時重算一次。** 從提議到按下確認之間，掛單可能被別人吃掉、價格可能變。
///    預覽的每個數字都在確認的那一刻重新從鏈上讀，對不上就擋下來。

export type ActionKind =
  | "navigate"
  | "claim_faucet"
  | "buy_listing"
  | "place_bid"
  | "cancel_bid"
  | "sell_batch"
  | "retire"
  | "freeze_wallet";

/// 白名單本身。**清單以外的名字一律不重試**——見 /api/faith 的說明。
export const ACTION_KINDS = [
  "navigate", "claim_faucet", "buy_listing", "place_bid", "cancel_bid", "sell_batch", "retire", "freeze_wallet",
] as const satisfies readonly ActionKind[];

export const isActionKind = (k: string): k is ActionKind =>
  (ACTION_KINDS as readonly string[]).includes(k);

export type Call = { target: Hex; value: string; data: Hex };

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
  calls?: Call[];
};

const twd = (raw: bigint) => `${(Number(raw) / 1e6).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} mTWD`;
const tonnes = (kg: number | bigint) => `${(Number(kg) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 公噸`;

function need(v: unknown, name: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${name} 要是大於 0 的數字`);
  return n;
}

/// 每一個動作：驗參數 → 讀鏈上現況 → 算出人看得懂的預覽 → 編 calldata。
/// 讀鏈上現況這一步不能省：它同時是「這張單還在嗎」的檢查，
/// 也是預覽裡那些數字的來源。
export async function buildAction(kind: ActionKind, p: Record<string, unknown>, ctx: Ctx): Promise<Preview> {
  const d = deployment();
  const me = ctx.address;

  switch (kind) {
    case "navigate": {
      const path = String(p.path ?? "");
      // 只准站內的絕對路徑。少了這一行，被注入的模型就能把使用者導到站外的釣魚頁，
      // 而畫面上那顆按鈕看起來跟其他按鈕一模一樣。
      if (!/^\/[A-Za-z0-9\-/_]*$/.test(path)) throw new HttpError(400, "只能導向本站頁面");
      return { kind, title: `前往 ${path}`, rows: [], warnings: [], href: path };
    }

    case "claim_faucet": {
      if (!me) throw new HttpError(401, "要先登入");
      return {
        kind, title: "領取測試用 mTWD",
        rows: [{ label: "收款帳戶", value: me }, { label: "用途", value: "Phase 0 展示用的模擬結算幣" }],
        warnings: ["mTWD 是模擬的結算幣，沒有任何實際價值。"],
      };
    }

    case "buy_listing": {
      if (!me) throw new HttpError(401, "要先登入");
      const orderId = Math.trunc(need(p.orderId, "orderId"));
      const want = need(p.tonnes, "tonnes");
      const o = await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "orderOf", args: [BigInt(orderId)] });
      if (!o.active || o.remainingKg === 0n) throw new HttpError(409, `第 ${orderId} 號掛單已經被買走或取消了。`);
      const kg = BigInt(Math.min(Number(o.remainingKg), Math.max(1, Math.round(want * 1000))));
      if (o.minFillKg > 0n && kg < o.minFillKg) {
        throw new HttpError(400, `這張單的最小成交量是 ${tonnes(o.minFillKg)}，買不了 ${tonnes(kg)}。`);
      }
      const cost = (kg * o.pricePerTonne) / 1000n;
      const feeBps = await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "feeBps" });
      const fee = (cost * BigInt(feeBps)) / 10_000n;
      const bal = await holdings(me).then((h) => BigInt(h.twd));
      return {
        kind, title: `買進 ${tonnes(kg)}`,
        rows: [
          { label: "掛單", value: `#${orderId}　批次 #${Number(o.batchId)}` },
          { label: "數量", value: tonnes(kg) },
          { label: "單價", value: `${twd(o.pricePerTonne)} / 公噸` },
          { label: "小計", value: twd(cost) },
          { label: `手續費（${Number(feeBps) / 100}%）`, value: twd(fee) },
          { label: "你要付", value: twd(cost), emphasis: true },
          { label: "付款後餘額", value: twd(bal - cost) },
        ],
        warnings: [
          ...(bal < cost ? [`結算幣不夠：你有 ${twd(bal)}，這筆要 ${twd(cost)}。`] : []),
          "成交後額度直接進你的錢包，價金一次付清，不能反悔。",
        ],
        calls: [
          { target: d.settlementToken, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.listing, cost] }) },
          { target: d.listing, value: "0", data: encodeFunctionData({ abi: listingAbi, functionName: "buy", args: [BigInt(orderId), kg] }) },
        ],
      };
    }

    case "place_bid": {
      if (!me) throw new HttpError(401, "要先登入");
      const t = need(p.tonnes, "tonnes");
      const price = need(p.pricePerTonne, "pricePerTonne");
      const c = String(p.country ?? "").toUpperCase();
      if (c && c !== "ANY" && !/^[A-Z]{2}$/.test(c)) throw new HttpError(400, "country 要是兩碼國別或 ANY");
      const kg = BigInt(Math.round(t * 1000));
      const pricePerTonne = BigInt(Math.round(price * 1e6));
      const cost = (kg * pricePerTonne) / 1000n;
      const bal = await holdings(me).then((h) => BigInt(h.twd));
      const country = !c || c === "ANY" ? "0x0000" : toHex(c, { size: 2 });
      return {
        kind, title: `掛買單 ${tonnes(kg)}`,
        rows: [
          { label: "核發國", value: !c || c === "ANY" ? "不限" : `${flagOf(c)} ${c}` },
          { label: "數量", value: tonnes(kg) },
          { label: "出價", value: `${twd(pricePerTonne)} / 公噸` },
          { label: "現在鎖進合約", value: twd(cost), emphasis: true },
          { label: "鎖款後餘額", value: twd(bal - cost) },
        ],
        warnings: [
          ...(bal < cost ? [`結算幣不夠：你有 ${twd(bal)}，這筆要鎖 ${twd(cost)}。`] : []),
          "錢會**當場**鎖進合約，直到成交或你自己取消為止。取消會全額退回。",
        ],
        calls: [
          { target: d.settlementToken, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.listing, cost] }) },
          { target: d.listing, value: "0", data: encodeFunctionData({ abi: bidWriteAbi, functionName: "placeBid", args: [country as Hex, kg, pricePerTonne, 0n] }) },
        ],
      };
    }

    case "cancel_bid": {
      if (!me) throw new HttpError(401, "要先登入");
      const bidId = Math.trunc(need(p.bidId, "bidId"));
      const b = await publicClient.readContract({ address: d.listing, abi: listingAbi, functionName: "bidOf", args: [BigInt(bidId)] });
      if (!b.active) throw new HttpError(409, `第 ${bidId} 號買單已經不在了。`);
      if (b.buyer.toLowerCase() !== me.toLowerCase()) throw new HttpError(403, "這不是你的買單。");
      return {
        kind, title: `取消買單 #${bidId}`,
        rows: [
          { label: "剩餘數量", value: tonnes(b.remainingKg) },
          { label: "退回", value: twd((b.remainingKg * b.pricePerTonne) / 1000n), emphasis: true },
        ],
        warnings: [],
        calls: [{ target: d.listing, value: "0", data: encodeFunctionData({ abi: bidWriteAbi, functionName: "cancelBid", args: [BigInt(bidId)] }) }],
      };
    }

    case "sell_batch": {
      if (!me) throw new HttpError(401, "要先登入");
      const batchId = Math.trunc(need(p.batchId, "batchId"));
      const t = need(p.tonnes, "tonnes");
      const price = need(p.pricePerTonne, "pricePerTonne");
      const h = await holdings(me);
      const held = h.batches.find((b) => b.batchId === batchId);
      if (!held) throw new HttpError(400, `你沒有批次 #${batchId}。`);
      const kg = BigInt(Math.min(held.kg, Math.round(t * 1000)));
      const pricePerTonne = BigInt(Math.round(price * 1e6));
      return {
        kind, title: `上架批次 #${batchId} ${tonnes(kg)}`,
        rows: [
          { label: "批次", value: `#${batchId}　${flagOf(held.country)} ${held.country}　${held.project}　${held.vintageYear}` },
          { label: "你持有", value: tonnes(held.kg) },
          { label: "這次上架", value: tonnes(kg) },
          { label: "開價", value: `${twd(pricePerTonne)} / 公噸` },
          { label: "全部賣出可得（未扣手續費）", value: twd((kg * pricePerTonne) / 1000n), emphasis: true },
        ],
        warnings: [
          "上架不是賣出：要有人來買才成交，你隨時可以取消。",
          "使用期限等掛單資訊請到交易頁補填，費思不會替你決定那個日期。",
        ],
        calls: [
          { target: d.carbonCredit1155, value: "0", data: encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [d.listing, true] }) },
          { target: d.listing, value: "0", data: encodeFunctionData({ abi: listingWriteAbi, functionName: "list", args: [BigInt(batchId), kg, pricePerTonne, 0n] }) },
        ],
      };
    }

    case "retire": {
      if (!me) throw new HttpError(401, "要先登入");
      const batchId = Math.trunc(need(p.batchId, "batchId"));
      const t = need(p.tonnes, "tonnes");
      const purpose = Math.trunc(Number(p.purpose ?? -1));
      if (!(purpose >= 0 && purpose < PURPOSE_LABEL.length)) {
        throw new HttpError(400, `purpose 要是 0–${PURPOSE_LABEL.length - 1}：${PURPOSE_LABEL.map((l, i) => `${i}=${l}`).join("、")}`);
      }
      const beneficiary = String(p.beneficiary ?? "").trim();
      if (!beneficiary) throw new HttpError(400, "註銷一定要指名受益人——憑證上會載明，而且不能改。");
      const h = await holdings(me);
      const held = h.batches.find((b) => b.batchId === batchId);
      if (!held) throw new HttpError(400, `你沒有批次 #${batchId}。`);
      const kg = BigInt(Math.min(held.kg, Math.round(t * 1000)));
      // 用途 × 轄區的檢查在合約裡也會做一次，但**這裡要先做**：
      // 讓使用者在確認卡上就看到「這個轄區不允許這個用途」，
      // 而不是按下 passkey、等交易 revert、再去讀一個四位元組的錯誤。
      const mask = await publicClient
        .readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "jurisdictionOf", args: [countryToBytes2(held.country)] })
        .then((j) => j.purposeMask).catch(() => 0xff);
      const allowed = purposeAllowed(mask, purpose);
      return {
        kind, title: `註銷 ${tonnes(kg)}`,
        rows: [
          { label: "批次", value: `#${batchId}　${flagOf(held.country)} ${held.country}　${held.project}　${held.vintageYear}` },
          { label: "數量", value: tonnes(kg), emphasis: true },
          { label: "用途", value: PURPOSE_LABEL[purpose] },
          { label: "受益人", value: beneficiary },
        ],
        warnings: [
          ...(allowed ? [] : [`${held.country} 核發的額度不允許用於「${PURPOSE_LABEL[purpose]}」。換一個用途，或換一批額度。`]),
          "**註銷不可逆。** 這些額度會永久退出流通，不能再轉讓、也不能再被任何人主張。",
          "受益人與用途會寫進憑證，之後改不了。",
        ],
        calls: [{
          target: d.carbonCredit1155, value: "0",
          data: encodeFunctionData({ abi: creditAbi, functionName: "retire", args: [{
            holder: me, batchId: BigInt(batchId), amountKg: kg, certificateTo: me,
            beneficiaryHash: keccak256(toBytes(beneficiary)), beneficiary, purpose,
            memo: String(p.memo ?? ""),
          }] }),
        }],
      };
    }

    case "freeze_wallet": {
      if (!me) throw new HttpError(401, "要先登入");
      return {
        kind, title: "凍結我的錢包",
        rows: [{ label: "錢包", value: me }, { label: "效果", value: "所有交易與註銷立刻被擋下" }],
        warnings: [
          "凍結期間你仍然可以管理 passkey 裝置，並用現存的 passkey 解凍。",
          "解凍要一把還在錢包裡的 passkey——一把都不剩的話得走復原程序（72 小時）。",
        ],
        // 凍結由平台 relayer 代送，不需要使用者簽章，所以沒有 calls。
        // 前端看到 kind=freeze_wallet 就打 /api/account/freeze。
      };
    }
  }
  throw new HttpError(400, `不支援的動作：${kind}`);
}

/// 給模型看的動作說明。**只有這些**——清單以外的事情費思只能解釋與導航。
export const ACTION_CATALOG = `
可提議的動作（propose_action 的 kind 與參數）：
- navigate {path}                     帶使用者去某一頁。不需要簽章。
- claim_faucet {}                     領測試用 mTWD。
- buy_listing {orderId, tonnes}       買一張現有掛單。先用 order_book 取得 orderId。
- place_bid {country?, tonnes, pricePerTonne}  掛買單（錢會鎖進合約）。country 省略或 ANY = 不限核發國。
- cancel_bid {bidId}                  取消自己的買單，退回鎖住的錢。
- sell_batch {batchId, tonnes, pricePerTonne}  上架自己持有的批次。
- retire {batchId, tonnes, purpose, beneficiary, memo?}  註銷。purpose 是 0–3 的整數。**不可逆**。
- freeze_wallet {}                    掛失：凍結自己的錢包。

pricePerTonne 的單位是 mTWD／公噸（給數字即可，例如 850）。tonnes 是公噸，可以有小數。
沒有「轉帳給某個地址」這種動作，也沒有金鑰管理（加／刪 passkey、解凍、復原）——
那些一律請使用者自己到「裝置與安全」操作。
`.trim();
