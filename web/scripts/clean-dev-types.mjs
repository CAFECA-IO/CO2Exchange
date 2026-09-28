// `next build` 之前清掉 `next dev` 留下的路由型別（.next/dev/types）。
//
// Next 16 把 dev 的型別產物放在 .next/dev/types，並自動把它加進 tsconfig 的 include。
// 那份 validator.ts 會對「當時存在的每一條路由」寫一行 import。之後刪掉一條路由
// （例如 CAFECA 改版拿掉的 app/api/relay），只要沒有重跑 dev，舊檔就一直留著，
// 而 build 的型別檢查會把它一起檢查——結果是
//   .next/dev/types/validator.ts: Cannot find module '../../../app/api/relay/route.js'
// 一個跟現在的程式碼完全無關的錯誤。這份產物 dev 下次啟動會自己重建，刪掉不會少任何東西。
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.cwd(), ".next", "dev", "types");
if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("已清除 .next/dev/types（next dev 留下的舊路由型別，下次 dev 會重建）");
}
