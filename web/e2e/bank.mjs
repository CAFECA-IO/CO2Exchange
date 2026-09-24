// A 期：交易所資產池與餘額樹承諾。
//
// 這支測的是 A 期對外承諾的那一句話能不能兌現：
// **交易所說每個人有多少，任何人都能自己算一次對照。**
//
// 所以它不只呼叫 API，而是走完整條路：
//   ① 有人把碳權存進池子（鏈上一筆移轉，身分規則照常在 _update 把關）
//   ② 提交一期承諾（餘額樹 root + 總額 + 算到哪個區塊）
//   ③ 用獨立的驗證器從鏈上事件重算一次，對得上
//   ④ 揭露頁把「帳本說欠多少」與「池子裡有多少」並列顯示
//   ⑤ 提領關著，但證據拿得到、而且合約驗得過
//
// ⑤ 是「不提供提領但保留機制」真正的內容。提領的函式關著沒關係，
// 但如果使用者拿不到 Merkle 分支、或那份分支合約不認，那個機制在營運方
// 消失的那天就不存在——而那正是它唯一會被用到的時候。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BASE, launch } from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const CHAIN_ID = process.env.CHAIN_ID ?? "31337";
const D = JSON.parse(readFileSync(new URL(`../../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const PK0 = process.env.RELAYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };
const cast = (...args) =>
  execFileSync(`${FOUNDRY}/cast`, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
  }).trim();
const npmRun = (...args) =>
  execFileSync("npm", ["run", "--silent", ...args], {
    encoding: "utf8", cwd: process.cwd(),
    env: { ...process.env, COMMITTER_PK: PK0, RPC_URL: RPC },
  }).trim();

let failed = null;
const browser = await launch();

try {
  if (!D.bank) throw new Error("部署檔裡沒有 bank 位址——請重新部署");

  // ── ① 存入 ────────────────────────────────────────────────
  //
  // 找一個手上有貨的 demo 帳戶。DemoFlowV4 會發一些額度給 anvil 的前幾個帳戶，
  // 哪一個有貨會隨腳本改動，所以這裡用掃的而不是寫死——
  // 寫死的話，demo 腳本改一行，這支測試就會以一個看不出原因的方式壞掉。
  let holder = null;
  for (let i = 0; i < 4 && !holder; i++) {
    const pk = cast("wallet", "private-key", "--mnemonic",
      "test test test test test test test test test test test junk", "--mnemonic-index", String(i));
    const addr = cast("wallet", "address", "--private-key", pk);
    for (const batchId of [1, 2, 3, 4, 5]) {
      const bal = BigInt(cast("call", "--rpc-url", RPC, D.carbonCredit1155,
        "balanceOf(address,uint256)(uint256)", addr, String(batchId)).split(" ")[0]);
      if (bal >= 2000n) { holder = { pk, addr, batchId, bal }; break; }
    }
  }
  if (!holder) throw new Error("找不到手上有額度的 demo 帳戶");

  const before = BigInt(cast("call", "--rpc-url", RPC, D.bank, "totalHeldKg()(uint256)").split(" ")[0]);
  cast("send", "--rpc-url", RPC, "--private-key", holder.pk, D.carbonCredit1155,
       "setApprovalForAll(address,bool)", D.bank, "true");
  cast("send", "--rpc-url", RPC, "--private-key", holder.pk, D.bank,
       "deposit(uint256,uint256)", String(holder.batchId), "2000");
  const after = BigInt(cast("call", "--rpc-url", RPC, D.bank, "totalHeldKg()(uint256)").split(" ")[0]);
  ok(after === before + 2000n, `存入 2 噸進資產池（池子 ${before} → ${after} kg）`);

  // ── ② 提交一期 ────────────────────────────────────────────
  const epochBefore = BigInt(cast("call", "--rpc-url", RPC, D.bank, "epoch()(uint64)").split(" ")[0]);
  const committerRole = cast("call", "--rpc-url", RPC, D.bank, "COMMITTER_ROLE()(bytes32)");
  const me = cast("wallet", "address", "--private-key", PK0);
  if (cast("call", "--rpc-url", RPC, D.bank, "hasRole(bytes32,address)(bool)", committerRole, me) !== "true") {
    cast("send", "--rpc-url", RPC, "--private-key", PK0, D.bank, "grantRole(bytes32,address)", committerRole, me);
  }
  const out = npmRun("bank:commit");
  const epochAfter = BigInt(cast("call", "--rpc-url", RPC, D.bank, "epoch()(uint64)").split(" ")[0]);
  ok(epochAfter === epochBefore + 1n, `提交第 ${epochAfter} 期（${out.split("\n").pop()}）`);

  // 承諾鏈要接得起來：head 不是零，而且每一期都會變。
  const head = cast("call", "--rpc-url", RPC, D.bank, "head()(bytes32)");
  ok(/^0x[0-9a-f]{64}$/.test(head) && !/^0x0+$/.test(head), `承諾鏈的 head 有值（${head.slice(0, 12)}…）`);

  // ── ③ 獨立驗證 ────────────────────────────────────────────
  //
  // 這一條是 A 期的重點。驗證器不經過交易所的任何 API，只用 RPC 與部署檔，
  // 從鏈上事件重算一次所有人的餘額、重建同一棵樹。對不上就 exit 1。
  const verify = npmRun("bank:verify");
  ok(/全部對得上/.test(verify), "獨立驗證器從鏈上事件重算，root、總額、逐批次全部對得上");
  ok(!/✗/.test(verify), "驗證報告裡沒有任何一項不符");

  // ── ④ 揭露頁 ──────────────────────────────────────────────
  const page = await browser.newPage();
  await page.goto(`${BASE}/custody`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.getByText("平台資產池").first().waitFor({ timeout: 30_000 });
  const panel = await page.locator("main").innerText();
  ok(/帳本宣稱欠/.test(panel) && /池子裡實際有/.test(panel),
     "揭露頁把「帳本說欠多少」與「池子裡有多少」並列，沒有合併成一個數字");
  ok(/尚未開放（機制已在鏈上）/.test(panel), "而且誠實標示提領尚未開放");

  // ── ⑤ 提領關著，但證據拿得到而且合約認 ──────────────────
  ok(cast("call", "--rpc-url", RPC, D.bank, "withdrawalsEnabled()(bool)") === "false",
     "提領預設關閉（Phase 0 不提供提領）");

  const check = execFileSync("node",
    ["--experimental-strip-types", "--no-warnings", "scripts/check-proof-onchain.mjs",
     "--account", holder.addr, "--batch", String(holder.batchId), "--amount", "1"],
    { encoding: "utf8", env: { ...process.env, RPC_URL: RPC } });
  ok(/證據結構走到了提領開關那一步/.test(check),
     "使用者拿得到自己的 Merkle 分支，而且合約收得下（只被開關擋住）");

  // 打開來驗到底，再關回去。**這一段才是真的證明提領路徑能用**——
  // 一個沒被跑過的提領路徑等於沒有提領路徑。
  cast("send", "--rpc-url", RPC, "--private-key", PK0, D.bank, "setWithdrawalsEnabled(bool)", "true");
  try {
    const full = execFileSync("node",
      ["--experimental-strip-types", "--no-warnings", "scripts/check-proof-onchain.mjs",
       "--account", holder.addr, "--batch", String(holder.batchId), "--amount", "1"],
      { encoding: "utf8", env: { ...process.env, RPC_URL: RPC } });
    ok(/合約接受這份證據/.test(full), "打開提領之後，同一份證據合約驗得過（模擬，沒有真的送出）");
  } finally {
    cast("send", "--rpc-url", RPC, "--private-key", PK0, D.bank, "setWithdrawalsEnabled(bool)", "false");
  }
  ok(cast("call", "--rpc-url", RPC, D.bank, "withdrawalsEnabled()(bool)") === "false", "測完關回去");

  console.log("\n資產池與餘額樹：全部通過");
} catch (e) {
  failed = e;
} finally {
  await browser.close();
}
if (failed) { console.error(failed); process.exit(1); }
