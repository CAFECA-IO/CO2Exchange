import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/// 委託單 log：交易所收到的每一件事，照順序、接成一條雜湊鏈。
///
/// **這個檔案不依賴 Next、不用路徑別名**（和 `ledger-core.ts` 同樣的理由）：
/// 重播工具、查核機構、以及任何想自己算一次的人都要跑得動它。
///
/// ## 只記輸入，不記結果
///
/// log 裡只有**輸入**：外部事件（存入、註銷、提領——鏈上發生的）與使用者簽名的
/// 意思表示（掛單、撤單）。成交**不記在 log 裡**，因為它是撮合引擎從輸入算出來的。
///
/// 這個選擇是刻意的，而且是整個設計能不能被驗證的關鍵：
///
///   · 記了結果，就有兩份真相。哪天引擎的輸出和 log 裡記的成交對不上，
///     沒有人說得出哪一份才算數——而交易所會傾向於說對自己有利的那一份。
///   · 只記輸入，「重播」才是一個有意義的動作：同一串輸入必須得出同一組成交、
///     同一棵餘額樹、同一個 root。對不上就是有人錯了，而且錯的一定不是輸入。
///
/// 成交清單仍然會發布（監理與查核要看），但它是**衍生資料**，附在批次檔裡，
/// 標明是算出來的，不是宣稱的。
///
/// ## 正規化編碼
///
/// 用 ABI 編碼而不是 JSON。JSON 的正規化是個地雷區：鍵的順序、數字格式、
/// unicode 逸出、空白——任何一個細節在兩份實作之間不一致，雜湊就不一樣，
/// 而症狀是「查核機構算出來的 root 和鏈上的對不上」，看起來像交易所作假。
///
/// 每一種事件有固定的欄位順序與型別，前面帶版本與種類。**版本欄位第一版就要有**：
/// 編碼一改，所有歷史雜湊失效，沒有版本的話連「這筆是用舊格式算的」都說不出來。

export const LOG_VERSION = 1;

/// 事件種類。數字進雜湊，所以**只能往後加，不能重排、不能重用**。
export const KIND = {
  deposit: 1, // 鏈上：碳權存入
  cashDeposit: 2, // 鏈上：結算幣存入
  retire: 3, // 鏈上：代為註銷（額度離開池子，憑證記名給使用者）
  withdraw: 4, // 鏈上：碳權提領
  cashWithdraw: 5, // 鏈上：結算幣提領
  place: 10, // 使用者簽章：掛單
  cancel: 11, // 使用者簽章：撤單
  config: 20, // 參數變更（手續費率）。鏡像自鏈上，讓重播不必去猜當時的費率
} as const;
export type Kind = keyof typeof KIND;

/// 鏈上事件在 log 裡的憑據。重播的人拿它回鏈上核對「這件事真的發生過」——
/// 少了它，交易所可以在 log 裡塞一筆不存在的存入，而餘額樹會完全自洽。
export type ChainRef = { txHash: Hex; block: bigint; logIndex: number };

type Base = { seq: bigint; at: bigint };

export type Event = Base &
  (
    | { kind: "deposit"; ref: ChainRef; account: Address; batchId: bigint; amountKg: bigint }
    | { kind: "cashDeposit"; ref: ChainRef; account: Address; amount: bigint }
    | { kind: "retire"; ref: ChainRef; account: Address; batchId: bigint; amountKg: bigint }
    | { kind: "withdraw"; ref: ChainRef; account: Address; batchId: bigint; amountKg: bigint }
    | { kind: "cashWithdraw"; ref: ChainRef; account: Address; amount: bigint }
    | {
        kind: "place";
        account: Address;
        side: "buy" | "sell";
        /// 賣單：指定批次。買單：指定轄區（買方不挑批次，只挑核發國）。
        batchId: bigint;
        country: string;
        amountKg: bigint;
        pricePerTonne: bigint;
        minFillKg: bigint;
        /// 這張單的有效期限（秒）。過期由**邏輯時間**判定，不是牆上時鐘。
        expiry: bigint;
        /// 帳戶自己的單調序號，防重放。
        nonce: bigint;
        signature: Hex;
      }
    | { kind: "cancel"; account: Address; orderSeq: bigint; nonce: bigint; signature: Hex }
    | { kind: "config"; feeBps: bigint; ref?: ChainRef }
  );

const REF = [
  { type: "bytes32" }, // txHash
  { type: "uint256" }, // block
  { type: "uint32" }, // logIndex
] as const;

const ZERO_REF: ChainRef = { txHash: `0x${"0".repeat(64)}`, block: 0n, logIndex: 0 };
const refTuple = (r: ChainRef = ZERO_REF) => [r.txHash, r.block, r.logIndex] as const;

/// 一筆事件的正規化位元組。
///
/// 每一種事件的型別列表都固定且不同，所以不同種類的事件不可能編出同一串位元組
/// （種類本身也在裡面）。簽章也編進去：不編的話，別人可以把同一個內容配上
/// 另一個簽章塞進 log，而雜湊不變。
export function encodeEvent(e: Event): Hex {
  const head = [
    { type: "uint16" },
    { type: "uint8" },
    { type: "uint64" },
    { type: "uint64" },
  ] as const;
  const headVals = [LOG_VERSION, KIND[e.kind], e.seq, e.at] as const;

  switch (e.kind) {
    case "deposit":
    case "retire":
    case "withdraw":
      return encodeAbiParameters(
        [...head, ...REF, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [...headVals, ...refTuple(e.ref), e.account, e.batchId, e.amountKg],
      );
    case "cashDeposit":
    case "cashWithdraw":
      return encodeAbiParameters(
        [...head, ...REF, { type: "address" }, { type: "uint256" }],
        [...headVals, ...refTuple(e.ref), e.account, e.amount],
      );
    case "place":
      return encodeAbiParameters(
        [
          ...head,
          { type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "bytes2" },
          { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
          { type: "uint64" }, { type: "uint256" }, { type: "bytes" },
        ],
        [
          ...headVals,
          e.account, e.side === "buy" ? 0 : 1, e.batchId, countryToBytes2(e.country),
          e.amountKg, e.pricePerTonne, e.minFillKg,
          e.expiry, e.nonce, e.signature,
        ],
      );
    case "cancel":
      return encodeAbiParameters(
        [...head, { type: "address" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }],
        [...headVals, e.account, e.orderSeq, e.nonce, e.signature],
      );
    case "config":
      return encodeAbiParameters(
        [...head, ...REF, { type: "uint256" }],
        [...headVals, ...refTuple(e.ref), e.feeBps],
      );
  }
}

export const countryToBytes2 = (c: string): Hex => {
  const s = (c || "\u0000\u0000").padEnd(2, "\u0000").slice(0, 2);
  return `0x${s.charCodeAt(0).toString(16).padStart(2, "0")}${s.charCodeAt(1).toString(16).padStart(2, "0")}`;
};

export const eventHash = (e: Event): Hex => keccak256(encodeEvent(e));

/// 事件級的雜湊鏈：h_n = H(h_{n-1} ‖ H(event_n))
///
/// 它讓使用者在批次還沒上鏈之前就拿得到一個**位置已經被釘住**的收據。
/// 批次級的 anchor 24 小時才一次；這條鏈是每一筆都接上去。
export const chainHash = (prev: Hex, e: Event): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [prev, eventHash(e)]));

export const GENESIS: Hex = keccak256(
  encodeAbiParameters([{ type: "string" }, { type: "uint16" }], ["co2x.orderlog", LOG_VERSION]),
);

/// 一整批事件的 Merkle root（給 `commit` 的 `orderLogRoot`）。
///
/// 和餘額樹一樣：落單的節點往上帶，不補假葉子；葉子與節點用不同前綴。
/// 這裡不需要帶總額——log 沒有「總和」這種東西要證明，只需要包含性。
export function orderLogRoot(events: Event[]): Hex {
  if (events.length === 0) return `0x${"0".repeat(64)}`;
  let layer = events.map((e) => keccak256(encodeAbiParameters([{ type: "bytes1" }, { type: "bytes32" }], ["0x00", eventHash(e)])));
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(
        i + 1 < layer.length
          ? keccak256(
              encodeAbiParameters(
                [{ type: "bytes1" }, { type: "bytes32" }, { type: "bytes32" }],
                ["0x01", layer[i], layer[i + 1]],
              ),
            )
          : layer[i],
      );
    }
    layer = next;
  }
  return layer[0];
}

/// 簽收收據：交易所對「我收到了，而且放在第 seq 號位置」簽名認帳。
///
/// **這是整個存證設計能不能成立的地方。** 沒有它，雜湊鏈只證明
/// 「交易所選擇記下來的那些事情的順序」——不收某張單，鏈上看起來完美無瑕。
/// 有了它，使用者手上就有一份交易所自己簽名的承諾；那個序號沒有出現在任何批次裡，
/// 就是可以拿上鏈申訴的違約證據。
export type Receipt = {
  seq: bigint;
  eventHash: Hex;
  prevRunningHash: Hex;
  runningHash: Hex;
  receivedAt: bigint;
  /// 交易所的簽章（EIP-191 personal_sign over the digest）
  signature: Hex;
  signer: Address;
};

export const receiptDigest = (r: Omit<Receipt, "signature" | "signer">): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
      ["co2x.receipt.v1", r.seq, r.eventHash, r.prevRunningHash, r.runningHash, r.receivedAt],
    ),
  );
