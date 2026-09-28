import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { apply, countryOfBatch, genesis, type State } from "./engine.ts";
import { chainHash, GENESIS, type Event, type EventOf } from "./events.ts";
import { isAuthorized, roleFor, thresholdAt, type Authorities } from "./authorities.ts";
import { mirrorCash } from "./mirror.ts";
import type { NewEvent, Receipt, ReceiptSigner, Store } from "./store.ts";
import { authTypedData, userMessageOf, userTypedData, type Domains } from "./typed.ts";

/// 常駐程式（後台做市、模擬器）寫帳本的入口（設計 v4 第 5 期）。
///
/// 做市帳戶與模擬人物都是**一般 EOA**：它們簽的委託單和使用者在網站上簽的是同一種 EIP-712、
/// 走同一套引擎規則，查核時用同一條 ecrecover 驗。差別只在送進來的路：網站的收單 API 要登入，
/// 這些程式跟網站跑在同一台機器上、共用同一份帳本檔（寫入有檔案鎖），直接追加。
///
/// 收單時做的檢查和網站相同：簽章在這裡先 ecrecover 一次（簽錯的根本不寫），nonce 接得上，
/// 收單區塊是現在。授權事件（例如替做市帳戶登記身分）只收門檻 1、而且這把金鑰在清單上的角色。
///
/// `guard` 在**寫入鎖裡**、用最新的帳本狀態判斷要不要寫：做市與模擬器之間「不互相成交」的保證靠它——
/// 在鎖外看的簿子，到真正寫進去的那一刻可能已經被對方改過了。
///
/// 不依賴 Next。

type UserKind = import("./typed.ts").UserKind;
export type UserBody<K extends UserKind> = Omit<EventOf<K>, "seq" | "at" | "atBlock" | "kind" | "signature" | "account" | "nonce">;
type AuthBody<K extends Event["kind"]> = Omit<EventOf<K>, "seq" | "at" | "atBlock" | "kind" | "signer" | "signature">;

export type Outcome = { event: Event; receipt: Receipt | null; rejectedReason: string | null; fills: State["fills"] };

export function createAgent(opts: {
  store: Store; client: PublicClient; domains: Domains; receiptSigner: ReceiptSigner;
  /// 讀授權清單（authority 事件用）。常駐程式通常快取一段時間。
  authorities?: () => Promise<Authorities>;
  fromBlock?: bigint;
  /// 鏈上事件的增量索引（logindex.ts）
  index?: import("./chain.ts").Range["index"];
}) {
  const { store, client, domains, receiptSigner } = opts;
  let cache: { seq: bigint; running: Hex; state: State } = { seq: 0n, running: GENESIS, state: genesis() };

  /// 帳本目前的狀態（增量套用；帳本被重建就從頭來）。簽章不重驗：寫進帳本的每一筆收單時都驗過。
  function state(): State {
    const h = store.head();
    if (h.seq === cache.seq && h.runningHash === cache.running) return cache.state;
    if (h.seq > cache.seq) {
      const fresh = store.read(cache.seq + 1n);
      let running = cache.running;
      for (const e of fresh) running = chainHash(running, e);
      if (running === h.runningHash) {
        apply(cache.state, fresh, { sigOk: () => true });
        cache = { seq: h.seq, running, state: cache.state };
        return cache.state;
      }
    }
    const all = store.read();
    const s = apply(genesis(), all, { sigOk: () => true });
    let running = GENESIS;
    for (const e of all) running = chainHash(running, e);
    cache = { seq: h.seq, running, state: s };
    return s;
  }

  const atBlock = () => client.getBlockNumber({ cacheTime: 0 });

  function outcome(event: Event, receipt: Receipt | null): Outcome {
    const s = state();
    const r = s.rejected.find((x) => x.seq === event.seq);
    return { event, receipt, rejectedReason: r?.reason ?? null, fills: s.fills.filter((f) => f.takerSeq === event.seq) };
  }

  /// 使用者事件。回 null = guard 在鎖裡決定不寫。
  async function user<K extends UserKind>(
    signer: LocalAccount, kind: K, body: UserBody<K>, o: { guard?: (s: State) => boolean } = {},
  ): Promise<Outcome | null> {
    if (!signer.signTypedData) throw new Error("這把金鑰不能簽 EIP-712");
    const account = signer.address;
    const block = await atBlock();
    // nonce 在鎖裡才定：同一個帳戶可能有兩個行程在簽（例如做市撤單與掛單交錯）。簽章包含 nonce，所以也在鎖裡簽。
    const r = await store.appendIf(async () => {
      const s = state();
      if (o.guard && !o.guard(s)) return null;
      const nonce = (s.nonces.get(account.toLowerCase()) ?? 0n) + 1n;
      const e = { atBlock: block, kind, account, nonce, ...body, signature: "0x" as Hex };
      e.signature = await signUser(domains, signer, e);
      return e as unknown as NewEvent;
    }, { receiptSigner });
    if (!r) return null;
    return outcome(r.event, r.receipt);
  }

  return { state, atBlock, user, authority, mirror, domains };

  /// 授權事件（單一金鑰、門檻 1 的角色）。
  async function authority<K extends Event["kind"]>(signer: LocalAccount, kind: K, body: AuthBody<K>): Promise<Outcome> {
    if (!signer.signTypedData) throw new Error("這把金鑰不能簽 EIP-712");
    const block = await atBlock();
    const draft = { seq: 0n, at: 0n, atBlock: block, kind, ...body, signer: signer.address, signature: "0x" } as unknown as Event;
    const role = roleFor(draft);
    if (!role) throw new Error(`${kind} 不是授權事件`);
    if (opts.authorities) {
      const a = await opts.authorities();
      if (thresholdAt(a, role, block) > 1) throw new Error(`${role} 需要 ${thresholdAt(a, role, block)} 個簽章，常駐程式不能單獨簽`);
      if (!isAuthorized(a, role, signer.address, block)) throw new Error(`${signer.address} 不在帳本合約的 ${role} 清單上`);
    }
    const signature = await signer.signTypedData(authTypedData(domains, draft) as Parameters<NonNullable<LocalAccount["signTypedData"]>>[0]);
    const { seq: _s, at: _a, ...rest } = { ...draft, signature } as Event;
    void _s; void _a;
    const { event, receipt } = await store.append(rest as NewEvent, { receiptSigner });
    return outcome(event, receipt);
  }

  /// 把鏈上的入金／出金確認鏡像進帳本（營運 Safe 確認之後呼叫）。
  async function mirror(ledger: Address): Promise<number> {
    const { added } = await mirrorCash({ store, client, ledger, fromBlock: opts.fromBlock ?? 0n, receiptSigner, index: opts.index });
    return added.length;
  }
}

/// 簽一筆使用者事件並在寫之前 ecrecover 一次。拆出來給 `user` 用、也給測試用。
export async function signUser(d: Domains, signer: LocalAccount, e: Record<string, unknown>): Promise<Hex> {
  const typed = userTypedData(d, e.kind as UserKind, userMessageOf(e as unknown as EventOf<UserKind>));
  const sig = await signer.signTypedData!(typed as Parameters<NonNullable<LocalAccount["signTypedData"]>>[0]);
  const back = await recoverTypedDataAddress({ ...(typed as object), signature: sig } as Parameters<typeof recoverTypedDataAddress>[0]);
  if (back.toLowerCase() !== signer.address.toLowerCase()) throw new Error("簽章 ecrecover 回來不是簽的人");
  return sig;
}

export type Agent = ReturnType<typeof createAgent>;

/// 一張還沒送出的委託單，會不會和 `among` 裡的某一張現有掛單成交（照引擎的配對條件：方向、批次、核發國、價格、期限）。
/// 做市與模擬器互相迴避靠它；它比引擎寬鬆（不看身分與最小成交量），寧可多擋、不可漏擋。
export function wouldMatch(
  s: State,
  q: { side: "buy" | "sell"; batchId: bigint; country: string; pricePerTonne: bigint; account: string },
  now: bigint,
  among: (account: string) => boolean,
): boolean {
  const me = q.account.toLowerCase();
  const qCountry = q.side === "sell" ? (countryOfBatch(s, q.batchId) ?? "") : q.country;
  for (const o of s.book.values()) {
    if (o.side === q.side || o.remainingKg === 0n || o.expiry <= now) continue;
    if (o.account.toLowerCase() === me || !among(o.account)) continue;
    const [sell, buy] = q.side === "buy" ? [o, { batchId: q.batchId, country: qCountry }] : [{ batchId: q.batchId, country: qCountry }, o];
    if (buy.batchId !== 0n && buy.batchId !== sell.batchId) continue;
    if (buy.country && buy.country !== sell.country) continue;
    if (q.side === "buy" ? o.pricePerTonne <= q.pricePerTonne : o.pricePerTonne >= q.pricePerTonne) return true;
  }
  return false;
}
