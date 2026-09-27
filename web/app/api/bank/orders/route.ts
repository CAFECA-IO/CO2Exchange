import type { Address, Hex } from "viem";
import { CHAIN_ID, IS_LOCAL_CHAIN, deployment, isAddress } from "@/lib/server/chain";
import { cancelDigest, cancelMessageOf, placeDigest, placeMessageOf } from "@/lib/bank/order-typed";
import { accountAcceptsSignature } from "@/lib/server/cafeca/verify";
import { replay } from "@/lib/bank/replay";
import { append, head, nextNonce, readEvents } from "@/lib/server/bank/log-store";
import { ApiError, fail, handleError, ok } from "@/lib/server/api";
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
/// ## 簽章驗證
///
/// 每一筆都以 ERC-1271 驗過才寫進 log：拿 `lib/bank/order-typed.ts` 的 EIP-712
/// 結構算 digest，問使用者的帳戶合約 `isValidSignature`。回 `0x1626ba7e` 才收。
///
/// 這是「委託單是法律憑據」這個定位的前提。沒有它，log 裡有一個叫簽章的欄位，
/// 而它證明不了任何事——不可否認性其實來自登入 session，也就是來自交易所自己。
///
/// 驗的欄位就是使用者看到並同意的那些（CAFECA 錢包會把 EIP-712 的內容攤開給他核對），
/// **不包含序號與收單時間**：那兩個是交易所給的，使用者下單當下還不知道。
/// 對不上時，使用者手上那張交易所簽名的收據才是武器。
///
/// 驗證在本機鏈上預設關閉（`ORDERS_REQUIRE_SIGNATURE=1` 可強制開啟）。
/// 理由和 `requireOwnKey` 那裡一樣：模擬市場的一百個帳戶不是真的 CAFECA 身分，
/// 簽不出東西來。但**公開鏈上一律開啟，而且不提供關閉的環境變數以外的路徑**——
/// 漏開一條公開鏈的代價是任何登入者都能以別人的名義下單。

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

/// 公開鏈一律要驗；本機鏈預設不驗（模擬市場的帳戶簽不出東西），可用環境變數強制開啟。
const REQUIRE_SIGNATURE = process.env.ORDERS_REQUIRE_SIGNATURE
  ? process.env.ORDERS_REQUIRE_SIGNATURE === "1"
  : !IS_LOCAL_CHAIN;

/// 簽章的網域綁在 Bank 上（見 order-typed.ts）。部署檔沒有它就不能收單——
/// 沒有 Bank 位址就算不出 digest，而「算不出來所以先收下」正是不能有的分支。
function bankAddress(): Address {
  const b = deployment().bank;
  if (!b) throw new ApiError("DEPLOYMENT_MISMATCH", "部署檔裡沒有 bank 位址，無法驗證委託單簽章");
  return b;
}

async function checkSignature(account: Address, digest: `0x${string}`, signature: Hex): Promise<void> {
  if (!REQUIRE_SIGNATURE) return;
  if (!(await accountAcceptsSignature(account, digest, signature))) {
    throw new ApiError("SIGNATURE_INVALID", "這張單的簽章沒有通過帳戶合約的驗證");
  }
}

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
      await checkSignature(account, cancelDigest(CHAIN_ID, bankAddress(), cancelMessageOf({ account, orderSeq, nonce })), b.signature);
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

    // 沒帶期限就給 30 日——交易拍賣及移轉管理辦法 §12①⑤ 的定價交易期間下限。
    // **要驗簽章時不能套預設值**：使用者簽的是一個具體的期限，伺服器自己補一個
    // 就必然對不上 digest，而錯誤訊息只會說「簽章無效」，沒有人查得出原因。
    const expiry = big(b.expiry);
    if (REQUIRE_SIGNATURE && expiry <= 0n) {
      return fail("MISSING_PARAM", { message: "要帶 expiry——它在簽章涵蓋的範圍內", details: { param: "expiry" } });
    }

    const order = {
      account,
      side: b.side,
      batchId: big(b.batchId),
      country: (b.country ?? "TW").slice(0, 2),
      amountKg,
      pricePerTonne,
      minFillKg: big(b.minFillKg),
      expiry: expiry || BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
      nonce,
    } as const;

    await checkSignature(account, placeDigest(CHAIN_ID, bankAddress(), placeMessageOf(order)), b.signature);

    const { event, receipt } = await append({ kind: "place", ...order, signature: b.signature });

    // 寫下去之後立刻重播一次，回報這張單現在的狀態。
    // **重播是唯一的真相來源**——不在這裡另外算一份「剛剛成交了多少」。
    const { state } = replay(readEvents(), 0n, deployment().treasury);
    const rejected = state.rejected.find((x) => x.seq === event.seq);
    const resting = state.book.get(String(event.seq)) ?? null;
    const fills = state.fills.filter((f) => f.atSeq === event.seq);

    return ok({ event, receipt, accepted: !rejected, rejectedReason: rejected?.reason ?? null, resting, fills });
  } catch (e) { return handleError(e); }
}
