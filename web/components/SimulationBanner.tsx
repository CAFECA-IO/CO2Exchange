"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/client/fetchJson";

/// 測試鏈上開著模擬交易時，每一頁都要看得到。成交量、K 線、掛單簿都混著虛擬人物的交易，
/// 只在掛單簿上逐筆標示不夠——看首頁行情的人不會去逐筆看。
export function SimulationBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    fetchJson<{ simulation: { active: boolean; simulatedAccounts: number } }>("/api/market/makers")
      .then((d) => setOn(d.simulation.active || d.simulation.simulatedAccounts > 0))
      .catch(() => setOn(false));
  }, []);
  if (!on) return null;
  return (
    <div className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-center text-xs text-warn" data-testid="simulation-banner">
      測試環境：本市場的掛單與成交包含模擬帳戶，行情不代表真實市場。
      <Link href="/custody#market-making" className="ml-1 underline">說明</Link>
    </div>
  );
}
