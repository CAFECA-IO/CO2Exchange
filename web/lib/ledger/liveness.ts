/// 承諾排程有沒有在跑（設計 v4 §九「承諾排程停擺」）。
///
/// 為什麼要專門看它：每小時的承諾是這個設計裡**唯一**把帳本釘上鏈的動作。
/// 它停了，畫面上什麼都不會壞——掛單照收、成交照算、餘額照顯示——
/// 但從停的那一刻起，新的事件只存在營運方自己的機器上；出金請求進不了證據，
/// 營運方也沒辦法確認出金（合約只銷已進承諾的請求）。這是一種**安靜的**故障，
/// 所以要有人主動問、而且答案要能被機器讀（外部的監控服務、cron、demo-box）。
///
/// 判斷只看兩件事：
///   ① 還沒進承諾的事件，最舊那一筆等了多久（有新事件卻遲遲不提交）
///   ② 上一期承諾距今多久（沒有新事件時，提交程式每 HEARTBEAT_AFTER 秒會交一期空的；
///      連空的都沒有，代表提交程式本身沒在跑）
///
/// 「現在」取牆上時鐘與鏈上最新區塊時間的較大者：鏈停了區塊時間就不動，只看它會以為一切正常；
/// 本機展示鏈有時會快轉時間，只看牆上時鐘又會把剛交的一期算成「未來」。

export type LivenessStatus = "ok" | "late" | "stalled" | "empty";

export type LivenessThresholds = {
  /// 有事件等超過這麼久還沒進承諾 → late（預設 2 小時：排程每小時一次，漏一次還算正常）
  lateAfter: number;
  /// 超過這麼久 → stalled（預設 6 小時）
  stalledAfter: number;
  /// 提交程式在沒有新事件時多久交一期空的（與 ledger-commit 的 HEARTBEAT_AFTER 同一個值）
  heartbeatAfter: number;
};

export type Liveness = {
  status: LivenessStatus;
  /// 給人看的一句話
  reason: string;
  now: number;
  lastEpoch: number | null;
  lastCommittedAt: number | null;
  /// 已進承諾的最後一筆事件序號
  committedSeq: number;
  /// 帳本目前的最後一筆
  headSeq: number;
  /// 還沒進承諾的事件數
  uncommitted: number;
  /// 最舊那一筆未承諾事件的收單時間
  oldestUncommittedAt: number | null;
  /// 落後多少秒（兩個條件取大者；0 = 沒有落後）
  lagSeconds: number;
  thresholds: LivenessThresholds;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function thresholdsFromEnv(env: Record<string, string | undefined> = process.env): LivenessThresholds {
  const lateAfter = num(env.COMMIT_LATE_AFTER, 2 * 3600);
  return {
    lateAfter,
    stalledAfter: Math.max(lateAfter, num(env.COMMIT_STALLED_AFTER, 6 * 3600)),
    heartbeatAfter: num(env.HEARTBEAT_AFTER, 86_400),
  };
}

const human = (s: number) =>
  s >= 86_400 ? `${(s / 86_400).toFixed(1)} 天` : s >= 3600 ? `${(s / 3600).toFixed(1)} 小時` : s < 60 ? "不到 1 分鐘" : `${Math.round(s / 60)} 分鐘`;

export function assessLiveness(input: {
  wallClock: number;
  chainTime: number;
  /// 帳本事件的收單時間（依序號；只需要 `at`）
  events: { at: bigint | number }[];
  lastEpoch: number | null;
  committedSeq: number;
  lastCommittedAt: number | null;
  thresholds: LivenessThresholds;
}): Liveness {
  const { events, thresholds: t } = input;
  const now = Math.max(input.wallClock, input.chainTime);
  const headSeq = events.length;
  const committedSeq = Math.min(input.committedSeq, headSeq);
  const uncommitted = headSeq - committedSeq;
  const oldestUncommittedAt = uncommitted > 0 ? Number(events[committedSeq].at) : null;
  const base = { now, lastEpoch: input.lastEpoch, lastCommittedAt: input.lastCommittedAt, committedSeq, headSeq, uncommitted, oldestUncommittedAt, thresholds: t };

  if (input.lastEpoch === null && headSeq === 0) {
    return { ...base, status: "empty", reason: "帳本還沒有任何事件，也還沒有承諾。", lagSeconds: 0 };
  }
  // ① 有事件在等
  const waiting = oldestUncommittedAt !== null ? Math.max(0, now - oldestUncommittedAt) : 0;
  // ② 連心跳都沒有：上一期之後超過 heartbeatAfter 還沒有下一期
  const silent = input.lastCommittedAt !== null ? Math.max(0, now - input.lastCommittedAt - t.heartbeatAfter) : 0;
  const lagSeconds = Math.max(waiting, silent);

  const why = waiting >= silent
    ? `有 ${uncommitted} 筆事件還沒進承諾，最舊的已經等了 ${human(waiting)}`
    : `上一期承諾是 ${human(now - input.lastCommittedAt!)}前，連每 ${human(t.heartbeatAfter)} 一次的空承諾都沒有`;

  if (lagSeconds >= t.stalledAfter) {
    return { ...base, status: "stalled", lagSeconds, reason: `承諾排程停擺：${why}。出金請求進不了證據、營運方也不能確認出金。` };
  }
  if (lagSeconds >= t.lateAfter) {
    return { ...base, status: "late", lagSeconds, reason: `承諾落後：${why}。` };
  }
  const last = input.lastCommittedAt !== null ? `上一期（第 ${input.lastEpoch} 期）是 ${human(now - input.lastCommittedAt)}前` : "還沒有承諾";
  return { ...base, status: "ok", lagSeconds, reason: uncommitted ? `正常：${last}，${uncommitted} 筆事件等下一期。` : `正常：${last}，帳本全部已進承諾。` };
}
