#!/usr/bin/env node
// 把 web/data/ 整個搬到 data.bak-<時間戳> 再重來。
// 「搬」不是「刪」：身分申請、收款帳戶、憑證紀錄哪一天要查是查得到的。
// 身分證號、姓名、收款帳號在 store 裡是密文（lib/server/sealed.ts），備份也一樣——但要讀得回來就得留著 DATA_KEY。
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
console.log(`備份裡的個人資料是密文，要用同一把 DATA_KEY 才讀得回來；舊版留下的明文用 npm run data:protect 處理。`);

// 每 rebuild 一次就多一份備份。展示機如果排程每天重建，一個月後磁碟上就躺著三十份。
// 不自動刪（那違背「搬不是刪」的用意），但要出聲。
const baks = fs.readdirSync(path.dirname(dir))
  .filter((f) => f.startsWith(`${path.basename(dir)}.bak-`));
if (baks.length >= 5) {
  console.log("");
  console.log(`⚠ 這個資料夾已經有 ${baks.length} 份備份（${path.dirname(dir)}/${path.basename(dir)}.bak-*）。`);
  console.log(`  個人資料雖然是密文，備份越多、金鑰外洩時的影響越大。確認不需要的請自行刪除，不要讓它們無限累積。`);
  console.log(`  舊版（加密之前）的備份可能還有明文：npm run data:protect -- --dry-run 看有幾筆。`);
}
