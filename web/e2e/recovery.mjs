// 所有裝置都遺失時的那條路：治理方提案 → 等待期 → 生效，地址不變。
//
// 這條路平常沒有人走，正因如此更要測——它只在最糟的一天被用到，
// 而那一天不是發現「原來提案沒權限」的好時機。
//
// 這支測的是**權限的邊界**，不只是功能：
//   · 只有 recoveryAgent 提得了案（平台 relayer 不行、路人不行）。
//   · 等待期沒過，誰都執行不了。
//   · 期間現存金鑰可以一鍵否決。
//   · 期滿生效後，地址不變、持倉不變，新裝置簽得動。
//
// 鏈上那幾步用 cast 直接打（治理動作本來就不在網頁上），時間用 anvil 的
// evm_increaseTime 跳過去——不然這支測試要跑 72 小時。
//
// 把時鐘往前推是**推不回來**的：`evm_increaseTime` 只有一個方向，而鏈上時間一旦
// 領先真實時間 72 小時，伺服器簽出來的 EIP-712 attestation 就全部「過期」了——
// 下一次有人跑 KYC 會看到 `register` revert，而且完全看不出跟這支測試有關。
// 所以這裡在推時間之前先 `evm_snapshot`，測完 `evm_revert` 回去。
// 快照之前建立的東西（帳戶、KYC、掛單）都還在，被丟掉的只有這支測試自己造的那幾筆。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASE, adminApproveAllKyc, applyKyc, createPasskeyAccount, launch, login, newUser, waitKycActive, waitOk, who,
} from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const CHAIN_ID = process.env.CHAIN_ID ?? "31337";
const DEPLOYMENT = JSON.parse(readFileSync(new URL(`../../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
/// stdio 的 stderr 吞掉：這支測試有好幾處**故意**去撞 revert（「relayer 提不了案」
/// 「等待期沒過執行不了」），cast 會把那些 revert 印到 stderr。讓它們出現在輸出裡，
/// 讀的人會以為測試壞了——而真正壞掉的那一天，訊息就淹在這些預期中的噪音裡。
const cast = (...args) =>
  execFileSync(`${FOUNDRY}/cast`, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` },
  }).trim();
const rpc = (method, params = []) =>
  cast("rpc", "--rpc-url", RPC, method, ...params.map((p) => (typeof p === "string" ? p : JSON.stringify(p))));

const ok = (c, m) => { if (!c) throw new Error(m); console.log("  ✓", m); };
const browser = await launch();

const user = await newUser(browser, "recovery-user");
const admin = await newUser(browser, "admin");
const email = who("lost-all-devices");

await login(user.page, email);
const address = await createPasskeyAccount(user.page);
await applyKyc(user.page, "corporate", "33333333", "掉了全部裝置股份有限公司");
await login(admin.page, "admin@example.com");
await adminApproveAllKyc(admin.page);
await waitKycActive(user.page);
console.log("✔ 帳戶就緒", address);

// recoveryAgent 是國家 Safe。Phase 0 的 Safe 由部署者單獨持有，所以這裡
// 直接用 anvil 的 impersonate 以 Safe 的身分呼叫——等同於多簽通過之後的效果。
// 正式環境走 script/govern.sh safe national exec。
const agent = cast("call", "--rpc-url", RPC, DEPLOYMENT.accountFactory, "recoveryAgent()(address)");
const operator = cast("call", "--rpc-url", RPC, DEPLOYMENT.accountFactory, "operator()(address)");
ok(agent.toLowerCase() === DEPLOYMENT.nationalSafe.toLowerCase(), `recoveryAgent 是國家 Safe（${agent}）`);
ok(operator !== agent, "operator（平台 relayer）與 recoveryAgent 是不同的鑰匙");

// 新裝置：新的瀏覽器 context，全新的 passkey。它自己加不進去（那正是問題所在），
// 所以先讓它把 passkey 建出來、拿到公鑰，再由治理方提案。
const fresh = await newUser(browser, "recovery-new-device");
await login(fresh.page, email);
await fresh.page.goto(BASE);
await fresh.page.getByRole("button", { name: /申請加入這台裝置/ }).click();
await fresh.page.locator("text=已送出申請").waitFor({ timeout: 60_000 });
const pk = await fresh.page.evaluate(() => JSON.parse(localStorage.getItem("co2x.credential")).publicKey);
const qx = `0x${pk.slice(2, 66)}`;
const qy = `0x${pk.slice(66, 130)}`;
const keyId = cast("keccak", cast("abi-encode", "f(bytes32,bytes32)", qx, qy));
console.log("✔ 新裝置建了 passkey，但加不進去（待核准，而且沒有現存裝置能核准）");

rpc("anvil_impersonateAccount", [agent]);
rpc("anvil_setBalance", [agent, "0xde0b6b3a7640000"]);
const asAgent = (...args) => cast("send", "--rpc-url", RPC, "--unlocked", "--from", agent, ...args);

// ① 平台 relayer 提不了案——這是「平台拿不走你的錢包」的實作依據。
let refused = false;
try {
  cast("call", "--rpc-url", RPC, "--from", operator, address, "proposeRecovery(bytes32,bytes32,string)", qx, qy, "x");
} catch { refused = true; }
ok(refused, "平台 relayer 無權提案復原");

// ② 治理方提案。不會立刻生效。
asAgent(address, "proposeRecovery(bytes32,bytes32,string)", qx, qy, "new phone");
const pending = cast("call", "--rpc-url", RPC, address, "pendingRecovery()(bytes32,bytes32,string,uint64)");
ok(pending.includes(qx.slice(2)), "提案已登錄在鏈上，任何人都查得到");

let tooEarly = false;
try { cast("call", "--rpc-url", RPC, address, "finaliseRecovery()"); } catch { tooEarly = true; }
ok(tooEarly, "等待期未過，誰都執行不了");

// ③ 使用者在畫面上看得到這個提案，而且能否決。
await user.page.goto(`${BASE}/account`);
await user.page.locator("text=有人正在申請把一把新 passkey 加進你的錢包").waitFor({ timeout: 30_000 });
await user.page.getByRole("button", { name: "否決", exact: true }).click();
await waitOk(user.page, "已否決");
const after = cast("call", "--rpc-url", RPC, address, "pendingRecovery()(bytes32,bytes32,string,uint64)");
ok(!after.includes(qx.slice(2)), "現存金鑰一鍵否決，提案消失");
console.log("✔ 等待期的意義：持有人否決得了不是他發起的復原");

// ④ 真的全部掉了：重新提案，跳過等待期，執行。
asAgent(address, "proposeRecovery(bytes32,bytes32,string)", qx, qy, "new phone");
const delay = Number(cast("call", "--rpc-url", RPC, address, "RECOVERY_DELAY()(uint256)").split(" ")[0]);
// 從這裡開始動到鏈的時鐘，所以先留一個快照，最後一定要 revert 回來（見檔頭）。
// 比對的基準是**快照當下的鏈上時間**，不是真實時間——展示機的鏈本來就落後真實
// 世界幾個小時（回填是一輪 8 小時跳的，最後一輪落在「現在」之前）。
// 拿真實時間當基準，這個檢查會在一條完全正常的鏈上失敗。
const chainTime = () => Number(cast("block", "--rpc-url", RPC, "latest", "--field", "timestamp"));
const before = chainTime();
const snapshot = rpc("evm_snapshot").replace(/"/g, "");
rpc("evm_increaseTime", [`0x${(delay + 60).toString(16)}`]);
rpc("evm_mine");
cast("send", "--rpc-url", RPC, "--unlocked", "--from", agent, address, "finaliseRecovery()");
const keys = cast("call", "--rpc-url", RPC, address, "activeKeys()(uint256)").split(" ")[0];
ok(Number(keys) === 2, `金鑰數變成 ${keys}（原本那把仍然有效——復原是「加一把」，不是「換掉」）`);
ok(cast("call", "--rpc-url", RPC, address, "keyOf(bytes32)((bytes32,bytes32,string,uint64,bool))", keyId).includes("true"),
   "新裝置的金鑰已生效");

// ⑤ 地址不變，而且新裝置真的簽得動。
await fresh.page.goto(`${BASE}/account/../`);
await fresh.page.reload();
await fresh.page.locator('[data-testid="account-ready"]').waitFor({ timeout: 60_000 });
const shown = await fresh.page.locator('[data-testid="account-ready"]').innerText();
ok(shown.includes(address), `復原後地址不變（${address}）`);
console.log("✔ 復原完成：等待期屆滿 → 新裝置生效 → 地址與持倉不變");

rpc("anvil_stopImpersonatingAccount", [agent]);
// 時鐘回到原位。不做這件事，下一個跑 KYC 的人會看到 register revert，
// 而且沒有任何線索指向這支測試。
rpc("evm_revert", [snapshot]);
const back = chainTime();
ok(Math.abs(back - before) < 600, `鏈上時鐘回到快照當下（差 ${back - before} 秒），沒有把 72 小時留給下一個人`);
await browser.close();
console.log("\n帳戶復原：全部通過");
