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
// 鏈上那幾步用 cast 直接打（治理動作本來就不在網頁上）。
//
// ## 為什麼不再用 anvil 的 impersonate
//
// 以前這支測試用 `anvil_impersonateAccount` 假裝自己是國家 Safe，因為「Phase 0 的
// Safe 反正由部署者持有」。換到公開鏈之後那條路不存在——沒有任何鏈會讓你冒充一個地址。
//
// 改成走**真的多簽**：owners 各自簽 Safe 的 transaction hash，湊到門檻再 execTransaction。
// 這不只是為了能在公開鏈上跑，它本來就是比較好的測試：以前測的是「如果 Safe 說要，
// 帳戶會照做」，現在測的是「要讓 Safe 說要，得幾個人簽字」——而後者才是治理。
//
// ## 等待期怎麼過
//
// anvil 上跳過去（evm_increaseTime），跑完 evm_revert 回來——時鐘往前推是推不回來的，
// 而鏈上時間一旦領先真實時間 72 小時，伺服器簽出來的 EIP-712 attestation 就全部
// 「過期」了，下一個跑 KYC 的人會看到 register revert 且完全看不出跟這支測試有關。
//
// 公開鏈上跳不了，只能真的等。所以等待期是部署參數（見 PasskeyAccountFactory）：
// 公開測試鏈用幾分鐘，正式環境 72 小時。這支測試會讀鏈上的實際值再決定怎麼等，
// 太長就直接說清楚該怎麼重新部署，而不是讓人盯著一個永遠不會結束的測試。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  BASE, adminApproveAllKyc, applyKyc, createPasskeyAccount, launch, login, newUser, waitKycActive, waitOk, who,
} from "./lib.mjs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:28545";
const CHAIN_ID = process.env.CHAIN_ID ?? "31337";
const DEPLOYMENT = JSON.parse(readFileSync(new URL(`../../deployments/${CHAIN_ID}.json`, import.meta.url), "utf8"));
const FOUNDRY = `${process.env.HOME}/.foundry/bin`;
const LOCAL_CHAIN = CHAIN_ID === "31337" || CHAIN_ID === "1337";

/// 國家 Safe 的 owner 金鑰。本機是 anvil 助記詞的帳戶 5、6、7（門檻 2-of-3）；
/// 公開鏈上由環境變數給——那條鏈上的 owners 是真的金鑰，不在這份原始碼裡。
const ANVIL_OWNER_PKS = [
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // account 5
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // account 6
];
const OWNER_PKS = (process.env.NATIONAL_OWNER_PKS ?? (LOCAL_CHAIN ? ANVIL_OWNER_PKS.join(",") : ""))
  .split(",").map((x) => x.trim()).filter(Boolean);
/// 等待期超過這個秒數就不真的等。公開測試鏈請用短的等待期部署（RECOVERY_DELAY=600）。
const MAX_WAIT_S = Number(process.env.E2E_MAX_RECOVERY_WAIT ?? 900);
/// 送 execTransaction 的付 gas 帳戶。任何有餘額的帳戶都可以，不必是 owner。
const SENDER_PK = process.env.SENDER_PK ?? process.env.RELAYER_PK
  ?? (LOCAL_CHAIN ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : "");
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

// recoveryAgent 是國家 Safe。下面所有以治理方身分做的事都走真的多簽
// （script/govern.sh safe national exec），和正式環境同一條路。
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

// ── 以國家 Safe 的身分做一件事 ────────────────────────────────
//
// 真的多簽：owners 各自對 Safe 算出來的 transaction hash 簽名，湊齊門檻再送出。
// 用的是 script/govern.sh —— 治理操作手冊上寫的就是這一支，測試走同一條路，
// 手冊寫錯的時候測試才會跟著紅。
if (OWNER_PKS.length === 0 || !SENDER_PK) {
  throw new Error(
    `這條鏈（chainId ${CHAIN_ID}）不是本機鏈，需要國家 Safe 的 owner 金鑰才能測復原流程。\n` +
    `請設定 NATIONAL_OWNER_PKS=<pk1,pk2>（要湊得到門檻）與 SENDER_PK（付 gas，任何有餘額的帳戶）。`,
  );
}
const govern = (...args) =>
  execFileSync(new URL("../../script/govern.sh", import.meta.url).pathname, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, RPC_URL: RPC, CHAIN_ID, SENDER_PK },
  }).trim();

function asAgent(target, sig, ...args) {
  const data = cast("calldata", sig, ...args);
  const hash = govern("safe", "national", "hash", target, data).split(/\s+/)[0];
  const sigs = OWNER_PKS.map((pk) => {
    const owner = cast("wallet", "address", "--private-key", pk);
    return `${owner}:${govern("sign", hash, "--private-key", pk)}`;
  });
  const out = govern("safe", "national", "exec", target, data, ...sigs);
  if (!/status\s+1/.test(out)) throw new Error(`Safe 交易沒有成功：\n${out}`);
  return out;
}

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
const chainTime = () => Number(cast("block", "--rpc-url", RPC, "latest", "--field", "timestamp"));
const before = chainTime();

// 這條鏈讓不讓我們調時間？讓的話跳過去，不讓的話真的等。
let snapshot = null;
try {
  snapshot = rpc("evm_snapshot").replace(/"/g, "");
} catch { snapshot = null; }

if (snapshot) {
  // 從這裡開始動到鏈的時鐘，所以先留了快照，最後一定要 revert 回來（見檔頭）。
  rpc("evm_increaseTime", [`0x${(delay + 60).toString(16)}`]);
  rpc("evm_mine");
} else if (delay <= MAX_WAIT_S) {
  const wait = delay + 15;
  console.log(`  · 這條鏈不能調時間，真的等 ${wait} 秒（鏈上的 RECOVERY_DELAY = ${delay} 秒）`);
  await new Promise((r) => setTimeout(r, wait * 1000));
} else {
  throw new Error(
    `這條鏈不能調整時間，而鏈上的 RECOVERY_DELAY 是 ${delay} 秒（${(delay / 3600).toFixed(1)} 小時），\n` +
    `超過這支測試願意等的 ${MAX_WAIT_S} 秒。\n\n` +
    `公開測試鏈請用短的等待期部署：\n` +
    `  RECOVERY_DELAY=600 forge script script/DeployV4.s.sol --rpc-url base_sepolia --broadcast\n\n` +
    `（等待期是 PasskeyAccountFactory 的部署參數，合約端改不了——正式環境仍然是 72 小時。）\n` +
    `真的想等完就設 E2E_MAX_RECOVERY_WAIT=${delay + 60}。`,
  );
}

// 執行。注意 finaliseRecovery **任何人都能呼叫**——等待期屆滿之後，執行不是特權，
// 提案才是。所以這裡刻意不用治理方的身分送，用一個路人帳戶。
const fin = cast("send", "--rpc-url", RPC, "--private-key", SENDER_PK, address, "finaliseRecovery()");
if (!/status\s+1/.test(fin)) throw new Error(`finaliseRecovery 沒有成功：\n${fin}`);

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

// 時鐘回到原位。不做這件事，下一個跑 KYC 的人會看到 register revert，
// 而且沒有任何線索指向這支測試。（沒有快照就沒有動過時鐘，也就沒有東西要復原。）
if (snapshot) {
  rpc("evm_revert", [snapshot]);
  const back = chainTime();
  ok(Math.abs(back - before) < 600, `鏈上時鐘回到快照當下（差 ${back - before} 秒），沒有把 ${(delay / 3600).toFixed(0)} 小時留給下一個人`);
} else {
  ok(true, "這條鏈的時鐘本來就沒被動過（真的等完了等待期）");
}
await browser.close();
console.log("\n帳戶復原：全部通過");
