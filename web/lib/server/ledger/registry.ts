import "server-only";
import type { Address, Hex } from "viem";
import { eventHash } from "@/lib/ledger/events";
import { ApiError } from "../api";
import { addWorkingDays } from "../bulletin";
import type { CertData } from "../certpdf";
import { deployment } from "../chain";
import { ledgerView } from "./view";
import { appendAuthority, appendAuthorityOrPropose } from "./write";

/// 登錄簿與身分的帳本版本（設計 v4 第 3 期）：讀取回傳和鏈上版本相同的形狀，
/// 寫入改成由本站的服務金鑰簽一筆授權事件。
///
/// 以前的 `txHash` 欄位在這裡放**事件雜湊**——帳本裡的動作沒有鏈上交易。

const low = (a: string) => a.toLowerCase();
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const now = () => BigInt(Math.floor(Date.now() / 1000));

function hashAt(seq: bigint): Hex {
  const e = ledgerView().events[Number(seq) - 1];
  return e ? eventHash(e) : ZERO32;
}

function mustAccept(r: { rejectedReason: string | null }, what: string) {
  if (r.rejectedReason) throw new ApiError("CONTRACT_REVERTED", `${what}被帳本規則拒絕：${r.rejectedReason}`);
}

// ── 身分 ──

export function ledgerIdentity(account: Address) {
  const id = ledgerView().state.identities.get(low(account));
  return {
    tier: id?.tier ?? 0, expiry: Number(id?.expiry ?? 0n), frozen: id?.frozen ?? false,
    jurisdiction: id?.jurisdiction ?? "", identityHash: id?.identityHash ?? ZERO32,
  };
}

/// 身分驗證服務簽一筆 identity 事件。nonce 是這個帳戶的身分證明序號（重簽一次加一）。
export async function ledgerRegisterIdentity(account: Address, tier: number, identityHash: Hex) {
  const cur = ledgerView().state.identities.get(low(account));
  const t = now();
  const r = await appendAuthority("identity", {
    account, tier, expiry: t + 365n * 86400n, jurisdiction: "TW", identityHash, nonce: cur?.attNonce ?? 0n, deadline: t + 3600n,
  });
  mustAccept(r, "身分登記");
  return { txHash: eventHash(r.event), identityHash, seq: r.event.seq };
}

// ── 專案與核發 ──

export function ledgerProjects(owner?: string | null) {
  const { state } = ledgerView();
  return [...state.projects.values()]
    .filter((p) => !owner || low(p.owner) === low(owner))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((p) => ({
      projectId: Number(p.id), owner: p.owner, name: p.name, methodology: p.methodology, location: p.location,
      metadataURI: p.metadataURI, active: p.active, country: p.country, scheme: p.scheme,
    }));
}

export function ledgerProject(projectId: number) {
  const p = ledgerView().state.projects.get(String(projectId));
  return p ? { owner: p.owner, name: p.name, active: p.active } : null;
}

/// 查驗機構簽一筆 issue 事件。回傳新批次的編號（引擎依序配號）。
export async function ledgerIssue(a: {
  projectId: bigint; monitoringStart: bigint; monitoringEnd: bigint; amountKg: bigint; serialHash: Hex; reportHash: Hex; attestationId: bigint;
}) {
  const r = await appendAuthority("issue", { ...a, deadline: now() + 3600n });
  mustAccept(r, "核發");
  const b = [...ledgerView().state.batches.values()].find((x) => x.atSeq === r.event.seq);
  if (!b) throw new ApiError("INTERNAL", "核發已寫進帳本，但找不到新批次");
  return { txHash: eventHash(r.event), batchId: Number(b.id) };
}

// ── 註銷憑證 ──

type CertRow = {
  certId: number; batchId: number; amountKg: number; beneficiary: string; purpose: number; memo: string; retiredBy: Address; retiredAt: number;
  documentHash: Hex; txHash: Hex; beneficiaryHash: Hex; officialNo: string; officialAnnouncedAt: number; country: string; scheme: string;
  claimableFrom: number | null; owner: Address;
};

export function ledgerCertificates(account?: string | null): CertRow[] {
  const { state } = ledgerView();
  return [...state.certificates.values()]
    .filter((c) => !account || low(c.account) === low(account))
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map((c) => ({
      certId: Number(c.id), batchId: Number(c.batchId), amountKg: Number(c.amountKg), beneficiary: c.beneficiary, purpose: c.purpose,
      memo: c.memo, retiredBy: c.account, retiredAt: Number(c.retiredAt), documentHash: c.documentHash ?? ZERO32,
      txHash: hashAt(c.atSeq), beneficiaryHash: c.beneficiaryHash, officialNo: c.officialRef, officialAnnouncedAt: Number(c.officialAt),
      country: c.country, scheme: c.scheme,
      claimableFrom: c.officialAt > 0n ? addWorkingDays(Number(c.officialAt), 5) : null,
      owner: c.account,
    }));
}

export function ledgerCertData(certId: number): CertData {
  const { state } = ledgerView();
  const c = state.certificates.get(String(certId));
  if (!c) throw new ApiError("CERTIFICATE_NOT_FOUND");
  const b = state.batches.get(String(c.batchId));
  const p = b ? state.projects.get(String(b.projectId)) : undefined;
  return {
    certId, chainId: deployment().chainId, certificateContract: deployment().ledger!, batchId: Number(c.batchId), amountKg: Number(c.amountKg),
    beneficiary: c.beneficiary, beneficiaryHash: c.beneficiaryHash, purpose: c.purpose, memo: c.memo, retiredBy: c.account, retiredAt: Number(c.retiredAt),
    txHash: hashAt(c.atSeq), owner: c.account,
    project: { id: Number(b?.projectId ?? 0n), name: p?.name ?? "", methodology: p?.methodology ?? "", location: p?.location ?? "" },
    vintageYear: b?.vintageYear ?? 0, monitoringStart: Number(b?.monitoringStart ?? 0n), monitoringEnd: Number(b?.monitoringEnd ?? 0n),
    verifier: b?.verifier ?? "", serialHash: b?.serialHash ?? ZERO32, reportHash: b?.reportHash ?? ZERO32,
  };
}

/// 文件簽章金鑰把憑證 PDF 的雜湊寫進帳本。寫過就不能改（引擎擋）。
export async function ledgerAnchorCertificate(certId: number, documentHash: Hex) {
  const c = ledgerView().state.certificates.get(String(certId));
  if (!c) throw new ApiError("CERTIFICATE_NOT_FOUND");
  if (c.documentHash) throw new ApiError("ALREADY_EXISTS", "帳本裡已有這張憑證的文件雜湊，不可覆寫");
  const r = await appendAuthority("certDocument", { certId: BigInt(certId), documentHash });
  mustAccept(r, "文件雜湊回寫");
  return { txHash: eventHash(r.event) };
}

// ── 費率 ──

export function ledgerFees() {
  const { state } = ledgerView();
  const rows = [...state.jurisdictions.values()]
    .sort((a, b) => (a.domestic === b.domestic ? a.country.localeCompare(b.country) : a.domestic ? -1 : 1))
    .map((j) => {
      const f = state.fees.byCountry.get(j.country);
      return {
        // 設回和預設相同的數字就等於沒有自訂（帳本的 fees 事件沒有「刪除」）
        country: j.country, name: j.name, scheme: j.scheme, enabled: j.enabled, domestic: j.domestic,
        custom: !!f && (f.tradeBps !== state.fees.tradeBps || f.retireFeePerTonne !== state.fees.retireFeePerTonne),
        tradeBps: Number(f?.tradeBps ?? state.fees.tradeBps), retireFeePerTonne: String(f?.retireFeePerTonne ?? state.fees.retireFeePerTonne),
      };
    });
  return {
    enabled: true, defaultTradeBps: Number(state.fees.tradeBps), defaultRetireFeePerTonne: String(state.fees.retireFeePerTonne), rows,
  };
}

/// 營運金鑰設定費率。`country` 空字串 = 預設值。
///
/// 帳本的 fees 事件沒有「取消自訂」：要回到預設值，就把該國設成和預設相同的數字。
export async function ledgerSetFees(country: string, tradeBps: number, retireFeePerTonne: bigint, createdBy = "admin") {
  // 營運角色是 k-of-n（簽章模型方案 B）：門檻大於 1 時建立提案，等營運 Safe 的持有人簽署
  const r = await appendAuthorityOrPropose("fees", { country, tradeBps: BigInt(tradeBps), retireFeePerTonne }, {
    createdBy, note: `費率 ${country || "預設"}：交易 ${tradeBps} bps、註銷每噸 ${retireFeePerTonne}`,
  });
  if ("proposal" in r) return { proposal: r.proposal.id, required: r.required };
  mustAccept(r.appended, "費率設定");
  return { txHash: eventHash(r.appended.event) };
}
