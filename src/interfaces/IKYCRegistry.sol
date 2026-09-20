// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IKYCRegistry
/// @notice 身分層對外介面。登錄層（不可升級）只依賴這個介面與 proxy 地址，
///         身分政策的任何變動都在 proxy 後面完成，額度歷史不受影響。
interface IKYCRegistry {
    /// @dev None = 未驗證；Individual = 自然人（預設買 + 註銷，不可轉售）；
    ///      Corporate = 法人（工商憑證）；SystemContract = 平台合約（Listing、Pool、PoolManager…）
    enum Tier {
        None,
        Individual,
        Corporate,
        SystemContract
    }

    struct Identity {
        Tier tier;
        uint64 expiry; // 0 = 不過期（僅 SystemContract）
        bool frozen;
        bytes2 jurisdiction; // ISO 3166-1 alpha-2，例如 "TW"
        bytes32 identityHash; // hash(統編 或 身分證字號 + salt)，鏈上不存明文
    }

    error NotActive(address account);
    error Frozen(address account);
    error IndividualTransferDisabled(address account);
    error IndividualRetireDisabled(address account);

    function identityOf(address account) external view returns (Identity memory);
    function tierOf(address account) external view returns (Tier);
    function isActive(address account) external view returns (bool);
    function isSystemContract(address account) external view returns (bool);

    /// @notice 代幣層在 _update 呼叫。持有與註銷不經過這裡；只有轉帳會。
    ///         規則：雙方皆須有效且未凍結；Individual 轉出需政策開啟。
    function checkTransfer(address from, address to) external view;

    /// @notice 註銷前檢查：帳戶須為已知身分（憑證需對應法律實體）且未凍結；到期不擋。
    function checkRetire(address account) external view;
}
