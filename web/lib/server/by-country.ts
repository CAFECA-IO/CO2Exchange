/// 各轄區的市場數據，全部由帳本事件推導。
///
/// 首頁的地球畫的就是這份資料。地球負責「在哪裡、大概多少」，
/// 旁邊的清單負責「精確是多少」——球面上的柱子會因為透視與球面曲率而失真，
/// 靠近邊緣的那一根看起來一定比正對鏡頭的那一根短。
/// 所以量的比較放在清單的水平長條上，地球不負責讓人讀出數字。

import { ledgerByCountry } from "./ledger/read";

/// 地球上放柱子的位置。取各國陸地的視覺重心，不是幾何形心——
/// 印尼的幾何形心會落在海上，澳洲的會落在無人的內陸，兩者都指不到人看得懂的地方。
export const ANCHOR: Record<string, [number, number]> = {
  TW: [23.8, 121.0], JP: [36.2, 138.3], KR: [36.5, 127.8], TH: [15.2, 100.9],
  ID: [-2.5, 117.5], AU: [-25.0, 133.5], CN: [35.0, 104.0], IN: [22.5, 79.0],
  SG: [1.35, 103.82],
};

export type CountryStat = {
  country: string;
  name: string;
  scheme: string;
  registryName: string;
  enabled: boolean;
  lat: number;
  lon: number;
  /// 累計核發量（公斤）
  issuedKg: number;
  /// 目前鏈上流通量＝核發 − 註銷
  circulatingKg: number;
  /// 累計註銷量
  retiredKg: number;
  /// 區間內成交量與成交筆數
  tradedKg: number;
  trades: number;
  /// 區間內的成交均價（mTWD / 噸，以成交量加權）。沒有成交就是 0。
  ///
  /// 為什麼是加權平均而不是最後一筆：最後一筆可能是某個人買 0.1 噸留下的，
  /// 拿它代表一個轄區的價格，會被一筆小單帶著跑。
  avgPricePerTonne: number;
  /// 區間內的價格走勢：等寬時間桶，每一桶是該桶的成交量加權均價。
  /// 沒有成交的桶**不出現**——補一個假的點會讓走勢圖上長出一段沒發生過的行情。
  priceSeries: { t: number; price: number }[];
  /// 目前掛單簿上的數量與筆數
  listedKg: number;
  orders: number;
};

export async function byCountry(rangeHours = 24 * 365): Promise<{
  rangeHours: number;
  asOf: number;
  countries: CountryStat[];
}> {
  return ledgerByCountry(rangeHours);
}
