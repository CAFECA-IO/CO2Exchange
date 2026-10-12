/// 國家代碼 → 中文國名。畫面上一律顯示國名，不顯示代碼（「中國」，不是「CN」）。
///
/// 來源是 Intl.DisplayNames（zh-Hant-TW），再套本站用語。地球點陣的國家表
/// （scripts/gen-globe-dots.py 的 NAME_OVERRIDE）用的是同一套規則，兩邊改的時候要一起改。
///
/// 不依賴 Next；伺服器與前端都可以 import（這一份很小，不含地球點陣）。

/// 本站用語。Intl 的預設是「台灣」「南韓」「中國香港特別行政區」
export const NAME_OVERRIDE: Record<string, string> = {
  TW: "臺灣", KR: "韓國", KP: "北韓", HK: "香港", MO: "澳門", PS: "巴勒斯坦",
};

let display: Intl.DisplayNames | null | undefined;

/// 代碼不是兩個英文字母、或執行環境沒有這一國的名稱時，原樣回傳代碼——那是資料有問題，
/// 寧可看得出來，也不要編一個名字。
export function countryName(code: string): string {
  const c = code.trim().toUpperCase();
  if (NAME_OVERRIDE[c]) return NAME_OVERRIDE[c];
  if (!/^[A-Z]{2}$/.test(c)) return code;
  if (display === undefined) {
    try { display = new Intl.DisplayNames(["zh-Hant-TW"], { type: "region" }); } catch { display = null; }
  }
  const n = display?.of(c);
  return n && n !== c ? n : code;
}
