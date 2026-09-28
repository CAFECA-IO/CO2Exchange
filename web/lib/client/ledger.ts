"use client";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { PROOF_ABI } from "@/lib/ledger/chain";
import { useAccount } from "@/components/AccountProvider";
import { fetchJson, postJson } from "./fetchJson";
import { useReload } from "./useReload";

/// 帳本 v2 的瀏覽器端（設計 v4 第 3 期）。
///
/// 使用者的每一個動作都是一則**他自己簽的** EIP-712 訊息：
///   1. 問伺服器要簽哪一包（`prepare`）——前端不自己組 typed data，
///   2. 交給 CAFECA 錢包簽（錢包把每個欄位攤開給他核對），
///   3. 帶著簽章送回去（`submit`），拿到簽收收據。
///
/// 開發用登入（本機鏈）沒有 CAFECA 通道，由伺服器用推出來的私鑰代簽（`devSigning`）。

export type LedgerMe = {
  domains: { chainId: number; ledger: `0x${string}` };
  account: `0x${string}`;
  nextNonce: string;
  devSigning: boolean;
  head: { seq: string; runningHash: string };
  cash: { available: string; locked: string; pendingWithdraw: string };
  /// 錢包裡（還沒存進帳本合約）的結算幣。balance 是 null 代表讀不到。
  wallet: { settlementToken: `0x${string}`; ledger: `0x${string}`; balance: string | null };
  credits: { batchId: string; kg: string }[];
  orders: {
    seq: string; side: "buy" | "sell"; batchId: string; country: string; amountKg: string; remainingKg: string;
    pricePerTonne: string; minFillKg: string; expiry: string; placedAt: string; locked: string;
  }[];
  fills: { atSeq: string; at: string; buyer: string; seller: string; batchId: string; country: string; amountKg: string; pricePerTonne: string; cost: string; fee: string }[];
};

export type Receipt = { seq: string; eventHash: string; runningHash: string; signature: string; signer: string };
export type Submitted = {
  event: { seq: string; kind: string }; receipt: Receipt | null; accepted: boolean; rejectedReason: string | null;
  fills: { amountKg: string; pricePerTonne: string }[];
};

type Kind = "place" | "cancel" | "retire" | "project" | "withdraw";

/// 提領的狀態（伺服器依最新一期承諾算）：全部是最小單位的十進位字串
export type WithdrawStatus = {
  pending: string; requestedTotal: string; settledTotal: string; withdrawnOnChain: string;
  latestEpoch: string | null; claimable: string; waitingForCommit: string;
  withdrawalsEnabled: boolean; escapeActive: boolean;
  proof: null | {
    proofEpoch: string; assetsRoot: `0x${string}`; leafKg: string; leafCash: string; leafRequested: string; leafSettled: string;
    siblings: { hash: `0x${string}`; kg: string; cash: string }[]; path: string;
  };
};

const LEDGER_CASH_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function depositCash(uint256 amount)",
]);

export function useLedger() {
  const { config, userId, wallet, signTypedData, relay } = useAccount();
  const enabled = !!config;
  const [me, setMe] = useState<{ key: string; value: LedgerMe } | null>(null);
  const [key, reload] = useReload();
  const who = `${userId ?? ""}|${wallet?.address ?? ""}|${key}`;

  useEffect(() => {
    if (!enabled || !userId || !wallet) return;
    let ignore = false;
    fetchJson<LedgerMe>("/api/ledger")
      .then((v) => { if (!ignore) setMe({ key: who, value: v }); })
      .catch((e) => console.warn("[ledger]", e));
    return () => { ignore = true; };
  }, [enabled, userId, wallet, who]);

  // 換帳戶之後舊資料對不上就當作還沒讀到，不在 effect 裡清空
  const current = me && me.key.split("|").slice(0, 2).join("|") === who.split("|").slice(0, 2).join("|") ? me.value : null;

  const submit = useCallback(async (kind: Kind, fields: Record<string, unknown>, description: { title: string; detail?: string }): Promise<Submitted> => {
    const p = await postJson<{ nonce: string; message: Record<string, unknown>; typedData: unknown; devSigning: boolean }>(
      "/api/ledger", { op: "prepare", kind, fields },
    );
    const signature: Hex | undefined = p.devSigning ? undefined : await signTypedData(p.typedData, description);
    const r = await postJson<Submitted>("/api/ledger", { op: "submit", kind, fields: p.message, nonce: p.nonce, signature });
    reload();
    return r;
  }, [signTypedData, reload]);

  /// 存入結算幣：鏈上轉帳（使用者自己的帳戶執行），然後請伺服器把那筆存入鏡像進帳本。
  const deposit = useCallback(async (amount: bigint) => {
    if (!config) throw new Error("設定還沒讀到");
    const d = config.deployment;
    if (current?.devSigning) {
      await postJson("/api/ledger", { op: "devDeposit", amount: amount.toString() });
    } else {
      const r = await relay([
        { target: d.settlementToken, value: 0n, data: encodeFunctionData({ abi: LEDGER_CASH_ABI, functionName: "approve", args: [d.ledger, amount] }) },
        { target: d.ledger, value: 0n, data: encodeFunctionData({ abi: LEDGER_CASH_ABI, functionName: "depositCash", args: [amount] }) },
      ], { title: `存入結算幣 ${(Number(amount) / 1e6).toLocaleString("zh-TW")} 元`, detail: "轉進帳本合約託管；gas 由平台贊助" });
      if (!r.success) throw new Error("存入交易送出了但執行失敗");
      await postJson("/api/ledger", { op: "sync" });
    }
    reload();
  }, [config, current?.devSigning, relay, reload]);

  const withdrawStatus = useCallback(() => postJson<WithdrawStatus>("/api/ledger", { op: "withdrawStatus" }), []);

  /// 領回：憑最新一期的證據呼叫帳本合約的 withdrawCash（使用者自己的鏈上交易），再把那筆提領鏡像進帳本。
  const claim = useCallback(async (): Promise<{ amount: bigint }> => {
    if (!config) throw new Error("設定還沒讀到");
    const d = config.deployment as { ledger?: `0x${string}` };
    if (!d.ledger) throw new Error("部署檔裡沒有帳本合約");
    if (current?.devSigning) {
      const r = await postJson<{ amount: string }>("/api/ledger", { op: "devWithdraw" });
      reload();
      return { amount: BigInt(r.amount) };
    }
    const st = await withdrawStatus();
    if (!st.proof || BigInt(st.claimable) === 0n) throw new Error(BigInt(st.waitingForCommit) > 0n ? "提領請求還沒進承諾，下一期（最長一小時）之後才領得到" : "目前沒有可以領回的金額");
    const p = st.proof;
    const proof = {
      proofEpoch: BigInt(p.proofEpoch), assetsRoot: p.assetsRoot, leafKg: BigInt(p.leafKg), leafCash: BigInt(p.leafCash),
      leafRequested: BigInt(p.leafRequested), leafSettled: BigInt(p.leafSettled),
      siblings: p.siblings.map((x) => ({ hash: x.hash, kg: BigInt(x.kg), cash: BigInt(x.cash) })), path: BigInt(p.path),
    };
    const amount = BigInt(st.claimable);
    const r = await relay([
      { target: d.ledger, value: 0n, data: encodeFunctionData({ abi: PROOF_ABI, functionName: "withdrawCash", args: [amount, proof] }) },
    ], { title: `從帳本合約領回 ${(Number(amount) / 1e6).toLocaleString("zh-TW")} 元`, detail: `憑第 ${p.proofEpoch} 期承諾的餘額證據；gas 由平台贊助` });
    if (!r.success) throw new Error("領回交易送出了但執行失敗");
    await postJson("/api/ledger", { op: "sync" });
    reload();
    return { amount };
  }, [config, current?.devSigning, relay, reload, withdrawStatus]);

  /// 我的證明檔（Boltchain Issue #1 格式）：存成 JSON 檔下載
  const downloadProof = useCallback(async () => {
    const f = await fetchJson<Record<string, unknown>>("/api/ledger/proof");
    const blob = new Blob([JSON.stringify(f, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `co2x-proof-${String(f.account).slice(0, 10)}-epoch${String(f.latestEpoch)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return { enabled, me: current, reload, submit, deposit, withdrawStatus, claim, downloadProof, devSigning: current?.devSigning ?? false };
}

/// 被引擎規則拒絕時的文案。帳本記的是輸入，被拒絕的事件仍然在帳本裡，只是不改變任何狀態。
export function outcomeText(r: Submitted, what: string): { kind: "ok" | "error"; text: string } {
  const seq = `帳本第 ${r.event.seq} 筆`;
  if (!r.accepted) return { kind: "error", text: `${what}被帳本規則拒絕：${r.rejectedReason}（${seq}，已簽收）` };
  const filled = r.fills.reduce((s, f) => s + Number(f.amountKg), 0);
  return { kind: "ok", text: `${what}已收單（${seq}${filled > 0 ? `，當場成交 ${(filled / 1000).toLocaleString("zh-TW")} 噸` : ""}）· 收據 ${r.receipt?.eventHash.slice(0, 10) ?? ""}…` };
}
