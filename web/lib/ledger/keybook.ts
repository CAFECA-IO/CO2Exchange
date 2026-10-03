import { size, slice, type Address, type Hex, type PublicClient } from "viem";
import { readIdentityLogs, readKeyLogs, readMemberLogs, readModuleLogs, type Range } from "./chain.ts";
import type { Event, EventOf } from "./events.ts";
import { buildKeyBook, decodeMemberSignature, emptyKeyBook, type EntityBook, type KeyBook } from "./signatures.ts";

/// 查核用的金鑰簿：帳本裡的 `userKey` 鏡像（座標）＋ 鏈上的 KeyAdded／KeyRemoved／模組事件（有效區間）。
/// 有法人帳戶簽的事件時，另外讀 MemberValidator 的成員事件與 IdentityRegistry v2 的實名事件。
///
/// 只讀**事件**，不讀合約狀態——事件不會被裁剪，所以不需要 archive 節點。
/// 不依賴 Next：查核機構的工具直接 import。
export async function loadKeyBook(client: PublicClient, opts: {
  keyring: Address | null;
  events: Event[];
  /// CAFECA keyring 的事件從哪一塊開始讀（帳戶可能早於帳本部署就建立了）。預設 0
  fromBlock?: bigint;
  toBlock?: bigint;
  rpIdHash?: Hex;
  /// 增量索引（見 logindex.ts）。查核不給
  index?: Range["index"];
  /// 法人帳戶（CAFECA issue #1）。沒有給、而帳本裡有法人簽的事件 → 回報問題
  memberValidator?: Address | null;
  identityRegistry?: Address | null;
  chainId?: number;
  /// 收單時用：只建這幾個帳戶的金鑰簿（帳本還沒有這一筆事件，從事件裡找不到法人帳戶）
  accounts?: Address[];
  entityAccounts?: Address[];
}): Promise<{ book: KeyBook; problems: string[] }> {
  const only = opts.accounts ? new Set(opts.accounts.map((a) => a.toLowerCase())) : null;
  const mirrors = opts.events.filter((e): e is EventOf<"userKey"> => e.kind === "userKey" && (!only || only.has(e.account.toLowerCase())));
  if (!opts.keyring) {
    return {
      book: emptyKeyBook(),
      problems: mirrors.length ? [`帳本裡有 ${mirrors.length} 筆 CAFECA 金鑰鏡像，但沒有設定 keyring 位址（CAFECA_KEYRING）`] : [],
    };
  }
  const mv = opts.memberValidator?.toLowerCase();
  // 法人帳戶：帳本裡由 MemberValidator 簽的使用者事件
  const entities = new Set<string>((opts.entityAccounts ?? []).map((a) => a.toLowerCase()));
  if (!opts.entityAccounts) {
    for (const e of opts.events) {
      const sig = (e as { signature?: Hex }).signature;
      const acct = (e as { account?: Address }).account;
      if (!sig || !acct || e.kind === "userKey" || size(sig) <= 65 || size(sig) < 20) continue;
      const prefix = slice(sig, 0, 20).toLowerCase();
      if (mv ? prefix === mv : decodeMemberSignature(sig) && prefix !== opts.keyring.toLowerCase()) entities.add(acct.toLowerCase());
    }
  }
  const problems: string[] = [];
  if (entities.size && (!opts.memberValidator || !opts.identityRegistry || !opts.chainId)) {
    problems.push(`帳本裡有 ${entities.size} 個法人帳戶簽的事件，但沒有設定 CAFECA 的 MemberValidator／IdentityRegistry 位址（CAFECA_MEMBER_VALIDATOR、CAFECA_IDENTITY_REGISTRY）`);
  }

  const range: Range = { fromBlock: opts.fromBlock ?? 0n, toBlock: opts.toBlock, index: opts.index };
  const accounts = [...new Set([...mirrors.map((m) => m.account.toLowerCase()), ...entities])] as Address[];
  const withEntity = entities.size > 0 && !!opts.memberValidator && !!opts.identityRegistry && !!opts.chainId;
  const [keyLogs, moduleLogs, memberLogs, identityLogs] = await Promise.all([
    readKeyLogs(client, opts.keyring, range),
    readModuleLogs(client, accounts, range),
    withEntity ? readMemberLogs(client, opts.memberValidator!, range) : Promise.resolve([]),
    withEntity ? readIdentityLogs(client, opts.identityRegistry!, range) : Promise.resolve([]),
  ]);
  const built = buildKeyBook({
    keyring: opts.keyring,
    mirrors: mirrors.map((m) => ({ account: m.account, keyId: m.keyId, qx: m.qx, qy: m.qy, rpIdHash: m.rpIdHash, validator: m.validator, ref: { txHash: m.ref.txHash, logIndex: m.ref.logIndex } })),
    keyLogs, moduleLogs, rpIdHash: opts.rpIdHash,
  });
  if (withEntity) built.book.entity = buildEntityBook({ memberValidator: opts.memberValidator!, chainId: opts.chainId!, memberLogs, identityLogs });
  return { book: built.book, problems: [...problems, ...built.problems] };
}

const byPos = (x: { block: bigint; logIndex: number }, y: { block: bigint; logIndex: number }) =>
  x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1;

/// 鏈上事件 → 法人簽章要查的三條時間軸。
export function buildEntityBook(o: {
  memberValidator: Address; chainId: number;
  memberLogs: { entity: Address; member: Address; role: number; block: bigint; logIndex: number }[];
  identityLogs: { name: string; args: Record<string, unknown>; block: bigint; logIndex: number }[];
}): EntityBook {
  const book: EntityBook = { memberValidator: o.memberValidator, chainId: o.chainId, members: new Map(), identity: new Map(), signers: new Map() };
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k) ?? []; l.push(v); m.set(k, l); };
  for (const l of [...o.memberLogs].sort(byPos)) push(book.members, `${l.entity.toLowerCase()}|${l.member.toLowerCase()}`, { block: l.block, logIndex: l.logIndex, role: l.role });
  for (const l of [...o.identityLogs].sort(byPos)) {
    const a = l.args;
    if (l.name === "SignerSet") { push(book.signers, String(a.signer).toLowerCase(), { block: l.block, logIndex: l.logIndex, cls: Number(a.signerClass) }); continue; }
    const kind = l.name === "Attested" ? "attested" : l.name === "Suspended" ? "suspended" : l.name === "Revoked" ? "revoked" : null;
    if (!kind) continue;
    push(book.identity, String(a.account).toLowerCase(), {
      block: l.block, logIndex: l.logIndex, kind,
      level: kind === "attested" ? Number(a.level) : 0, expiry: kind === "attested" ? BigInt(a.expiry as number) : 0n,
      signer: (kind === "attested" ? a.signer : "0x0000000000000000000000000000000000000000") as Address,
    });
  }
  return book;
}
