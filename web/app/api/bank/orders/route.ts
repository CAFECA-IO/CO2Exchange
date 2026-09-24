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
    const wallet = await walletOf(m.email, m.id);
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
    const wallet = await walletOf(m.email, m.id);
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
