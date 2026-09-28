"use client";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
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
  /// 入金：匯到信託專戶，備註填入金識別碼（code）。token 是鏈上的記帳 TWD（唯一持有人是帳本合約）
  deposit: {
    code: string; ledger: `0x${string}`; token: `0x${string}`;
    trust: { bank: string; branch: string; accountNo: string; accountName: string; note: string };
  };
  /// 收款帳戶（帳號遮罩）。沒設定就不能提出出金請求
  payoutAccount: { bankCode: string; accountNo: string; holder: string } | null;
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

/// 出金的狀態（伺服器依最新一期承諾算）：金額都是最小單位的十進位字串
export type WithdrawStatus = {
  pending: string; requestedTotal: string; settledTotal: string; withdrawnOnChain: string;
  latestEpoch: string | null;
  /// 已進承諾、等營運方匯款確認的金額
  settleable: string;
  /// 還沒進最新一期承諾的待出金
  waitingForCommit: string;
  payoutAccount: { bankCode: string; accountNo: string; holder: string; payoutRef: string } | null;
};

export function useLedger() {
  const { config, userId, wallet, signTypedData } = useAccount();
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

  /// 開發用登入（本機鏈）的模擬入金：等於營運方立刻確認了一筆匯款。
  /// 正式的入金不經過網站——使用者匯款到信託專戶，營運 Safe 對帳後在鏈上確認。
  const devDeposit = useCallback(async (amount: bigint) => {
    await postJson("/api/ledger", { op: "devDeposit", amount: amount.toString() });
    reload();
  }, [reload]);

  const withdrawStatus = useCallback(() => postJson<WithdrawStatus>("/api/ledger", { op: "withdrawStatus" }), []);

  const setPayoutAccount = useCallback(async (payout: { bankCode: string; accountNo: string; holder: string }) => {
    const r = await postJson<{ bankCode: string; accountNo: string; holder: string }>("/api/ledger", { op: "setPayoutAccount", payout });
    reload();
    return r;
  }, [reload]);

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

  return { enabled, me: current, reload, submit, devDeposit, withdrawStatus, setPayoutAccount, downloadProof, devSigning: current?.devSigning ?? false };
}

/// 被引擎規則拒絕時的文案。帳本記的是輸入，被拒絕的事件仍然在帳本裡，只是不改變任何狀態。
export function outcomeText(r: Submitted, what: string): { kind: "ok" | "error"; text: string } {
  const seq = `帳本第 ${r.event.seq} 筆`;
  if (!r.accepted) return { kind: "error", text: `${what}被帳本規則拒絕：${r.rejectedReason}（${seq}，已簽收）` };
  const filled = r.fills.reduce((s, f) => s + Number(f.amountKg), 0);
  return { kind: "ok", text: `${what}已收單（${seq}${filled > 0 ? `，當場成交 ${(filled / 1000).toLocaleString("zh-TW")} 噸` : ""}）· 收據 ${r.receipt?.eventHash.slice(0, 10) ?? ""}…` };
}
