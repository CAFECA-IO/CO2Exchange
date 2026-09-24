import "server-only";
import type { Hex, TransactionReceipt, WalletClient } from "viem";
import { CONFIRMATIONS, IS_LOCAL_CHAIN, TX_TIMEOUT_MS, publicClient, relayerClient } from "./chain";
import { ApiError } from "./api";

/// 所有由**伺服器端金鑰**送出的交易的唯一出口。
///
/// 為什麼需要這一層：本機鏈上不需要，公開鏈上非有不可。
///
/// ## 一、nonce 是共用資源
///
/// 這個系統裡幾乎每一筆上鏈動作都由同一把 relayer 金鑰代送：建錢包、代送使用者
/// 簽好的交易、簽發身分、領測試幣、回寫憑證。平台付 gas 是刻意的設計（使用者不必
/// 持有原生幣），代價是**所有人共用一個 nonce 序列**。
///
/// 在 anvil 上這不痛不癢：交易當場入塊，下一筆讀到的 nonce 就是對的。
/// 公開鏈的出塊要等兩秒，兩個使用者同時按下按鈕就會拿到同一個 nonce——
/// 其中一筆以 `nonce too low` 或 `replacement transaction underpriced` 失敗，
/// 而失敗的那個人什麼都沒做錯。這種錯還特別難查：它只在有人同時操作時出現。
///
/// 所以這裡對每一把金鑰排一條佇列，序號自己記，送出去才放下一筆。
/// 代價是同一把金鑰的交易變成序列化的——這是對的取捨：正確性優先，
/// 真的需要並行時的解法是多備幾把 relayer 金鑰，不是讓它們搶同一個序號。
///
/// ## 二、等待要有盡頭
///
/// `waitForTransactionReceipt` 預設會一直等。公開鏈塞車時那等於整支 API 掛在那裡，
/// 而前端已經超時放棄了。這裡給它逾時，並把逾時回成一個**可重試**的錯誤碼。
///
/// ## 三、錢會用完
///
/// 本機的 relayer 有一萬個 ETH，公開鏈上它靠 faucet。餘額見底時每一筆交易都會失敗，
/// 而 viem 給的是 "insufficient funds for gas * price + value"——訊息裡沒有一個字
/// 告訴維運的人「去領測試幣」。這裡把它轉成 RELAYER_UNFUNDED。

type Queue = { tail: Promise<unknown>; next?: number };
const queues = new Map<string, Queue>();

/// 同一把金鑰的送出動作接成一條鏈；不同金鑰互不影響。
async function serialise<T>(address: string, fn: (q: Queue) => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  const q = queues.get(key) ?? { tail: Promise.resolve() };
  queues.set(key, q);
  const run = q.tail.then(() => fn(q), () => fn(q));
  // tail 只用來排隊，不能讓失敗往下傳染，所以把 rejection 吞掉（呼叫端仍會拿到）
  q.tail = run.catch(() => {});
  return run;
}

/// 下一個該用的 nonce。以本地記的為準，但不得低於鏈上的 pending——
/// 重啟、別的程序也在用同一把金鑰（例如模擬器）都會讓本地那份落後。
async function nextNonce(address: `0x${string}`, q: Queue): Promise<number> {
  const onchain = await publicClient.getTransactionCount({ address, blockTag: "pending" });
  const n = q.next === undefined ? onchain : Math.max(q.next, onchain);
  q.next = n + 1;
  return n;
}

const has = (e: unknown, re: RegExp): boolean => {
  for (let cur: unknown = e, i = 0; cur && i < 8; i++) {
    if (cur instanceof Error && re.test(cur.message)) return true;
    cur = (cur as { cause?: unknown } | null)?.cause;
  }
  return false;
};

export type Submitted = { hash: Hex; receipt: TransactionReceipt };

/// 送一筆交易並等它上鏈。`request` 是 `simulateContract` 回來的那個，
/// 或任何 `writeContract` 吃得下的參數。
export async function submit(
  request: Parameters<WalletClient["writeContract"]>[0],
  wallet: WalletClient = relayerClient,
): Promise<Submitted> {
  const account = wallet.account;
  if (!account) throw new ApiError("INTERNAL", "送交易的 client 沒有帳戶");

  return serialise(account.address, async (q) => {
    let hash: Hex;
    try {
      const nonce = await nextNonce(account.address, q);
      hash = await wallet.writeContract({ ...request, nonce } as Parameters<WalletClient["writeContract"]>[0]);
    } catch (e) {
      // 送失敗就不知道那個序號用掉了沒，下一筆重新問鏈上。
      q.next = undefined;
      if (has(e, /insufficient funds/i)) {
        throw new ApiError(
          "RELAYER_UNFUNDED",
          `平台代付 gas 的帳戶（${account.address}）餘額不足，交易送不出去。` +
            (IS_LOCAL_CHAIN ? "本機鏈請重開 anvil。" : "請到該鏈的 faucet 為這個地址補充測試幣。"),
          { relayer: account.address },
        );
      }
      // nonce 撞車：序號已經重設，讓呼叫端重試一次就好，不必讓使用者看到內部細節。
      if (has(e, /nonce too low|already known|replacement transaction underpriced/i)) {
        throw new ApiError("UPSTREAM_ERROR", "這筆交易和另一筆撞在一起了，請再送一次");
      }
      throw e;
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash, confirmations: CONFIRMATIONS, timeout: TX_TIMEOUT_MS,
      });
      return { hash, receipt };
    } catch (e) {
      if (has(e, /timed out|Timeout/i)) {
        // 交易已經送出去了，只是還沒進塊。**不要**重用這個序號。
        throw new ApiError(
          "TX_TIMEOUT",
          `交易已送出但 ${Math.round(TX_TIMEOUT_MS / 1000)} 秒內還沒進塊（${hash}）。` +
            "它可能稍後才會成功，請先查看交易再決定是否重送。",
          { txHash: hash },
        );
      }
      throw e;
    }
  });
}
