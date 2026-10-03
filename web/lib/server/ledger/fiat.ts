import "server-only";
import { isAddress, type Address, type Hex } from "viem";
import {
  bankRefOf, creditDepositCall, depositCodeOf, execOperatorSafe, localOperatorOwners, payoutRefOf, settleWithdrawalCall,
} from "@/lib/ledger/fiat";
import { LEDGER_ABI, PROOF_ABI } from "@/lib/ledger/chain";
import { balanceProofArgs } from "@/lib/ledger/proofs";
import { ApiError } from "../api";
import { IS_LOCAL_CHAIN, deployment, publicClient, relayerClient } from "../chain";
import { all, insert, type WithId } from "../store";
import { ledgerView } from "./view";
import { latestSnapshot } from "./proofs";
import { appendAuthorityOrPropose, syncCash } from "./write";
import { openField, sealField } from "../sealed";
import { nameOf, type KycRequest } from "../kyc";

/// 新台幣入出金的網站這一側（規則第 4 版）。
///
/// **網站不持有營運 Safe 的金鑰。** 入金確認與出金確認是營運 Safe 的鏈上交易：外部鏈上，
/// 網站只給出要執行的內容與指令（`npm run fiat -- …`，由持有人在自己的機器上簽）；
/// 只有本機鏈（anvil，持有人金鑰是公開的測試金鑰）網站才直接代送，好讓展示跑得完。

// ── 信託專戶（使用者匯款的對象） ──

export function trustAccount() {
  return {
    bank: process.env.TRUST_BANK_NAME || "（Phase 0 展示：信託專戶尚未開立）",
    branch: process.env.TRUST_BANK_BRANCH || "",
    accountNo: process.env.TRUST_ACCOUNT_NO || "",
    accountName: process.env.TRUST_ACCOUNT_NAME || "卡菲卡金融科技股份有限公司信託財產專戶",
    note: "匯款時請在備註填入您的入金識別碼。營運方對帳後入帳，Phase 0 為人工確認（通常一個營業日內）。",
  };
}

export const depositCode = (account: Address) => depositCodeOf(account);

/// 入金識別碼 → 帳戶。只在帳本認得的帳戶裡找（有身分、有持有、有現金的）。
export function accountOfDepositCode(code: string): Address | null {
  const want = code.replace(/\D/g, "");
  if (want.length !== 10) return null;
  const s = ledgerView().state;
  const seen = new Set<string>([...s.identities.keys(), ...s.cash.keys(), ...s.credits.keys()]);
  for (const a of seen) if (depositCodeOf(a as Address) === want) return (s.identities.get(a)?.account ?? a) as Address;
  return null;
}

// ── 收款帳戶 ──

/// 收款帳戶的紀錄。**帳號與戶名只以密文保存**（lib/server/sealed.ts）；銀行代碼不是個人資料，留明文。
/// 帳本裡的出金請求只記 payoutRef（加鹽雜湊），明文只有營運方匯款時才解開。
export type PayoutAccount = WithId & {
  account: Address; bankCode: string; payoutRef: Hex;
  accountNoSealed?: string; accountNoMasked?: string; holderSealed?: string;
  /// 遷移前的舊資料才有的明文。`npm run data:protect` 會改成密文；程式不再寫入
  accountNo?: string; holder?: string;
};
const PC = "payout-accounts";

/// 解開一筆收款帳戶（營運方匯款、使用者看自己的戶名時）。
export function openPayout(pa: PayoutAccount): { bankCode: string; accountNo: string; holder: string; payoutRef: Hex } {
  const accountNo = pa.accountNoSealed ? openField(PC, "accountNo", pa.account, pa.accountNoSealed) : pa.accountNo ?? "";
  const holder = pa.holderSealed ? openField(PC, "holder", pa.account, pa.holderSealed) : pa.holder ?? "";
  return { bankCode: pa.bankCode, accountNo, holder, payoutRef: pa.payoutRef };
}

/// 給使用者本人看的：帳號只露末四碼。不必解開帳號。
export function maskedPayout(pa: PayoutAccount) {
  const holder = pa.holderSealed ? openField(PC, "holder", pa.account, pa.holderSealed) : pa.holder ?? "";
  return { bankCode: pa.bankCode, accountNo: pa.accountNoMasked ?? maskAccountNo(pa.accountNo ?? ""), holder, payoutRef: pa.payoutRef };
}

/// 雜湊的鹽。帳本公開的是 payoutRef，沒有鹽的話銀行帳號可以逐一試出來。
const salt = () => process.env.PAYOUT_SALT || process.env.IDENTITY_SALT || "co2exchange-phase0";

export function payoutAccountOf(account: Address): PayoutAccount | null {
  const a = account.toLowerCase();
  return all<PayoutAccount>(PC).filter((r) => r.account.toLowerCase() === a).at(-1) ?? null;
}

export function setPayoutAccount(account: Address, p: { bankCode?: string; accountNo?: string; holder?: string }) {
  const bankCode = String(p.bankCode ?? "").trim();
  const accountNo = String(p.accountNo ?? "").replace(/[\s-]/g, "");
  const holder = String(p.holder ?? "").trim().slice(0, 60);
  if (!/^\d{3}$/.test(bankCode)) throw new ApiError("INVALID_PARAM", "銀行代碼是三位數字", { param: "bankCode" });
  if (!/^\d{8,16}$/.test(accountNo)) throw new ApiError("INVALID_PARAM", "帳號是 8 到 16 位數字", { param: "accountNo" });
  if (!holder) throw new ApiError("MISSING_PARAM", "戶名必填（須與身分驗證的名稱相同）", { param: "holder" });
  // 戶名要和身分驗證的名稱相同（約定書第五條之二第三項）。有核准過的申請才比得了；
  // 沒有的（Phase 0 的開發帳戶）先放行，出金時營運方仍要人工核對
  // 最新一筆核准過的身分（含後來因 CAFECA 暫停而失效的那筆——名字仍是同一個人，不能因為失效就跳過比對）
  const kyc = all<KycRequest>("kyc-requests").filter((r) => r.account.toLowerCase() === account.toLowerCase() && (r.status === "approved" || r.status === "lapsed")).at(-1);
  const kycName = kyc ? nameOf(kyc).replace(/\s+/g, "") : "";
  if (kycName && kycName !== holder.replace(/\s+/g, "")) {
    throw new ApiError("INVALID_PARAM", "戶名要和身分驗證的名稱相同（收款帳戶必須是您本人名義）", { param: "holder" });
  }
  const payoutRef = payoutRefOf({ bankCode, accountNo, holder }, salt());
  const cur = payoutAccountOf(account);
  if (cur && cur.payoutRef === payoutRef) return cur;
  return insert<PayoutAccount>(PC, {
    account, bankCode, payoutRef,
    accountNoSealed: sealField(PC, "accountNo", account, accountNo), accountNoMasked: maskAccountNo(accountNo),
    holderSealed: sealField(PC, "holder", account, holder),
  });
}

export const maskAccountNo = (n: string) => (n.length <= 4 ? n : `${"•".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`);

// ── 出金狀態 ──

/// 帳本裡待出金多少、最新一期承諾裡可以出金多少、鏈上已經確認出金多少。
export async function withdrawStatus(account: Address) {
  const d = deployment();
  const low = account.toLowerCase();
  const { state } = ledgerView();
  const [snap, withdrawn] = await Promise.all([
    latestSnapshot(),
    publicClient.readContract({ address: d.ledger, abi: PROOF_ABI, functionName: "withdrawnTotal", args: [account] }),
  ]);
  const proof = snap ? balanceProofArgs(snap, account) : null;
  const cap = proof?.leafRequested ?? 0n;
  const settleable = cap > withdrawn ? cap - withdrawn : 0n;
  const pending = state.pendingWithdraw.get(low) ?? 0n;
  const pa = payoutAccountOf(account);
  return {
    pending,
    requestedTotal: state.withdrawRequested.get(low) ?? 0n,
    settledTotal: state.withdrawSettled.get(low) ?? 0n,
    withdrawnOnChain: withdrawn,
    latestEpoch: snap?.commitment.epoch ?? null,
    /// 已經進了承諾、營運方可以匯款並在鏈上確認的金額
    settleable,
    /// 還沒進最新一期承諾的部分：要等下一期（最長一小時）
    waitingForCommit: pending > settleable ? pending - settleable : 0n,
    payoutAccount: pa ? maskedPayout(pa) : null,
  };
}

// ── 營運方：佇列 ──

export type FiatDepositNotice = WithId & { account: Address; amount: string; bankRef: string; status: "credited"; txHash: Hex; by: string };

/// 待處理的出金：帳本裡有待出金的每一個帳戶（管理員看得到收款帳戶的明文）。
export async function withdrawQueue() {
  const { state, events } = ledgerView();
  const rows = [];
  for (const [a, pending] of state.pendingWithdraw) {
    if (pending <= 0n) continue;
    const account = (state.identities.get(a)?.account ?? a) as Address;
    const st = await withdrawStatus(account);
    const reqs = events.filter((e) => e.kind === "withdraw" && e.account.toLowerCase() === a).slice(-5)
      .map((e) => ({ seq: e.seq, at: e.at, amount: (e as { amount: bigint }).amount, payoutRef: (e as { payoutRef: Hex }).payoutRef }));
    const pa = payoutAccountOf(account);
    rows.push({
      account, pending, settleable: st.settleable, waitingForCommit: st.waitingForCommit, requests: reqs,
      // 管理員匯款要看明文：只在這裡解開
      payoutAccount: pa ? openPayout(pa) : null,
      payoutMatches: !!pa && reqs.every((r) => r.payoutRef === pa.payoutRef),
    });
  }
  return rows;
}

/// 本機鏈：網站直接代營運 Safe 送。外部鏈：回傳要執行的內容，交給持有人。
async function runOrDescribe(call: { to: Address; data: Hex }, cli: string) {
  const d = deployment();
  if (!IS_LOCAL_CHAIN) {
    return { executed: false as const, safe: d.operatorSafe, to: call.to, data: call.data, cli };
  }
  const txHash = await execOperatorSafe({
    pub: publicClient, sender: relayerClient, safe: d.operatorSafe, to: call.to, data: call.data, owners: localOperatorOwners(),
  });
  const mirrored = await syncCash();
  return { executed: true as const, txHash, mirrored };
}

/// 最小單位 → CLI 用的元（`npm run fiat` 收的是元）
const yuanText = (u: bigint) => {
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${u / 1_000_000n}.${frac}` : `${u / 1_000_000n}`;
};

function amountOf(v: unknown): bigint {
  let n: bigint;
  try { n = BigInt(String(v)); } catch { throw new ApiError("INVALID_PARAM", "金額要是整數（最小單位）", { param: "amount" }); }
  if (n <= 0n || n > 100_000_000n * 10n ** 6n) throw new ApiError("INVALID_PARAM", "金額要在 0 到一億元之間", { param: "amount" });
  return n;
}

/// 同一個銀行參考號合約不收第二次；先讀一次，錯誤訊息才講得清楚（也省一筆會失敗的 Safe 交易）
async function refuseUsedBankRef(bankRef: Hex) {
  const used = await publicClient.readContract({ address: deployment().ledger, abi: LEDGER_ABI, functionName: "bankRefUsed", args: [bankRef] });
  if (used) throw new ApiError("ALREADY_EXISTS", "這個銀行交易參考號已經確認過了", { param: "bankRef" });
}

/// 營運方確認一筆入金（依銀行對帳單）。`who` 可以是地址或入金識別碼。
export async function confirmDeposit(who: string, amountRaw: unknown, bankRefText: string, by: string) {
  const account = isAddress(who) ? who : accountOfDepositCode(who);
  if (!account) throw new ApiError("INVALID_PARAM", "找不到這個入金識別碼對應的帳戶", { param: "account" });
  const amount = amountOf(amountRaw);
  const bankRef = bankRefOf("in", bankRefText);
  await refuseUsedBankRef(bankRef);
  const d = deployment();
  const r = await runOrDescribe(creditDepositCall(d.ledger, account, amount, bankRef),
    `npm run fiat -- deposit ${account} ${yuanText(amount)} '${bankRefText.replace(/'/g, "")}'`);
  if (r.executed) insert<FiatDepositNotice>("fiat-deposits", { account, amount: amount.toString(), bankRef, status: "credited", txHash: r.txHash, by });
  return { account, amount, bankRef, ...r };
}

/// 營運方確認一筆出金已匯出。金額上限是已進承諾的出金請求。
export async function confirmWithdrawal(account: Address, amountRaw: unknown, bankRefText: string) {
  const amount = amountOf(amountRaw);
  const st = await withdrawStatus(account);
  if (st.settleable < amount) {
    throw new ApiError("INVALID_PARAM", st.waitingForCommit > 0n
      ? "這筆出金請求還沒進承諾，下一期（最長一小時）之後才能確認"
      : `可確認的出金只有 ${yuanText(st.settleable)} 元`, { param: "amount" });
  }
  const snap = await latestSnapshot();
  const proof = snap ? balanceProofArgs(snap, account) : null;
  if (!proof) throw new ApiError("NOT_FOUND", "最新一期承諾裡找不到這個帳戶");
  const d = deployment();
  const bankRef = bankRefOf("out", bankRefText);
  await refuseUsedBankRef(bankRef);
  const r = await runOrDescribe(settleWithdrawalCall(d.ledger, account, amount, bankRef, proof),
    `npm run fiat -- settle ${account} ${yuanText(amount)} '${bankRefText.replace(/'/g, "")}'`);
  return { account, amount, bankRef, ...r };
}

/// 營運方退回一筆出金請求（例如收款帳戶有誤）：營運角色簽一筆 withdrawReject。門檻大於 1 時變成提案。
export async function rejectWithdrawal(account: Address, amountRaw: unknown, reason: string, by: string) {
  const amount = amountOf(amountRaw);
  const pending = ledgerView().state.pendingWithdraw.get(account.toLowerCase()) ?? 0n;
  if (pending < amount) throw new ApiError("INVALID_PARAM", "待出金不足以退回", { param: "amount" });
  return appendAuthorityOrPropose("withdrawReject", { account, amount, reason: reason.slice(0, 200) || "退回" }, { createdBy: by, note: `退回出金 ${account.slice(0, 10)}…` });
}

/// 開發用登入（本機鏈）的入金：等於營運方立刻確認了一筆匯款。
export async function devCreditDeposit(account: Address, amount: bigint) {
  if (!IS_LOCAL_CHAIN) throw new ApiError("FORBIDDEN", "只有本機鏈可以用開發入金");
  if (amount <= 0n || amount > 10_000_000n * 10n ** 6n) throw new ApiError("INVALID_PARAM", "金額要在 0 到一千萬之間", { param: "amount" });
  const r = await confirmDeposit(account, amount, `dev:${account.slice(2, 10)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, "dev");
  return r.executed ? r.mirrored : 0;
}
