// economy.js — 积分经济（v2.32）：比赛奖励表 + 里程积分常数
// 定价见 cars.js CAR_SPECS.price；经济节奏校准见 docs/DESIGN_GAME_SYSTEMS.md §2-3
// 名次系数：第1名 1.0 / 第2名 0.6 / 第3名 0.4 / 完赛 0.2

export const RANK_MULT = [1.0, 0.6, 0.4, 0.2];

// 每事件基础分；firstWin = 首次夺冠额外加成；recordDouble = 破纪录奖励翻倍
export const RACE_REWARDS = {
  race:              { base: 60, firstWin: 40 },
  time:              { base: 30, recordDouble: true },
  drag:              { base: 25, recordDouble: true },
  collect:           { base: 35 },
  sprint_highway:    { base: 50, firstWin: 30 },
  sprint_canyon:     { base: 70, firstWin: 45 },
  sprint_lakeside:   { base: 60, firstWin: 40 },
  offroad_stampede:  { base: 90, firstWin: 60 },
};

// 事件结算 → 积分。rank 为名次（time/drag/collect 传 0 表示无名次制）
export function eventReward(key, rank, isRecord, raceLog) {
  const cfg = RACE_REWARDS[key];
  if (!cfg) return 0;
  let pts = cfg.base;
  if (rank >= 1) pts *= RANK_MULT[Math.min(rank - 1, RANK_MULT.length - 1)];
  if (cfg.recordDouble && isRecord) pts *= 2;
  if (cfg.firstWin && rank === 1 && !(raceLog && raceLog[key] && raceLog[key].win)) pts += cfg.firstWin;
  return Math.round(pts);
}

// 首胜标记（结算后由 game 写入 raceLog）
export function markRaceResult(key, rank, raceLog) {
  if (!key) return;
  const e = raceLog[key] || (raceLog[key] = { plays: 0, wins: 0, bestRank: 99 });
  e.plays++;
  if (rank === 1) { e.wins++; e.win = true; }
  if (rank >= 1 && rank < e.bestRank) e.bestRank = rank;
}

// 里程积分：每 1000m = 1 分（game.addOdometer 消费）
export const ODO_STEP = 1000;     // 米/分
export const ODO_MIN_SPEED = 1.5; // 低于此速度(m/s)不攒（静止挪车不刷分）
export const ODO_FRAME_CAP = 30;  // 单帧里程钳位（m）：吸收帧尖峰，防大 dt 刷分
