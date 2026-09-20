// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IJurisdictions
/// @notice 轄區（國別）政策的唯讀介面。由 CarbonRegistry 實作，CarbonCredit1155 與市場合約據以判斷。
///
/// 為什麼額度要帶國別：額度能拿來做什麼，是由**核發它的那個國家的法律**決定的，
/// 不是由交易所決定的。臺灣的《氣候變遷因應法》第 27 條把國外減量額度限縮到
/// 「扣除碳費排放量」與「抵銷超額量」兩種用途，並要求先經中央主管機關認可；
/// 《碳費收費辦法》第 10 條再把扣除上限壓到收費排放量的 5%，且高碳洩漏風險事業不得使用。
/// 《溫室氣體減量額度交易、拍賣及移轉管理辦法》第 4 條則明定該辦法「僅適用於國內減量額度」。
/// 一顆不帶國別的額度，等於把這些差異丟給使用者自己記——記錯的代價是一張不能申報的憑證。
interface IJurisdictions {
    struct Jurisdiction {
        /// @dev 本站是否開放此轄區的額度上架交易
        bool enabled;
        /// @dev 是否為國內（臺灣）額度。國內／國外在法規上是兩套規則，不是程度差異。
        bool domestic;
        /// @dev 允許的註銷用途 bitmask：1 << uint8(RetirementCertificate.Purpose)
        uint8 purposeMask;
        /// @dev 中文國名或轄區名，例如 "日本"
        string name;
        /// @dev 減量機制名稱，例如 "J-Credit"
        string scheme;
        /// @dev 官方登錄簿名稱，例如 "J-クレジット登録簿"
        string registryName;
        /// @dev 給使用者看的一句話：這個轄區的額度在臺灣能做什麼、有什麼限制、為什麼不能交易。
        ///      寫在鏈上是因為這句話會出現在憑證與公告上，不該是前端可以隨手改的文案。
        string note;
    }

    function jurisdictionOf(bytes2 country) external view returns (Jurisdiction memory);

    function jurisdictionOfProject(uint256 projectId)
        external
        view
        returns (bytes2 country, Jurisdiction memory jurisdiction);

    /// @notice 用途與轄區不相容時 revert。
    function checkRetirePurpose(uint256 projectId, uint8 purpose) external view;

    /// @notice 此轄區的額度目前可否上架交易；不可時 revert。
    function checkTradable(uint256 projectId) external view;
}
