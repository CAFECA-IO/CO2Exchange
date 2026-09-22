import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, type Abi, type Hex } from "viem";
import { passkeyAccountAbi } from "@/lib/abis";
import { errorAbi } from "@/lib/error-abi";
import { isAddress, publicClient, relayerClient } from "@/lib/server/chain";
import { handle, isChainUnreachable, isDeploymentMismatch } from "@/lib/server/roles";

/// 把 revert 拆到看得懂為止。
///
/// 鏈上的錯誤是**一層包一層**的，而且不只一層：
///
///   PasskeyAccount.CallFailed(index, reason)      ← 哪一個動作失敗
///     └─ v4 PoolManager.WrappedError(target, selector, reason, details)
///          └─ CarbonKYCHook 擋下來 → NotActiveAccount(0x…)   ← 真正的原因
///          └─ details: HookCallFailed()
///
/// 只拆一層的話，使用者看到的是
/// `WrappedError(0xe447…, 0x575e24b4, 0xacf9e90a000…, 0xa9e35b2f)`——
/// 比原本的四個位元組好一點，但還是要自己去查 selector 才知道發生什麼事。
/// 所以這裡遞迴：任何一個 bytes 參數只要解得開就繼續往裡面拆，
/// 最後把那條路徑印出來，並對常見的原因附上一句「該怎麼辦」。
const MAX_DEPTH = 6;

/// 使用者真的會遇到的那幾個，給一句下一步。其餘的照原樣顯示就好——
/// 硬要為每一個 error 編一句話，只會讓真正有用的那幾句被淹沒。
const HINT: Record<string, string> = {
  NotActiveAccount: "這個帳戶在目前這條鏈上沒有有效的身分驗證。鏈重開或重新部署之後要重做一次 /kyc（KYC_AUTO_APPROVE=1 的話是即時的）。",
  IdentityExpired: "身分驗證過期了，到 /kyc 重新申請。",
  AccountFrozen: "這個錢包被凍結了。到「裝置與安全」用任何一把還在手上的 passkey 解凍；一把都不剩的話走復原程序。",
  UnknownKey: "這把 passkey 已經從錢包裡移除了（或從來沒加進去）。換一台還在清單裡的裝置操作。",
  KeyAlreadyExists: "這把 passkey 已經在錢包裡了，不需要再加一次。",
  LastKey: "這是最後一把 passkey，移除它會讓錢包永遠動不了。先加一台新裝置，再撤掉舊的。",
  NotSelf: "這個操作只能由錢包自己發動，也就是要有一把現存 passkey 簽字。",
  NotRecoveryAgent: "復原提案只有治理方能提出，而且要重新通過身分驗證。",
  NoPendingRecovery: "目前沒有進行中的復原提案。",
  RecoveryNotReady: "復原提案還在等待期內。等待期存在的理由就是讓你有時間否決它。",
  RecoveryPending: "已經有一個進行中的復原提案，先完成或否決它。",
  OrderInactive: "這張單已經被買走或取消了。模擬器在跑的時候很容易遇到——它假設自己是鏈上唯一的寫入者，掛單簿在它的記憶體裡。重新整理掛單簿再試。",
  ExceedsRemaining: "掛單剩餘量不足，多半是同一張單剛被別人吃掉（模擬器在跑的話尤其常見）。",
  PurposeNotAllowed: "這個轄區的額度不允許這個註銷用途。國外額度只能扣碳費或做自願性碳中和。",
  ERC20InsufficientBalance: "結算幣不夠。到 /trade 按「領取測試用 mTWD」。",
  ERC20InsufficientAllowance: "結算幣的授權額度不夠，重新送一次會一併補上授權。",
};

function describe(data: Hex, depth = 0): string | null {
  if (depth > MAX_DEPTH || !data || data === "0x") return null;
  let d;
  try {
    d = decodeErrorResult({ abi: errorAbi as unknown as Abi, data });
  } catch {
    return null;
  }
  const args = d.args ?? [];
  // 參數裡只要有解得開的 bytes，那一層就是信封，真正的原因在裡面
  for (const a of args) {
    if (typeof a === "string" && a.startsWith("0x") && a.length > 10) {
      const inner = describe(a as Hex, depth + 1);
      if (inner) return inner;
    }
  }
  const name = d.errorName;
  const shown = args.length ? `${name}(${args.map(String).join(", ")})` : name;
  return HINT[name] ? `${shown} — ${HINT[name]}` : shown;
}

function unwrap(errorName: string, args: readonly unknown[]): string {
  if (errorName !== "CallFailed") {
    const shown = args.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
    return HINT[errorName] ? `${shown} — ${HINT[errorName]}` : shown;
  }
  const [index, reason] = args as [bigint, Hex];
  const at = `第 ${Number(index) + 1} 個動作`;
  if (!reason || reason === "0x") return `${at}失敗，合約沒有給原因（多半是 require 沒帶訊息，或 gas 不足）`;
  const inner = describe(reason);
  return inner
    ? `${at}失敗：${inner}`
    : `${at}失敗：${reason.slice(0, 10)}（沒有對應的 error 定義，可能是合約改過但 lib/error-abi.ts 沒重新產生）`;
}

type Call = { target: string; value: string; data: string };

/// POST { account, calls, keyId, signature, mode? } → relayer 送出交易（平台付 gas）
///
/// `keyId` 說明這是**哪一把 passkey** 簽的。一個錢包可以有好幾把（手機一把、
/// 筆電一把），合約靠這個直接查，不必逐把試——逐把試會讓 gas 隨著裝置數上升。
///
/// `mode`：
///   · "execute"（預設）— 一般交易。帳戶凍結時一律擋下。
///   · "self"           — 帳戶對自己下的指令（加/撤裝置、解凍、否決復原）。
///     **凍結中仍然走得通**，否則掛失會把使用者自己鎖在門外。合約端另有白名單，
///     這條路碰不到任何會動錢的函式。
///
/// 授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；
/// Phase 1 由 ERC-4337 bundler + paymaster 取代。
export async function POST(req: Request) {
  const { account, calls, keyId, signature, mode } = (await req.json()) as
    { account?: string; calls?: Call[]; keyId?: string; signature?: string; mode?: string };
  if (!isAddress(account) || !Array.isArray(calls) || !isHex(signature) || !isHex(keyId) || keyId.length !== 66) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const fn = mode === "self" ? "executeSelf" : "execute";
  const typed = calls.map((c) => {
    if (!isAddress(c.target) || !isHex(c.data)) throw new Error("bad call");
    return { target: c.target, value: BigInt(c.value ?? "0"), data: c.data as Hex };
  });
  try {
    const { request } = await publicClient.simulateContract({
      address: account, abi: passkeyAccountAbi, functionName: fn, args: [typed, keyId, signature], account: relayerClient.account,
    });
    const hash = await relayerClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return Response.json({ txHash: hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
  } catch (e) {
    // 環境問題（節點連不上、部署檔對不上）先分流，不要被當成合約 revert
    if (isChainUnreachable(e) || isDeploymentMismatch(e)) return handle(e);
    let reason = e instanceof Error ? e.message : String(e);
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
      reason = r?.data ? unwrap(r.data.errorName, r.data.args ?? []) : e.shortMessage;
    }
    return Response.json({ error: reason }, { status: 400 });
  }
}
