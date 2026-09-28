import { keccak256, toBytes, type Address, type Hex } from "viem";
import { ApiError, fail, handleError, ok } from "@/lib/server/api";
import { refuseIfRecovering, requireRole } from "@/lib/server/roles";
import { ledgerEnabled, ledgerView } from "@/lib/server/ledger/view";
import {
  appendUser, devDeposit, devSign, devSignerFor, domains, nextNonce, syncCash, userMessage, type UserBody,
} from "@/lib/server/ledger/write";
import { userTypedData } from "@/lib/ledger/typed";

/// 帳本的使用者入口（設計 v4 第 3 期）：掛單、撤單、註銷、登錄專案。
///
/// 兩步：
///   1. `prepare`：伺服器把使用者填的東西正規化（補 nonce、期限、受益人雜湊），回傳**要簽的那一包**。
///      前端不自己組 typed data——兩邊各組一份，欄位差一個 digest 就不一樣，而錯誤只會說「簽章無效」。
///   2. `submit`：把 prepare 回來的 `message` 原封不動當 `fields`、連同 `nonce` 與簽章帶回來
///      （期限、受益人雜湊這類預設值是 prepare 當下補的，重算一次就會變）。伺服器在現在的區塊高度驗章，驗過才寫進帳本，回簽收收據。
///
/// 開發用登入（本機鏈）沒有 CAFECA 通道，`submit` 不帶簽章時由伺服器用推出來的私鑰代簽——
/// 簽出來的是真的簽章，查核工具照樣驗得過。
///
/// **這一支不撮合**：撮合是重播帳本的結果。回應裡的成交是寫進去之後重播出來的，不是這裡算的。

type UserKind = "place" | "cancel" | "retire" | "project";
type Raw = Record<string, unknown>;

const big = (v: unknown, name: string, { min = 0n }: { min?: bigint } = {}): bigint => {
  if (v === undefined || v === null || v === "") throw new ApiError("MISSING_PARAM", `缺少 ${name}`, { param: name });
  let x: bigint;
  try { x = BigInt(String(v)); } catch { throw new ApiError("INVALID_PARAM", `${name} 不是整數`, { param: name }); }
  if (x < min) throw new ApiError("INVALID_PARAM", `${name} 要大於等於 ${min}`, { param: name });
  return x;
};
const str = (v: unknown, name: string, max: number, { required = false } = {}): string => {
  const s = String(v ?? "").trim();
  if (required && !s) throw new ApiError("MISSING_PARAM", `缺少 ${name}`, { param: name });
  if (s.length > max) throw new ApiError("INVALID_PARAM", `${name} 超過 ${max} 字`, { param: name });
  return s;
};

/// 使用者填的欄位 → 要簽的內容。`nonce` 由伺服器給（prepare）或沿用簽過的那個（submit）。
function bodyOf(kind: UserKind, account: Address, f: Raw, nonce: bigint): UserBody<UserKind> {
  switch (kind) {
    case "place": {
      const side = f.side === "buy" || f.side === "sell" ? f.side : null;
      if (!side) throw new ApiError("INVALID_PARAM", "side 只能是 buy 或 sell", { param: "side" });
      const batchId = big(f.batchId ?? 0, "batchId");
      if (side === "sell" && batchId === 0n) throw new ApiError("INVALID_PARAM", "賣單要指定批次", { param: "batchId" });
      const country = str(f.country ?? "", "country", 2).toUpperCase();
      if (side === "buy" && batchId === 0n && !/^[A-Z]{2}$/.test(country)) throw new ApiError("INVALID_PARAM", "不指定批次的買單要指定核發國", { param: "country" });
      // 沒帶期限就給 30 日——交易拍賣及移轉管理辦法 §12①⑤ 的定價交易期間下限
      const expiry = f.expiry ? big(f.expiry, "expiry") : BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
      return {
        account, nonce, side, batchId, country: batchId === 0n ? country : "",
        amountKg: big(f.amountKg, "amountKg", { min: 1n }), pricePerTonne: big(f.pricePerTonne, "pricePerTonne", { min: 1n }),
        minFillKg: big(f.minFillKg ?? 0, "minFillKg"), expiry,
      } as UserBody<"place">;
    }
    case "cancel":
      return { account, nonce, orderSeq: big(f.orderSeq, "orderSeq", { min: 1n }) } as UserBody<"cancel">;
    case "retire": {
      const beneficiary = str(f.beneficiary, "beneficiary", 100, { required: true });
      const purpose = Number(f.purpose ?? 1);
      if (!Number.isInteger(purpose) || purpose < 0 || purpose > 7) throw new ApiError("INVALID_PARAM", "用途代碼不正確", { param: "purpose" });
      return {
        account, nonce, batchId: big(f.batchId, "batchId", { min: 1n }), amountKg: big(f.amountKg, "amountKg", { min: 1n }),
        beneficiary, beneficiaryHash: (f.beneficiaryHash as Hex | undefined) ?? keccak256(toBytes(beneficiary)),
        purpose, memo: str(f.memo, "memo", 200),
      } as UserBody<"retire">;
    }
    case "project":
      return {
        account, nonce, name: str(f.name, "name", 100, { required: true }), methodology: str(f.methodology, "methodology", 100, { required: true }),
        location: str(f.location, "location", 100, { required: true }), metadataURI: str(f.metadataURI, "metadataURI", 300),
      } as UserBody<"project">;
  }
}

const KINDS = new Set<UserKind>(["place", "cancel", "retire", "project"]);

export async function GET() {
  try {
    if (!ledgerEnabled()) return fail("DEPLOYMENT_MISMATCH", { message: "這個部署不是帳本 v2" });
    const m = await requireRole("user");
    const a = m.address.toLowerCase();
    const { state, head } = ledgerView();
    const orders = [...state.book.values()].filter((o) => o.account.toLowerCase() === a).sort((x, y) => (x.seq < y.seq ? 1 : -1));
    const fills = state.fills.filter((f) => f.buyer.toLowerCase() === a || f.seller.toLowerCase() === a).slice(-50).reverse();
    const credits = [...(state.credits.get(a) ?? new Map<string, bigint>()).entries()].map(([batchId, kg]) => ({ batchId, kg }));
    return ok({
      domains: domains(),
      account: m.address,
      nextNonce: nextNonce(m.address),
      devSigning: !!(await devSignerFor(m.address)),
      head,
      cash: { available: state.cash.get(a) ?? 0n, locked: state.lockedCash.get(a) ?? 0n },
      credits,
      orders,
      fills,
    });
  } catch (e) { return handleError(e); }
}

export async function POST(req: Request) {
  try {
    if (!ledgerEnabled()) return fail("DEPLOYMENT_MISMATCH", { message: "這個部署不是帳本 v2" });
    const m = await requireRole("user");
    const b = (await req.json()) as { op?: string; kind?: UserKind; fields?: Raw; nonce?: string; signature?: Hex };

    // 使用者剛在鏈上存入結算幣：把那筆存入鏡像進帳本。誰都可以觸發（它只記鏈上真的發生的事）。
    if (b.op === "sync") return ok({ mirrored: await syncCash() });

    // 開發帳戶（本機鏈）沒有 CAFECA 通道送不了鏈上交易，由伺服器用他推出來的私鑰代送存入
    if (b.op === "devDeposit") {
      const dev = await devSignerFor(m.address);
      if (!dev) throw new ApiError("FORBIDDEN", "只有本機鏈的開發用登入可以這樣存入");
      return ok({ mirrored: await devDeposit(dev, big((b as { amount?: string }).amount, "amount", { min: 1n })) });
    }

    if (!b.kind || !KINDS.has(b.kind)) return fail("UNSUPPORTED_ACTION", { details: { kind: b.kind } });
    refuseIfRecovering(m);
    const kind = b.kind;

    if (b.op === "prepare") {
      const body = bodyOf(kind, m.address, b.fields ?? {}, nextNonce(m.address));
      return ok({
        nonce: body.nonce,
        message: userMessage(kind, body),
        typedData: userTypedData(domains(), kind, userMessage(kind, body)),
        devSigning: !!(await devSignerFor(m.address)),
      });
    }

    if (b.op !== "submit") return fail("UNSUPPORTED_ACTION", { details: { op: b.op } });
    const body = bodyOf(kind, m.address, b.fields ?? {}, big(b.nonce, "nonce", { min: 1n }));
    let signature = b.signature;
    if (!signature) {
      const dev = await devSignerFor(m.address);
      if (!dev) throw new ApiError("MISSING_PARAM", "要帶簽章", { param: "signature" });
      signature = await devSign(dev, kind, body);
    }
    const r = await appendUser(kind, body, signature);
    const fills = ledgerView().state.fills.filter((f) => f.takerSeq === r.event.seq);
    return ok({ ...r, accepted: !r.rejectedReason, fills });
  } catch (e) { return handleError(e); }
}
