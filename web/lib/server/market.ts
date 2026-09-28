import "server-only";
import type { Address } from "viem";
import type { ParticipantTag } from "./mm";
import { ledgerBids, ledgerHoldings, ledgerOrders } from "./ledger/read";

/// 市場的讀取面。設計 v4：掛單簿與持有都在鏈下帳本，這裡只是型別與入口。

export type Order = {
  orderId: number; seller: Address; batchId: number; remainingKg: number; pricePerTonne: string; minFillKg: number;
  project: { name: string; methodology: string; location: string }; vintageYear: number;
  /// 核發國（ISO 3166-1 alpha-2）與機制名稱。決定買到之後能拿來做什麼。
  country: string; scheme: string; domestic: boolean;
  /// 平台做市（mm）或模擬人物（sim）的掛單。一般使用者為 null。
  tag: ParticipantTag | null;
};

export type Bid = {
  bidId: number;
  buyer: Address;
  /// 想買哪一國核發的；空字串＝不限
  country: string;
  remainingKg: number;
  pricePerTonne: string;
  minFillKg: number;
  tag: ParticipantTag | null;
};

/// 賣單由低價往高價排（最佳賣價在前）。
export async function listOrders(limit = 60): Promise<Order[]> {
  return ledgerOrders(limit);
}

/// 買單由高價往低價排（最佳買價在前）。
export async function listBids(limit = 60): Promise<Bid[]> {
  return ledgerBids(limit);
}

export async function holdings(account: Address) {
  return ledgerHoldings(account);
}
