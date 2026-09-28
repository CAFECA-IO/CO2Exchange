import "server-only";
import type { Address } from "viem";
import { ledgerBulletin } from "./ledger/read";
import { memoView } from "./ledger/view";

/// 公告欄。
///
/// 環境部「溫室氣體減量額度管理系統」（TCER Registry）的公開資訊分五塊：
/// 額度總覽、核發資訊、使用及註銷、移轉紀錄、參與事業。本站照同一個分法，
/// 差別在於資料不是人工上傳，而是**直接從帳本事件推導**——公告與事實同一份紀錄，
/// 沒有「公告漏貼」或「公告與帳本不符」的可能。
///
/// 依交易拍賣及移轉管理辦法第 27 條，主管機關於註銷次日起五個工作日內公開，
/// 公開後事業始得對外做環境聲明。所以註銷公告會算出「可對外宣告日」。

export type AnnouncementKind = "issue" | "list" | "transfer" | "retire";

export type Announcement = {
  no: string; // 公告編號
  kind: AnnouncementKind;
  ts: number; // 公告時間（= 帳本收單時間）
  batchId?: number;
  projectId?: number;
  orderId?: number;
  certId?: number;
  amountKg: number;
  /// 移轉類：買賣雙方；核發類：受配者；註銷類：註銷人與受益人帳戶
  from?: Address;
  to?: Address;
  costTwd?: number; // 最小單位
  pricePerTonne?: number;
  serial?: string; // TCER 格式額度編碼
  txHash: string;
  blockNumber: number;
  /// 核發國（ISO 3166-1 alpha-2）。公告不標國別，讀者就分不出這筆額度在臺灣能不能用。
  country?: string;
  /// 註銷專用：公開日 + 5 個工作日，之後才可以對外宣告（第 27 條）
  claimableFrom?: number;
};

export type BulletinSummary = {
  issuedKg: number;
  retiredKg: number;
  transferredKg: number;
  circulatingKg: number;
  projects: number;
  participants: number;
  lastAnnouncedAt: number | null;
};

export type Bulletin = {
  summary: BulletinSummary;
  announcements: Announcement[];
  participants: { address: Address; issued: number; bought: number; sold: number; retired: number }[];
};

/// API 回給畫面的公告欄：每一類只帶最新的 `limit` 筆（帳本越大，全量回傳越不可行），
/// 另給每一類的總數與「累計成交量」的日線（首頁的市場概況用，不必為了畫一條線把全部移轉公告搬過去）。
export type BulletinPage = Bulletin & {
  counts: Record<AnnouncementKind, number>;
  limit: number;
  cumulativeTransfers: { t: number; kg: number }[];
};

/// 五個工作日：只跳過週六日。國定假日需接行政院行事曆，Phase 0 不做，
/// 所以這個日期是「不早於」的下限，介面要照這樣講。
export function addWorkingDays(from: number, days: number): number {
  const d = new Date(from * 1000);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return Math.floor(d.getTime() / 1000);
}

export async function bulletin(limit = 200): Promise<BulletinPage> {
  const full = ledgerBulletin();
  return memoView(`bulletinPage:${limit}`, () => {
    const counts: Record<AnnouncementKind, number> = { issue: 0, list: 0, transfer: 0, retire: 0 };
    const kept: Announcement[] = [];
    // announcements 已經依時間由新到舊排好
    for (const a of full.announcements) { counts[a.kind] += 1; if (counts[a.kind] <= limit) kept.push(a); }
    const day = 86_400;
    const byDay = new Map<number, number>();
    for (const a of full.announcements) if (a.kind === "transfer") { const d = Math.floor(a.ts / day) * day; byDay.set(d, (byDay.get(d) ?? 0) + a.amountKg); }
    let run = 0;
    const cumulativeTransfers = [...byDay.keys()].sort((x, y) => x - y).map((t) => ({ t, kg: (run += byDay.get(t)!) }));
    return { ...full, announcements: kept, counts, limit, cumulativeTransfers };
  });
}
