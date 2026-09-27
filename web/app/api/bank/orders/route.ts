import type { Address, Hex } from "viem";
import { deployment, isAddress } from "@/lib/server/chain";
import { replay } from "@/lib/bank/replay";
import { append, head, nextNonce, readEvents } from "@/lib/server/bank/log-store";
import { fail, handleError, ok } from "@/lib/server/api";
import { requireRole } from "@/lib/server/roles";
import { walletOf } from "@/lib/server/wallet";

/// 下單與撤單：寫進委託單 log，回一張**簽收收據**。
///
/// 這一支不撮合、不算餘額、不碰鏈。它只做一件事：把使用者的意思表示照順序記下來，
/// 並且簽名承認「我收到了，而且放在第 N 號位置」。
///
/// 撮合是重播 log 的結果（`lib/bank/engine.ts`），不是這裡的副作用。
/// 這個分工是整個設計能被驗證的前提：log 只記輸入，其餘都是算出來的。
/// 如果這裡順手把成交寫進 log，就有兩份真相，而哪天對不上時沒有人說得出哪一份算數。
///
/// 收據為什麼重要：沒有它，雜湊鏈只證明「交易所選擇記下來的那些事情的順序」——
/// 不收某張單，鏈上看起來完美無瑕。有了它，使用者手上就有一份交易所自己簽名的承諾。
///
/// ## ⚠️ 尚未實作：簽章驗證
///
/// 這一支**收下 `signature` 並寫進 log，但沒有驗證它**。
///
/// 現在的效果是：log 裡有一個欄位叫簽章，而它證明不了任何事。
/// 意思表示的不可否認性——「這張單確實是這個帳戶下的」——目前靠的是登入的
/// session，不是簽章。對 Phase 0 的展示夠用，對「委託單是法律憑據」這個定位不夠。
///
/// 要補的是：使用者的錢包是 `PasskeyAccount`（ERC-1271），所以驗法是拿委託單的
/// 正規化位元組算 digest，呼叫帳戶合約的 `isValidSignature`。鏈上驗一次成本不低，
/// 可行的折衷是收單時在鏈下用 P-256 驗（公鑰從 `keys()` 讀得到），
/// 爭議時才在鏈上驗——兩者用同一組位元組，所以結論一致。
///
/// 在補上之前，任何對外文件都不該說「委託單經過簽章驗證」。

type Body = {
  action?: "place" | "cancel";
  side?: "buy" | "sell";
  batchId?: string;
  country?: string;
  amountKg?: string;
  pricePerTonne?: string;
  minFillKg?: string;
  expiry?: string;
  orderSeq?: string;
  nonce?: string;
  signature?: Hex;
};

const big = (v: string | undefined, d = 0n) => (v === undefined || v === "" ? d : BigInt(v));

export async function GET() {
  try {
    const m = await requireRole("user");
    const wallet = await walletOf(m.address);
    const account = wallet.address as Address;
    const h = head();
    const events = readEvents();
    const { state } = replay(events, 0n, deployment().treasury);

    const mine = [...state.book.values()]
      .filter((o) => o.account.toLowerCase() === account.toLowerCase())
      .sort((a, b) => (a.seq < b.seq ? -1 : 1));

    return ok({
      account,
      nextNonce: nextNonce(account),
      logHead: { seq: h.seq, runningHash: h.runningHash },
      orders: mine,
      fills: state.fills
        .filter((f) => f.buyer.toLowerCase() === account.toLowerCase() || f.seller.toLowerCase() === account.toLowerCase())
        .slice(-50),
    });
  } catch (e) { return handleError(e); }
}

export async function POST(req: Request) {
  try {
    const m = await requireRole("user");
    const wallet = await walletOf(m.address);
    const account = wallet.address as Address;
    if (!isAddress(account)) return fail("INVALID_ADDRESS", { details: { param: "account" } });

    const b = (await req.json()) as Body;
    const nonce = big(b.nonce);
    if (nonce <= 0n) return fail("INVALID_PARAM", { message: "要帶 nonce", details: { param: "nonce" } });
    if (!b.signature) return fail("INVALID_PARAM", { message: "要帶簽章", details: { param: "signature" } });

    if (b.action === "cancel") {
      const orderSeq = big(b.orderSeq);
      if (orderSeq <= 0n) return fail("INVALID_PARAM", { message: "要帶 orderSeq", details: { param: "orderSeq" } });
      const { event, receipt } = await append({ kind: "cancel", account, orderSeq, nonce, signature: b.signature });
      return ok({ event, receipt });
    }

    if (b.action !== "place") return fail("UNSUPPORTED_ACTION", { details: { action: b.action } });
    if (b.side !== "buy" && b.side !== "sell") {
      return fail("INVALID_PARAM", { message: "side 只能是 buy 或 sell", details: { param: "side" } });
    }

    const amountKg = big(b.amountKg);
    const pricePerTonne = big(b.pricePerTonne);
    if (amountKg <= 0n || pricePerTonne <= 0n) {
      return fail("INVALID_PARAM", { message: "數量與價格要大於零" });
    }

    const { event, receipt } = await append({
      kind: "place",
      account,
      side: b.side,
      batchId: big(b.batchId),
      country: (b.country ?? "TW").slice(0, 2),
      amountKg,
      pricePerTonne,
      minFillKg: big(b.minFillKg),
      nonce,
      // 沒帶期限就給 30 日——交易拍賣及移轉管理辦法 §12①⑤ 的定價交易期間下限。
      expiry: big(b.expiry) || BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
      signature: b.signature,
    });

    // 寫下去之後立刻重播一次，回報這張單現在的狀態。
    // **重播是唯一的真相來源**——不在這裡另外算一份「剛剛成交了多少」。
    const { state } = replay(readEvents(), 0n, deployment().treasury);
    const rejected = state.rejected.find((x) => x.seq === event.seq);
    const resting = state.book.get(String(event.seq)) ?? null;
    const fills = state.fills.filter((f) => f.atSeq === event.seq);

    return ok({ event, receipt, accepted: !rejected, rejectedReason: rejected?.reason ?? null, resting, fills });
  } catch (e) { return handleError(e); }
}
