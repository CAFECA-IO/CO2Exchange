"use client";
import { LedgerTrade } from "@/components/ledger/LedgerTrade";

/// 交易頁：簽委託單（EIP-712），不送鏈上交易。撮合是重播帳本的結果，見 components/ledger/LedgerTrade.tsx。
export default function TradePage() {
  return <LedgerTrade />;
}
