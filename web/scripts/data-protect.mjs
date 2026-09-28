#!/usr/bin/env node
// 把 web/data 與所有 data.bak-* 備份裡的明文個人資料改成密文（或刪掉）。
//
//   npm run data:protect -- --dry-run     # 只數：每個資料夾有幾筆明文、會怎麼處理
//   npm run data:protect                  # 就地改寫（每個檔案先寫暫存檔再改名，不會寫到一半）
//   npm run data:protect -- --rekey       # 換過 DATA_KEY 之後：把用舊金鑰加密的欄位改用新金鑰
//   npm run data:protect -- --only-current  # 只處理 web/data，不碰備份
//
// 處理規則（和網站寫入時相同，見 lib/server/kyc.ts、lib/server/ledger/fiat.ts）：
//   · 身分驗證申請：還在審核中的，證號加密；已經審核完的，證號直接刪掉（只留遮罩，帳本裡有 identityHash）。
//     姓名一律加密。
//   · 收款帳戶：帳號與戶名加密，另存帳號末四碼。銀行代碼與 payoutRef 不動。
//
// 金鑰：DATA_KEY（shell 或 web/.env.local）；舊金鑰放 DATA_KEY_PREVIOUS。本機鏈（CHAIN_ID 31337／1337）
// 沒設的話用公開的展示金鑰，和網站相同。**只印數量，不印任何欄位的值。**
import fs from "node:fs";
import path from "node:path";
import { setting } from "./lib/keys.mjs";

const S = await import("../lib/crypto/sealed.ts");

const DRY = process.argv.includes("--dry-run");
const REKEY = process.argv.includes("--rekey");
const ONLY = process.argv.includes("--only-current");

const chainId = Number(setting("CHAIN_ID") ?? 31337);
const local = chainId === 31337 || chainId === 1337;
const keyText = setting("DATA_KEY");
if (!keyText && !local) {
  console.error(`chainId ${chainId} 不是本機鏈，但沒有設定 DATA_KEY。先執行 bash script/bootstrap.sh keys（會產生並寫進 web/.env.local）。`);
  process.exit(1);
}
let current, all;
try {
  current = S.parseDataKey(keyText || S.DEV_DATA_KEY_TEXT);
  const prev = (setting("DATA_KEY_PREVIOUS") ?? "").split(",").map((x) => x.trim()).filter(Boolean).map(S.parseDataKey);
  all = [current, ...prev, ...(local && keyText ? [S.parseDataKey(S.DEV_DATA_KEY_TEXT)] : [])];
} catch (e) { console.error(`!! ${e.message}`); process.exit(1); }
console.log(`金鑰 ${current.kid}${keyText ? "" : "（本機展示金鑰）"}${all.length > 1 ? `；另認得 ${all.slice(1).map((k) => k.kid).join("、")}` : ""}${DRY ? "；只數不改" : ""}`);

const DATA = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const parent = path.dirname(DATA);
const dirs = [DATA, ...(ONLY ? [] : fs.readdirSync(parent).filter((f) => f.startsWith(`${path.basename(DATA)}.bak-`)).sort().map((f) => path.join(parent, f)))]
  .filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());

const seal = (c, f, account, v) => S.seal(v, current, S.aadOf(c, f, account));
const reseal = (c, f, account, v) => (v.startsWith(`${S.SEALED_PREFIX}${current.kid}:`) ? v : seal(c, f, account, S.open(v, all, S.aadOf(c, f, account))));

function rewrite(file, fn) {
  if (!fs.existsSync(file)) return null;
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const n = { rows: rows.length, changed: 0 };
  const out = rows.map((r) => { const x = fn(r, n); if (x !== r) n.changed += 1; return x; });
  if (!DRY && n.changed) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return n;
}

const total = { sealed: 0, purged: 0, rekeyed: 0, files: 0 };
let failed = 0;
for (const dir of dirs) {
  const c = { sealed: 0, purged: 0, rekeyed: 0 };
  try {
    const kyc = rewrite(path.join(dir, "kyc-requests.json"), (r) => {
      const x = { ...r };
      const decided = r.status && r.status !== "pending";
      if (typeof r.idNumber === "string" && r.idNumber) {
        x.idNumberMasked = r.idNumberMasked ?? S.maskIdNumber(r.idNumber);
        if (decided) c.purged += 1; else { x.idNumberSealed = seal("kyc-requests", "idNumber", r.account, r.idNumber); c.sealed += 1; }
        delete x.idNumber;
      }
      if (decided && x.idNumberSealed) { delete x.idNumberSealed; c.purged += 1; }
      if (typeof r.name === "string") {
        if (r.name) { x.nameSealed = seal("kyc-requests", "name", r.account, r.name); c.sealed += 1; }
        delete x.name;
      }
      if (REKEY) for (const f of ["idNumberSealed", "nameSealed"]) {
        if (S.isSealed(x[f])) { const y = reseal("kyc-requests", f.replace("Sealed", ""), r.account, x[f]); if (y !== x[f]) { x[f] = y; c.rekeyed += 1; } }
      }
      return JSON.stringify(x) === JSON.stringify(r) ? r : x;
    });
    const pay = rewrite(path.join(dir, "payout-accounts.json"), (r) => {
      const x = { ...r };
      if (typeof r.accountNo === "string") {
        x.accountNoSealed = seal("payout-accounts", "accountNo", r.account, r.accountNo);
        x.accountNoMasked = S.maskTail(r.accountNo);
        delete x.accountNo; c.sealed += 1;
      }
      if (typeof r.holder === "string") {
        x.holderSealed = seal("payout-accounts", "holder", r.account, r.holder);
        delete x.holder; c.sealed += 1;
      }
      if (REKEY) for (const f of ["accountNoSealed", "holderSealed"]) {
        if (S.isSealed(x[f])) { const y = reseal("payout-accounts", f.replace("Sealed", ""), r.account, x[f]); if (y !== x[f]) { x[f] = y; c.rekeyed += 1; } }
      }
      return JSON.stringify(x) === JSON.stringify(r) ? r : x;
    });
    const touched = [kyc, pay].filter((n) => n && n.changed).length;
    total.files += touched;
    for (const k of ["sealed", "purged", "rekeyed"]) total[k] += c[k];
    if (kyc || pay) console.log(`  ${path.basename(dir)}：身分申請 ${kyc?.rows ?? 0} 筆、收款帳戶 ${pay?.rows ?? 0} 筆 → 加密 ${c.sealed}、刪除證號 ${c.purged}${REKEY ? `、換金鑰 ${c.rekeyed}` : ""}`);
  } catch (e) {
    failed += 1;
    // SealedError 的訊息只講金鑰編號與原因，不含資料
    console.error(`  ✗ ${path.basename(dir)}：${e.message}`);
  }
}
console.log(`\n${DRY ? "（只數）" : ""}${dirs.length} 個資料夾、${total.files} 個檔案${DRY ? "會" : ""}改寫：加密 ${total.sealed} 欄、刪除證號 ${total.purged} 筆${REKEY ? `、換金鑰 ${total.rekeyed} 欄` : ""}${failed ? `；${failed} 個資料夾失敗` : ""}`);
if (!DRY && total.files) console.log("DATA_KEY 要另外備份，不要和 web/data 的備份放在一起。");
process.exit(failed ? 1 : 0);
