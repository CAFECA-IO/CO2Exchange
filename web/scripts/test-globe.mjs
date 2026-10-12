#!/usr/bin/env node
// 首頁地球的點陣：解得回來、點數對得上、每個點標的國家對得上真實世界。
//   npm run test:globe
import assert from "node:assert/strict";

const G = await import("../lib/globe.ts");
const D = await import("../lib/globe-dots.ts");

const ok = (m) => console.log("  ✓", m);
const f = await G.buildDots();

const total = D.GLOBE_ROW_COUNTS.reduce((a, b) => a + b, 0);
assert.ok(f.n > 25_000 && f.n < 45_000, `陸地點數 ${f.n} 不在合理範圍`);
ok(`取樣 ${total} 點，陸地 ${f.n} 點，${G.COUNTRIES.length} 國`);

// 每個點都在單位球上，而且標了國家表裡的某一國
for (let i = 0; i < f.n; i++) {
  const r = f.x[i] ** 2 + f.y[i] ** 2 + f.z[i] ** 2;
  assert.ok(Math.abs(r - 1) < 1e-5, `第 ${i} 點不在單位球上`);
  assert.ok(f.country[i] < G.COUNTRIES.length, `第 ${i} 點的國家索引超出國家表`);
}
ok("每個點都在單位球上、都標了國家");

// 每一國至少一個點（取樣拿不到的小國有補點）
const seen = new Set(Array.from(f.country));
assert.equal(seen.size, G.COUNTRIES.length, "有國家一個點都沒有");
ok("國家表裡的每一國都至少有一個點");

const SPOT = [
  ["臺北", 121.56, 25.03, "TW"], ["東京", 139.69, 35.68, "JP"], ["首爾", 126.98, 37.57, "KR"],
  ["北京", 116.4, 39.9, "CN"], ["新德里", 77.21, 28.61, "IN"], ["雅加達", 106.85, -6.2, "ID"],
  ["愛麗絲泉", 133.88, -23.7, "AU"], ["新加坡", 103.8, 1.35, "SG"], ["莫斯科", 37.62, 55.76, "RU"],
  ["楚科奇（換日線東側）", -172, 66, "RU"], ["斐濟", 178, -17.8, "FJ"], ["賴索托（南非裡的洞）", 28.2, -29.5, "LS"],
  ["巴黎", 2.35, 48.86, "FR"], ["芝加哥", -87.63, 41.88, "US"], ["聖保羅", -46.63, -23.55, "BR"],
  ["南極", 0, -85, "AQ"],
];
for (const [name, lon, lat, want] of SPOT) {
  const got = G.countryAt(f, lon, lat, want === "SG" ? 80 : 70);
  assert.equal(got, want, `${name} 應該是 ${want}，點陣標的是 ${got}`);
}
ok(`${SPOT.length} 個地點標的國家都對（含換日線兩側、國中之國、取樣拿不到的新加坡）`);

for (const [name, lon, lat] of [["北太平洋", -160, 30], ["南大西洋", -20, -30], ["印度洋", 80, -20], ["臺灣海峽", 119.6, 24.3]]) {
  assert.equal(G.countryAt(f, lon, lat, 30), null, `${name} 應該是海`);
}
ok("海上沒有點");

const name = new Map(G.COUNTRIES);
assert.equal(name.get("TW"), "臺灣"); assert.equal(name.get("KR"), "韓國");
ok("國名用本站用語（臺灣、韓國）");
console.log("\n地球點陣測試通過");
