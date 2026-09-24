import "server-only";
import { type Address } from "viem";
import { deriveLedger, type Ledger } from "@/lib/bank/ledger-core";
import { deployment, publicClient } from "../chain";
import { ApiError } from "../api";

/// 站上這一側的薄包裝：把應用程式的 client 與部署檔接到 `lib/bank/ledger-core.ts`。
/// 推導邏輯本身刻意放在那邊——排程與稽核方都要跑得動它，不能綁在 Next 裡。

export type { Ledger };

export function bankAddress(): Address {
  const a = deployment().bank;
  if (!a) {
    throw new ApiError(
      "DEPLOYMENT_MISMATCH",
      "這條鏈的部署檔裡沒有 bank 位址——資產池是後來才加的，請重新部署後再試",
    );
  }
  return a;
}

/// @param upTo 只讀到這個區塊為止。重建**某一期已經上鏈的樹**時一定要帶——
///        那棵樹是算到 `commitments(epoch).upToBlock` 為止的，多讀一個區塊就對不上 root。
export async function readLedger(upTo?: bigint): Promise<Ledger> {
  const d = deployment();
  return deriveLedger({
    client: publicClient,
    bank: bankAddress(),
    fromBlock: BigInt(d.deployedAtBlock ?? 0),
    toBlock: upTo ?? (await publicClient.getBlockNumber()),
  });
}
