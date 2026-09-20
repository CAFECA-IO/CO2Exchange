/**
 * 模擬用戶的人物設定。
 *
 * 一百個帳戶如果只是「隨機買、隨機賣」，畫出來的圖會很像市場，但經不起看：
 * 成交量沒有季節、買方沒有理由、註銷不會集中在申報季，而且每次重跑都不一樣。
 * 所以這裡先把「人」定義清楚——他是誰、為什麼來、預算多少、什麼時候急——
 * 行為再從人物設定推導出來。
 *
 * 全部由種子決定（mulberry32），同一個 seed 一定產生同一批人，
 * 換句話說：出問題可以重現，截圖可以重拍。
 *
 * ⚠️ 所有名稱皆為虛構，與任何真實公司或個人無關。
 */

/// 32-bit 種子亂數。不用 Math.random：那個沒辦法重現。
export function mulberry32(seed) {
  let a = typeof seed === "string"
    ? [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 0x9e3779b9)
    : seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const intBetween = (rng, lo, hi) => Math.floor(between(rng, lo, hi + 1));

/// 角色。每一種的「為什麼來」都不一樣，行為模型也就不一樣。
export const ROLES = {
  /// 專案方：自己做減量、自己核發、把額度賣掉。市場的供給端。
  developer: { label: "專案開發者", tier: "corporate", weight: 16 },
  /// 碳價履約對象：被碳費／碳稅／ETS 管到的排放源。需求最大、最集中在申報季。
  compliance: { label: "碳價履約對象", tier: "corporate", weight: 22 },
  /// 自願宣告：ESG 報告、產品碳中和。全年平均、量體小。
  voluntary: { label: "自願宣告企業", tier: "corporate", weight: 22 },
  /// 環評增量抵換：開發案要抵換，時間點集中、非買不可，而且只能用國內額度。
  eia: { label: "開發案抵換", tier: "corporate", weight: 8 },
  /// 做市商：低買高掛，維持兩邊都有價。
  maker: { label: "做市商", tier: "corporate", weight: 7 },
  /// 個人投資者：小額、看價格、不能註銷（官方登錄簿不開個人帳戶）。
  retail: { label: "個人投資者", tier: "individual", weight: 25 },
};

/// 產業別。決定排放規模與是否屬高碳洩漏風險（後者在臺灣申報時不得使用國外額度）。
const INDUSTRIES = [
  { name: "鋼鐵", emissionKt: [120, 900], leakageRisk: true },
  { name: "水泥", emissionKt: [200, 1200], leakageRisk: true },
  { name: "石化", emissionKt: [150, 800], leakageRisk: true },
  { name: "金屬扣件", emissionKt: [3, 30], leakageRisk: false },
  { name: "電子組裝", emissionKt: [8, 60], leakageRisk: false },
  { name: "半導體封測", emissionKt: [25, 180], leakageRisk: false },
  { name: "紡織", emissionKt: [5, 40], leakageRisk: false },
  { name: "食品加工", emissionKt: [4, 25], leakageRisk: false },
  { name: "物流倉儲", emissionKt: [2, 18], leakageRisk: false },
  { name: "金融服務", emissionKt: [1, 6], leakageRisk: false },
  { name: "零售通路", emissionKt: [3, 22], leakageRisk: false },
  { name: "營建", emissionKt: [6, 45], leakageRisk: false },
];

/// 減量專案的類型。開發者的專案名稱從這裡長出來。
const PROJECT_KINDS = [
  { what: "鍋爐燃料轉換", methodology: "ISO 14064-2 / BOILER-01" },
  { what: "廢熱回收發電", methodology: "ISO 14064-2 / WHR-02" },
  { what: "屋頂太陽能自用", methodology: "ISO 14064-2 / RE-01" },
  { what: "空壓系統節能改善", methodology: "ISO 14064-2 / EE-04" },
  { what: "沼氣回收發電", methodology: "ISO 14064-2 / CH4-03" },
  { what: "冰水主機汰換", methodology: "ISO 14064-2 / EE-07" },
  { what: "造林與森林經營", methodology: "ISO 14064-2 / AFOLU-01" },
  { what: "廠內電動車隊轉換", methodology: "ISO 14064-2 / EV-02" },
];

/// 虛構公司名的組件。刻意組成不存在的名字，避免碰到真實企業。
const CO_PREFIX = ["昇", "泰", "宏", "誠", "亞", "光", "鼎", "順", "永", "嘉", "禾", "群", "睿", "恆", "廣", "通"];
const CO_MID = ["鋼", "興", "捷", "新", "工", "利", "全", "晟", "洋", "元", "峰", "豐", "冠", "邦"];
const CO_SUFFIX = ["股份有限公司", "實業股份有限公司", "工業股份有限公司", "科技股份有限公司", "企業股份有限公司"];
const SURNAME = ["陳", "林", "黃", "張", "李", "王", "吳", "劉", "蔡", "楊", "許", "鄭", "謝", "郭", "洪", "曾"];
const GIVEN = ["宗翰", "怡君", "建宏", "雅雯", "俊傑", "美玲", "承恩", "佩君", "志豪", "淑芬", "冠廷", "思婷", "柏翰", "欣怡"];

/// 城市 → 申報地。多數在臺灣，但這是國際平台，讀者可能在首爾或曼谷。
const LOCATIONS = [
  { city: "高雄", country: "TW", w: 16 },
  { city: "臺中", country: "TW", w: 14 },
  { city: "桃園", country: "TW", w: 12 },
  { city: "臺南", country: "TW", w: 10 },
  { city: "新北", country: "TW", w: 10 },
  { city: "彰化", country: "TW", w: 6 },
  { city: "雲林", country: "TW", w: 5 },
  { city: "首爾", country: "KR", w: 7 },
  { city: "大阪", country: "JP", w: 6 },
  { city: "東京", country: "JP", w: 5 },
  { city: "曼谷", country: "TH", w: 4 },
  { city: "新加坡", country: "SG", w: 3 },
  { city: "雅加達", country: "ID", w: 2 },
];

function weightedPick(rng, items, weightOf) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let r = rng() * total;
  for (const x of items) {
    r -= weightOf(x);
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

/// 申報季：決定需求什麼時候集中。
/// 臺灣碳費每年 5 月底前申報前一年排放，所以 3–5 月最急；
/// 韓國 K-ETS 的履約期限在 6 月底，日本的年度結算在 3 月。
const REPORTING_MONTHS = { TW: [3, 4, 5], KR: [4, 5, 6], JP: [1, 2, 3], TH: [3, 4], SG: [8, 9], ID: [3, 4] };

/**
 * 產生 n 個人物。同一個 seed 一定得到同一批。
 */
export function buildPersonas(n, seed) {
  const rng = mulberry32(seed);
  const roleKeys = Object.keys(ROLES);
  const out = [];

  for (let i = 0; i < n; i++) {
    const roleKey = weightedPick(rng, roleKeys, (k) => ROLES[k].weight);
    const role = ROLES[roleKey];
    const loc = weightedPick(rng, LOCATIONS, (l) => l.w);
    const individual = role.tier === "individual";
    // 專案開發者要有東西可以減：金融、零售這種排放集中在用電與供應鏈的行業，
    // 不會是本站上的專案方，挑產業時先排除。
    const pool = roleKey === "developer" ? INDUSTRIES.filter((x) => x.emissionKt[1] >= 20) : INDUSTRIES;
    const industry = individual ? null : pick(rng, pool);

    const emissionKt = industry ? Math.round(between(rng, ...industry.emissionKt)) : 0;
    // 需求量：履約對象按排放量的一小段。制度本來就只讓額度補最後一段——
    // 臺灣碳費的減量額度抵換上限是排放量的 10%（國內）／5%（國外），
    // 而多數事業會先用自主減量計畫的優惠費率，真正拿到市場上買的遠低於上限。
    // 自願宣告與環評抵換按專案規模，跟排放量關係比較弱。
    const annualNeedTonnes = {
      compliance: Math.round(emissionKt * 1000 * between(rng, 0.008, 0.025)),
      voluntary: Math.round(between(rng, 50, 900)),
      eia: Math.round(between(rng, 200, 2500)),
      developer: 0,
      maker: 0,
      retail: Math.round(between(rng, 1, 25)),
    }[roleKey];

    const persona = {
      id: i,
      role: roleKey,
      roleLabel: role.label,
      tier: role.tier,
      name: individual
        ? `${pick(rng, SURNAME)}${pick(rng, GIVEN)}`
        : `${pick(rng, CO_PREFIX)}${pick(rng, CO_MID)}${pick(rng, CO_SUFFIX)}`,
      city: loc.city,
      /// 申報地：他的法規義務在哪一國，決定他偏好哪一國的額度
      country: loc.country,
      industry: industry?.name ?? "—",
      /// 高碳洩漏風險事業在臺灣申報時完全不得使用國外額度（碳費收費辦法第 10 條）
      leakageRisk: !!industry?.leakageRisk,
      emissionKt,
      annualNeedTonnes,
      /// 心理價位：相對於市場參考價的倍數。低於這個價才願意買。
      priceTolerance: Number(between(rng, roleKey === "maker" ? 0.92 : 1.0, roleKey === "eia" ? 1.35 : 1.15).toFixed(3)),
      /// 每個 tick 行動的基礎機率
      activity: Number(between(rng, 0.04, roleKey === "maker" ? 0.55 : 0.28).toFixed(3)),
      /// 願意用國外額度的比例上限（臺灣申報時法規上限就是 5%；其他人自己設限）
      foreignShare: industry?.leakageRisk
        ? 0
        : Number(between(rng, 0, roleKey === "retail" ? 0.8 : 0.35).toFixed(2)),
      reportingMonths: REPORTING_MONTHS[loc.country] ?? [3, 4, 5],
      /// 錢包索引（由助記詞推導，index 100 起跳，避開 anvil 的預設十個帳戶）
      walletIndex: 100 + i,
      /// 加入平台的時間（回填時用，落在模擬區間的前 35%）。
      /// 之前放到 60%，結果回填的前半段簿子上幾乎沒人，圖表開頭是一條平的。
      joinAt: Number(between(rng, 0, 0.35).toFixed(4)),
      project: individual || roleKey !== "developer" ? null : pick(rng, PROJECT_KINDS),
    };

    // 專案方的專案名稱：地名 + 做什麼，跟真實專案的命名習慣一致
    if (persona.project) {
      persona.projectName = `${persona.city} ${persona.project.what}`;
      // 專案年減量規模。核發受這個數字約束：一年之內不可能核發出比實際減量更多的額度。
      persona.projectScaleTonnes = Math.round(between(rng, 1500, 14000));
    }
    out.push(persona);
  }
  return out;
}

/// 這個 persona 在這個月份的需求倍數：申報季會急，其他時候平淡。
export function seasonality(persona, date) {
  const m = date.getUTCMonth() + 1;
  if (persona.reportingMonths.includes(m)) return 2.6;
  // 申報季前一個月開始有人提前布局
  if (persona.reportingMonths.includes(m + 1)) return 1.5;
  return 1;
}

export function rosterSummary(personas) {
  const byRole = new Map();
  for (const p of personas) byRole.set(p.roleLabel, (byRole.get(p.roleLabel) ?? 0) + 1);
  const byCountry = new Map();
  for (const p of personas) byCountry.set(p.country, (byCountry.get(p.country) ?? 0) + 1);
  return {
    total: personas.length,
    roles: [...byRole.entries()].sort((a, b) => b[1] - a[1]),
    countries: [...byCountry.entries()].sort((a, b) => b[1] - a[1]),
    annualDemandTonnes: personas.reduce((s, p) => s + p.annualNeedTonnes, 0),
    supplyTonnes: personas.reduce((s, p) => s + (p.projectScaleTonnes ?? 0), 0),
  };
}
