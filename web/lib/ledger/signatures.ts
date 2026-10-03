import { p256 } from "@noble/curves/p256";
import {
  bytesToHex, concat, decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, recoverAddress, sha256, size, slice,
  type Address, type Hex,
} from "viem";
import { isAuthorized, thresholdAt, type Authorities, type Role } from "./authorities.ts";

/// 不需要歷史狀態的驗簽（設計 v4 §三 2026-09-28 修正；簽章模型 `signature-model-decisions.md`）。
///
/// 決定不用 archive 節點之後，查核者不能在收單區塊呼叫帳戶合約的 `isValidSignature`。
/// 所以這裡只用「鏈上事件」與「簽章本身」判斷，**不讀任何合約狀態**：
///
///   · 65 bytes 的簽章 → ecrecover，必須等於簽章者（服務金鑰、開發帳戶）
///   · CAFECA 帳戶的 ERC-1271 簽章 → 依 CAFECA README §5 的版面解析，驗 WebAuthn ES256；
///     公鑰與它的有效區間來自 keyring 的 `KeyAdded`／`KeyRemoved` 事件（事件不會被裁剪）
///   · 授權事件 → k-of-n：簽章欄位是 k 個 65 bytes 簽章接在一起，簽章者各不相同、
///     都在收單區塊擁有該角色，且數量達到該角色當時的門檻
///
/// 不依賴 Next、不讀鏈——查核機構拿到帳本與鏈上事件就能單獨跑。
///
/// **注意**：CAFECA README §5 說明上線前會加上 ERC-7739 包裝，簽章版面會改變（`isValidSignature` 的呼叫方式不變）。
/// 到時候 `decodeCafecaSignature` 與 challenge 的比對要跟著改；收單時的 ERC-1271 檢查不受影響，
/// 但兩道檢查不一致的簽章會被拒收，所以改版當天會直接看到錯誤，而不是悄悄收下驗不回去的單。

export type SigCheck = { ok: boolean; reason?: string; trusted?: boolean };

// ── CAFECA ERC-1271 簽章 ──

/// CAFECA README §5.2：`validator (20 bytes) ‖ abi.encode(SignatureData)`。
const SIGNATURE_DATA = [{
  type: "tuple",
  components: [
    { name: "keyId", type: "bytes32" },
    { name: "sig", type: "tuple", components: [
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ] },
  ],
}] as const;

export type CafecaSig = {
  validator: Address; keyId: Hex; authenticatorData: Hex; clientDataJSON: string;
  challengeIndex: bigint; typeIndex: bigint; r: Hex; s: Hex;
};

export function decodeCafecaSignature(signature: Hex): CafecaSig | null {
  try {
    if (size(signature) < 20 + 32 * 9) return null;
    const validator = slice(signature, 0, 20) as Address;
    const [d] = decodeAbiParameters(SIGNATURE_DATA, slice(signature, 20));
    return { validator, keyId: d.keyId, ...d.sig };
  } catch { return null; }
}

/// 同一個版面反過來編碼（測試與本機工具用）。
export function encodeCafecaSignature(s: CafecaSig): Hex {
  return concat([s.validator, encodeAbiParameters(SIGNATURE_DATA, [{ keyId: s.keyId, sig: {
    authenticatorData: s.authenticatorData, clientDataJSON: s.clientDataJSON, challengeIndex: s.challengeIndex,
    typeIndex: s.typeIndex, r: s.r, s: s.s,
  } }])]);
}

export const keyIdOf = (qx: Hex, qy: Hex): Hex => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const P256_HALF_N = p256.CURVE.n >> 1n;
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

/// 一把 passkey 在帳本眼中的樣子：公鑰、登記時的 rpIdHash，以及它在鏈上的有效區間。
export type KeyRecord = {
  account: Address; keyId: Hex; qx: Hex; qy: Hex; rpIdHash: Hex; validator: Address;
  /// KeyAdded 所在區塊（含）
  from: bigint;
  /// KeyRemoved 所在區塊（不含）；null ＝ 仍有效
  until: bigint | null;
};
/// 帳戶的驗證模組安裝區間（`ModuleInstalled`／`ModuleUninstalled`，module type 1）。
export type ModuleSpan = { module: Address; from: bigint; until: bigint | null };

/// 法人帳戶（CAFECA issue #1）：法人沒有自己的金鑰，由「成員」以自己的 Passkey 代簽。
/// 查核要知道三件事，全部來自鏈上事件：成員在那個區塊有沒有角色（MemberValidator 的 `MemberSet`）、
/// 成員那時是不是有效 L2（IdentityRegistry v2 的 `Attested`／`Suspended`／`Revoked`／`SignerSet`）、
/// 成員的金鑰（和自然人一樣：帳本的 `userKey` 鏡像＋ keyring 的事件）。
export type MemberChange = { block: bigint; logIndex: number; role: number };
export type IdentityChange = { block: bigint; logIndex: number; kind: "attested" | "suspended" | "revoked"; level: number; expiry: bigint; signer: Address };
export type SignerChange = { block: bigint; logIndex: number; cls: number };
export type EntityBook = {
  memberValidator: Address;
  chainId: number;
  /// 法人｜成員 → 角色變動（依區塊排序）
  members: Map<string, MemberChange[]>;
  /// 帳戶 → 實名狀態變動
  identity: Map<string, IdentityChange[]>;
  /// 簽章者 → 等級變動（0 NONE、1 PROTOTYPE、2 PRODUCTION）
  signers: Map<string, SignerChange[]>;
};

export type KeyBook = {
  /// CAFECA 的 KeyringValidator 位址。沒有（本機鏈）＝不接受 CAFECA 簽章
  keyring: Address | null;
  /// 法人帳戶簽章需要的事件。沒有＝不接受法人帳戶的簽章
  entity?: EntityBook;
  /// 帳戶｜keyId → 這把金鑰的每一段有效區間（移除後再加回來會有多段）
  keys: Map<string, KeyRecord[]>;
  /// 帳戶 → 驗證模組區間。帳戶不在這張表裡代表沒讀到它的模組事件——那樣就不能確認 keyring 當時有裝，一律拒收
  modules: Map<string, ModuleSpan[]>;
  /// 可選：CAFECA 錢包的 rpIdHash（sha256(RP ID)）。給了就多檢查一次
  rpIdHash?: Hex;
};

export const emptyKeyBook = (): KeyBook => ({ keyring: null, keys: new Map(), modules: new Map() });
const keyOf = (account: string, keyId: string) => `${account.toLowerCase()}|${keyId.toLowerCase()}`;
const within = (from: bigint, until: bigint | null, at: bigint) => from <= at && (until === null || at < until);

export function verifyWebAuthn(digest: Hex, s: CafecaSig, key: { qx: Hex; qy: Hex; rpIdHash: Hex }): SigCheck {
  const auth = hexToBytes(s.authenticatorData);
  if (auth.length < 37) return { ok: false, reason: "authenticatorData 太短" };
  if (bytesToHex(auth.slice(0, 32)).toLowerCase() !== key.rpIdHash.toLowerCase()) return { ok: false, reason: "rpIdHash 與金鑰登記時不符" };
  const flags = auth[32];
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return { ok: false, reason: "WebAuthn 旗標缺少 UP／UV" };
  if ((flags & FLAG_AT) !== 0) return { ok: false, reason: "WebAuthn 旗標不可有 AT" };
  const cdj = new TextEncoder().encode(s.clientDataJSON);
  const at = (i: bigint, want: string) => {
    const w = new TextEncoder().encode(want);
    const start = Number(i);
    if (start < 0 || start + w.length > cdj.length) return false;
    for (let k = 0; k < w.length; k++) if (cdj[start + k] !== w[k]) return false;
    return true;
  };
  if (!at(s.typeIndex, '"type":"webauthn.get"')) return { ok: false, reason: "clientDataJSON 的 type 不是 webauthn.get" };
  if (!at(s.challengeIndex, `"challenge":"${b64url(hexToBytes(digest))}"`)) return { ok: false, reason: "clientDataJSON 的 challenge 不是這筆事件的 digest" };
  const r = BigInt(s.r), sv = BigInt(s.s);
  if (sv === 0n || r === 0n || sv > P256_HALF_N) return { ok: false, reason: "P-256 簽章不是 low-s" };
  const msgHash = hexToBytes(sha256(concat([s.authenticatorData, sha256(bytesToHex(cdj))])));
  const pub = hexToBytes(concat(["0x04", key.qx, key.qy]));
  const sig = hexToBytes(concat([s.r, s.s]));
  let ok = false;
  try { ok = p256.verify(sig, msgHash, pub, { prehash: false, lowS: false }); } catch { ok = false; }
  return ok ? { ok: true } : { ok: false, reason: "P-256 簽章驗證失敗" };
}

// ── 法人帳戶（MemberValidator） ──

const MEMBER_SIG = [{ type: "tuple", components: [{ name: "member", type: "address" }, { name: "signature", type: "bytes" }] }] as const;
export type MemberSig = { validator: Address; member: Address; signature: Hex };

/// 法人帳戶的 ERC-1271 簽章：`MemberValidator (20 bytes) ‖ abi.encode(MemberSig{member, signature})`，
/// 其中 signature 是成員自己帳戶的 ERC-1271 簽章（KeyringValidator 版面）。
export function decodeMemberSignature(signature: Hex): MemberSig | null {
  try {
    if (size(signature) < 20 + 32 * 4) return null;
    const validator = slice(signature, 0, 20) as Address;
    const [d] = decodeAbiParameters(MEMBER_SIG, slice(signature, 20));
    return { validator, member: d.member, signature: d.signature };
  } catch { return null; }
}
export function encodeMemberSignature(m: MemberSig): Hex {
  return concat([m.validator, encodeAbiParameters(MEMBER_SIG, [{ member: m.member, signature: m.signature }])]);
}

const ENTITY_TYPEHASH = keccak256(new TextEncoder().encode("CAFECA_ENTITY_V1"));
/// 成員實際簽的雜湊：把法人、鏈與 MemberValidator 綁進去（MemberValidator.entityHash），
/// 成員個人簽過的訊息不會被當成法人簽章，反之亦然。
export function entityHashOf(chainId: number, memberValidator: Address, entity: Address, hash: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
    [ENTITY_TYPEHASH, BigInt(chainId), memberValidator, entity, hash],
  ));
}

const upTo = <T extends { block: bigint }>(list: T[] | undefined, block: bigint) => (list ?? []).filter((x) => x.block <= block).at(-1);

/// 成員在那個區塊的角色（0 NONE、1 OPERATOR、2 ADMIN）。
export function memberRoleAt(e: EntityBook, entity: Address, member: Address, block: bigint): number {
  return upTo(e.members.get(`${entity.toLowerCase()}|${member.toLowerCase()}`), block)?.role ?? 0;
}

/// 帳戶在那個區塊的有效實名等級（IdentityRegistry v2 的 _effective）：ACTIVE、未過期、簽章者仍有效。
/// `time` 是事件的收單時間（合約用 block.timestamp；收單時間與收單區塊的時間差不到一塊）。
export function effectiveLevelAt(e: EntityBook, account: Address, block: bigint, time: bigint): number {
  const last = upTo(e.identity.get(account.toLowerCase()), block);
  if (!last || last.kind !== "attested") return 0;
  if (last.expiry < time) return 0;
  const cls = upTo(e.signers.get(last.signer.toLowerCase()), block)?.cls ?? 0;
  return cls === 0 ? 0 : last.level;
}

async function verifyEntitySignature(
  a: { account: Address; digest: Hex; signature: Hex; atBlock: bigint; atTime?: bigint }, book: KeyBook, e: EntityBook,
): Promise<SigCheck> {
  const m = decodeMemberSignature(a.signature);
  if (!m) return { ok: false, reason: "法人帳戶的簽章格式錯誤" };
  const spans = book.modules.get(a.account.toLowerCase());
  if (!spans?.some((s) => s.module.toLowerCase() === e.memberValidator.toLowerCase() && within(s.from, s.until, a.atBlock))) {
    return { ok: false, reason: `帳戶在區塊 ${a.atBlock} 沒有安裝 MemberValidator` };
  }
  const role = memberRoleAt(e, a.account, m.member, a.atBlock);
  if (role === 0) return { ok: false, reason: `${m.member} 在區塊 ${a.atBlock} 不是這個法人的成員` };
  if (a.atTime === undefined) return { ok: false, reason: "驗法人簽章需要收單時間" };
  if (effectiveLevelAt(e, m.member, a.atBlock, a.atTime) < 2) return { ok: false, reason: `成員 ${m.member} 在區塊 ${a.atBlock} 不是有效的 L2 實名` };
  if (size(m.signature) === 65) return { ok: false, reason: "成員的簽章必須是 CAFECA 帳戶簽章" };
  // 成員的簽章用成員自己的金鑰驗；不允許巢狀的法人簽章
  const inner = await verifyUserSignature(
    { account: m.member, digest: entityHashOf(e.chainId, e.memberValidator, a.account, a.digest), signature: m.signature, atBlock: a.atBlock },
    { ...book, entity: undefined },
  );
  return inner.ok ? { ok: true } : { ok: false, reason: `成員 ${m.member.slice(0, 10)}… 的簽章：${inner.reason}` };
}

/// 使用者（或單一金鑰）簽章：65 bytes → ecrecover；否則當作 CAFECA ERC-1271（個人帳戶或法人帳戶）。
export async function verifyUserSignature(
  a: { account: Address; digest: Hex; signature: Hex; atBlock: bigint; atTime?: bigint },
  book: KeyBook,
): Promise<SigCheck> {
  if (size(a.signature) === 65) {
    try {
      const who = await recoverAddress({ hash: a.digest, signature: a.signature });
      return who.toLowerCase() === a.account.toLowerCase() ? { ok: true } : { ok: false, reason: "簽章者不符" };
    } catch { return { ok: false, reason: "簽章格式錯誤" }; }
  }
  if (book.entity && size(a.signature) >= 20 && slice(a.signature, 0, 20).toLowerCase() === book.entity.memberValidator.toLowerCase()) {
    return verifyEntitySignature(a, book, book.entity);
  }
  const s = decodeCafecaSignature(a.signature);
  if (!s) return { ok: false, reason: "簽章既不是 ECDSA 也不是 CAFECA 格式" };
  if (!book.keyring || s.validator.toLowerCase() !== book.keyring.toLowerCase()) {
    return { ok: false, reason: `驗證模組 ${s.validator} 不是 CAFECA KeyringValidator` };
  }
  const spans = book.modules.get(a.account.toLowerCase());
  if (!spans?.some((m) => m.module.toLowerCase() === s.validator.toLowerCase() && within(m.from, m.until, a.atBlock))) {
    return { ok: false, reason: `帳戶在區塊 ${a.atBlock} 沒有安裝 KeyringValidator` };
  }
  const spans2 = book.keys.get(keyOf(a.account, s.keyId));
  if (!spans2?.length) return { ok: false, reason: `帳戶沒有金鑰 ${s.keyId.slice(0, 10)}… 的登記紀錄` };
  const key = spans2.find((k) => within(k.from, k.until, a.atBlock));
  if (!key) return { ok: false, reason: `金鑰在區塊 ${a.atBlock} 不是有效狀態` };
  if (book.rpIdHash && key.rpIdHash.toLowerCase() !== book.rpIdHash.toLowerCase()) return { ok: false, reason: "金鑰的 rpIdHash 不是 CAFECA 錢包" };
  return verifyWebAuthn(a.digest, s, key);
}

/// 授權事件：k 個 65 bytes 簽章接在一起（k = 1 時就是一般的單一簽章）。
export async function verifyAuthoritySignatures(
  a: { role: Role; signer: Address; digest: Hex; signature: Hex; atBlock: bigint },
  authorities: Authorities,
): Promise<SigCheck> {
  const n = size(a.signature);
  if (n === 0 || n % 65 !== 0) return { ok: false, reason: "授權事件的簽章長度要是 65 的倍數" };
  const seen = new Set<string>();
  for (let i = 0; i < n; i += 65) {
    let who: Address;
    try { who = await recoverAddress({ hash: a.digest, signature: slice(a.signature, i, i + 65) }); } catch { return { ok: false, reason: `第 ${i / 65 + 1} 個簽章格式錯誤` }; }
    const k = who.toLowerCase();
    if (seen.has(k)) return { ok: false, reason: `簽章者 ${who} 重複` };
    if (!isAuthorized(authorities, a.role, who, a.atBlock)) return { ok: false, reason: `${who} 在區塊 ${a.atBlock} 沒有 ${a.role} 授權` };
    seen.add(k);
  }
  if (!seen.has(a.signer.toLowerCase())) return { ok: false, reason: "signer 欄位不在簽章者之中" };
  const k = thresholdAt(authorities, a.role, a.atBlock);
  if (seen.size < k) return { ok: false, reason: `${a.role} 在區塊 ${a.atBlock} 需要 ${k} 個簽章，只有 ${seen.size} 個` };
  return { ok: true };
}

// ── 從鏈上事件建金鑰簿 ──

export type KeyLog = { kind: "added" | "removed"; account: Address; keyId: Hex; block: bigint; txHash: Hex; logIndex: number };
export type ModuleLog = { kind: "installed" | "uninstalled"; account: Address; moduleType: bigint; module: Address; block: bigint; logIndex: number };
export type KeyMirror = { account: Address; keyId: Hex; qx: Hex; qy: Hex; rpIdHash: Hex; validator: Address; ref: { txHash: Hex; logIndex: number } };

/// 帳本裡的 `userKey` 鏡像事件提供公鑰座標（`KeyAdded` 事件本身只有 keyId）；
/// 每一筆都要對得到鏈上真的有那一筆 `KeyAdded`，而且 keccak(qx, qy) = keyId——座標因此不可能造假。
export function buildKeyBook(opts: {
  keyring: Address | null; mirrors: KeyMirror[]; keyLogs: KeyLog[]; moduleLogs: ModuleLog[]; rpIdHash?: Hex;
}): { book: KeyBook; problems: string[] } {
  const problems: string[] = [];
  const book: KeyBook = { keyring: opts.keyring, keys: new Map(), modules: new Map(), rpIdHash: opts.rpIdHash };
  const addedAt = new Map<string, KeyLog>();
  for (const l of opts.keyLogs) if (l.kind === "added") addedAt.set(`${l.txHash.toLowerCase()}:${l.logIndex}`, l);
  const removals = opts.keyLogs.filter((l) => l.kind === "removed");

  for (const m of opts.mirrors) {
    const log = addedAt.get(`${m.ref.txHash.toLowerCase()}:${m.ref.logIndex}`);
    if (!log || log.account.toLowerCase() !== m.account.toLowerCase() || log.keyId.toLowerCase() !== m.keyId.toLowerCase()) {
      problems.push(`帳本的金鑰鏡像 ${m.keyId.slice(0, 10)}…（${m.account}）在鏈上找不到對應的 KeyAdded`);
      continue;
    }
    if (keyIdOf(m.qx, m.qy).toLowerCase() !== m.keyId.toLowerCase()) {
      problems.push(`帳本的金鑰鏡像 ${m.keyId.slice(0, 10)}… 的座標與 keyId 不符`);
      continue;
    }
    // 同一把金鑰移除後再加回來會有兩段；鏡像指的是哪一次 KeyAdded，就從那一塊算起，到它之後第一次移除為止
    const removed = removals
      .filter((r) => r.account.toLowerCase() === m.account.toLowerCase() && r.keyId.toLowerCase() === m.keyId.toLowerCase() && r.block >= log.block)
      .sort((x, y) => (x.block < y.block ? -1 : 1))[0];
    const rec: KeyRecord = { ...m, from: log.block, until: removed ? removed.block : null };
    const k = keyOf(m.account, m.keyId);
    const list = book.keys.get(k) ?? [];
    if (!list.some((x) => x.from === rec.from)) list.push(rec);
    book.keys.set(k, list);
  }

  const sorted = [...opts.moduleLogs].filter((l) => l.moduleType === 1n).sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
  for (const l of sorted) {
    const a = l.account.toLowerCase();
    const spans = book.modules.get(a) ?? [];
    if (l.kind === "installed") spans.push({ module: l.module, from: l.block, until: null });
    else {
      const open = spans.find((s) => s.module.toLowerCase() === l.module.toLowerCase() && s.until === null);
      if (open) open.until = l.block;
    }
    book.modules.set(a, spans);
  }
  return { book, problems };
}
