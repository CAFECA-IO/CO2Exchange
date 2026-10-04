# deployments/

部署腳本（`script/DeployLedger.s.sol`，經 `bash script/bootstrap.sh deploy` 或 `demo-box.sh`）把每條鏈的部署紀錄寫在這裡：
`deployments/<chainId>.json`（帳本、記帳 TWD、兩個 Safe、Timelock 的位址與部署區塊）。網站與所有 npm 工具都讀它
（或環境變數 `DEPLOYMENT_FILE` 指定的檔案）。

**這些檔案不進版本控制**（`.gitignore`）：同一條鏈在不同的測試環境各自部署，位址都不一樣，提交上去只會互相蓋掉。
每一台機器保留自己的；要搬到另一台機器（例如正式主機），直接複製檔案，或用 `DEPLOYMENT_FILE` 指過去。

這個資料夾本身要存在（部署腳本不會自己建資料夾），所以留著這份說明。
