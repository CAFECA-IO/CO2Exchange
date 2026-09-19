#!/usr/bin/env node
// 把 web/data/ 整個搬到 data.bak-<時間戳> 再重來。
// 「搬」不是「刪」：KYC 申請裡有身分證影本、憑證紀錄有序號，哪一天要查是查得到的。
// 真的確定不要了，自己刪那個備份資料夾。
import fs from "node:fs";
import path from "node:path";

const dir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
if (!fs.existsSync(dir)) {
  console.log(`${dir} 不存在，不用清。`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bak = `${dir}.bak-${stamp}`;
fs.renameSync(dir, bak);
fs.mkdirSync(dir, { recursive: true });
console.log(`舊資料已搬到 ${bak}`);
console.log(`${dir} 已清空；下一次讀寫會自動壓上目前部署的指紋。`);
console.log(`備份裡有上傳的身分文件，確認不需要再自行刪除。`);
