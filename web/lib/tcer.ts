/// 減量額度編碼（TCER 格式）。
///
/// 依環境部「溫室氣體減量額度編碼作業要點」，一組額度編碼由五段組成：
///   1. 國別        英文二碼，我國為 TW
///   2. 專案流水號  英文一碼 + 數字五碼（A 先期專案 / B 抵換專案 / C 自願減量專案 / Z 其他）
///   3. 專案類型    A 減少或避免排放（非林業）/ R 移除（林業）/ N 無區分
///   4. 監測期間    DDMMYYYY 八碼
///   5. 額度流水號  頭碼與末碼各九碼，代表這批額度的起訖序號
///
/// 鏈上的批次與這個編碼是一對一的：批次 = 一次核發 = 一段連續序號。
/// 本站自行組出同格式的編碼，日後與官方登錄系統對帳時，兩邊講的是同一種語言。
/// 注意：這是**本站格式相容的編碼**，不是環境部核發的正式編碼；正式編碼於
/// 官方核發後回填，介面上兩者要分開顯示，不可混為一談。

export type TcerInput = {
  projectId: number;
  batchId: number;
  /// 監測期間結束日（unix 秒）。官方格式取一個日期，本站取監測期末。
  monitoringEnd: number;
  amountKg: number;
  /// 專案類型：林業 / 移除類為 "R"，其餘 "A"
  removal?: boolean;
  /// 額度起始序號（預設由批次推導，示範用）
  startSerial?: number;
};

const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).padStart(w, "0");

export function tcerSerial(i: TcerInput): string {
  const d = new Date(i.monitoringEnd * 1000);
  const dd = pad(d.getUTCDate(), 2);
  const mm = pad(d.getUTCMonth() + 1, 2);
  const yyyy = pad(d.getUTCFullYear(), 4);
  // 一單位 = 一公噸。額度流水號以公噸計，不足一公噸不編號。
  const tonnes = Math.max(1, Math.floor(i.amountKg / 1000));
  const start = i.startSerial ?? 1;
  return [
    "TW",
    `C${pad(i.projectId, 5)}`, // C = 自願減量專案
    i.removal ? "R" : "A",
    `${dd}${mm}${yyyy}`,
    `${pad(start, 9)}-${pad(start + tonnes - 1, 9)}`,
  ].join("-");
}

/// 給介面用的短版（保留可辨識度，不佔滿一行）
export function tcerShort(serial: string): string {
  const parts = serial.split("-");
  if (parts.length < 5) return serial;
  return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}…`;
}
