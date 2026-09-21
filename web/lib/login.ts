/// 「這個站台現在能不能登入」——三個地方要問同一個問題，答案只寫一份。
///
/// 會出現「一個登入方式都沒有」是因為登入供應商是用環境變數開的：
/// 沒設 AUTH_GOOGLE_ID / AUTH_APPLE_ID，而 production 又沒開 AUTH_DEV_LOGIN，
/// providers 就是空陣列。這不是錯誤狀態，是一種**設定**，但畫面必須說出來——
/// 不說的話，導覽列有「登入」、內頁叫人「回首頁登入」，回到首頁那裡什麼都沒有，
/// 按鈕看起來就是壞的。

/// config 還沒讀回來時回 false：寧可晚一點才出現「登入」，
/// 也不要先閃一下「沒有登入方式」再改口。
export function hasLogin(providers: readonly string[] | undefined): boolean {
  return (providers?.length ?? 0) > 0;
}

export const NO_LOGIN_TITLE = "目前沒有開放登入";

export const NO_LOGIN_BODY =
  "這個站台還沒有啟用任何登入方式，所以現在無法建立帳戶或交易。" +
  "市場現況、各轄區的核發與交易量、託管揭露與契約條文都不需要登入，可以直接瀏覽。";
