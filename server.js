const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: '300kb' }));  // 내 덱 100개 동기화(약 70KB)를 받을 수 있게

// IP별 호출 횟수 제한 (서버 메모리, 재시작하면 초기화). Railway 프록시 뒤라 trust proxy로 실제 IP 사용
app.set('trust proxy', 1);
const rateBuckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const b = rateBuckets.get(key);
    if (!b || now - b.start >= windowMs) rateBuckets.set(key, { start: now, count: 1 });
    else if (++b.count > max) return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    next();
  };
}
// 오래된 기록 정리
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now - b.start > 60 * 60 * 1000) rateBuckets.delete(k);
}, 10 * 60 * 1000).unref();

const TEN_MIN = 10 * 60 * 1000;
const calcLimit  = rateLimit('calc', 600, TEN_MIN);   // 공속 계산(아티 조정 미리보기 포함): 10분에 600번
const tableLimit = rateLimit('table', 60, TEN_MIN);   // 공속계산표(계산 21번 묶음): 10분에 60번
const dmgLimit   = rateLimit('dmg', 600, TEN_MIN);    // 데미지 계산(입력할 때마다): 10분에 600번

// ─── 라우트 ────────────────────────────────────────────────────
// 프로젝트 폴더를 정적 파일로 공개하지 않음 (server.js 등 소스가 그대로 내려받아지던 문제). 페이지는 아래 경로로만 제공
app.get('/td-spd-cal', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dmg-cal', (req, res) => res.sendFile(path.join(__dirname, 'dmg.html')));
// 예전 주소는 통합 데미지 계산기로 연결
app.get('/mulciri-dmg-cal', (req, res) => res.redirect(301, '/dmg-cal?m=mulciri'));
app.get('/mulmuhee-dmg-cal', (req, res) => res.redirect(301, '/dmg-cal?m=mulmuhee'));
app.get('/', (req, res) => res.status(404).send('Not Found'));

// ─── DB 초기화 ────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deck_records (
      id        SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      label     TEXT,
      mode      TEXT,
      leader_pct INT,
      totem_pct  INT,
      enemy_speed INT,
      monsters  JSONB,
      min_runes JSONB,
      notes     TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fav_sync (
      code       TEXT PRIMARY KEY,
      favs       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB initialized');
}

// ─── 계산 로직 ──────────────────────────────────────────────────────

const TICK_RATE = { siege: 0.07, arena: 0.015 };

const PRESETS_EXTRA = {
  '물호박': 39.5,
  '암헬하': 25,
};

// 몬스터별 추가 공속 (화면에서 보낸 값 우선, 없으면 이름으로 기본값)
function extraOf(m) {
  return typeof m.extra === 'number' ? m.extra : (PRESETS_EXTRA[m.name] || 0);
}

function calcSpeed(base, runeDisp, hasSwift, ldr, tot) {
  const mult = 1 + ldr/100 + tot/100;
  if (hasSwift) {
    const swRaw = base * 0.25;
    const swCeil = Math.ceil(swRaw);
    return Math.ceil(base * mult + (runeDisp - swCeil) + swRaw);
  }
  return Math.ceil(base * mult + runeDisp);
}

function calcBuff(speed, artiPct) {
  return Math.ceil(speed * (1 + 0.30 * (1 + artiPct/100)));
}

function resolveTgts(tgt, entities, selfIdx, alliesOnly) {
  if (tgt === 'all') return entities.map((_,i)=>i).filter(i => i !== selfIdx && (!alliesOnly || entities[i].isAlly));
  const n = parseInt(tgt);
  return (!isNaN(n) && n < 3 && n !== selfIdx) ? [n] : [];
}

function simulate(allies, enemySpd, tickRate, maxTicks) {
  const entities = [
    ...allies.map(m => ({ ...m, curSpd: m.speed, hasBuff: false })),
    { idx: allies.length, name: '상대 선턴잡이', isAlly: false, speed: enemySpd, curSpd: enemySpd, speedBuff: enemySpd, hasBuff: false, gAmt: 0, gTgt: 'none', sTgt: 'none' }
  ];
  let gauges = entities.map(() => 0);
  const events = [];
  // 게이지 동률이면 아군 먼저, 아군끼리는 몬1→몬2→몬3 (게임 시스템 규칙)
  const winsTie = (a, b) => a.isAlly && (!b.isAlly || a.idx < b.idx);

  for (let tick = 1; tick <= maxTicks; tick++) {
    for (let i = 0; i < entities.length; i++) gauges[i] += entities[i].curSpd * tickRate;

    let best = -1, bestG = 99.9999;
    for (let i = 0; i < entities.length; i++) {
      if (gauges[i] < 100) continue;
      if (gauges[i] > bestG + 1e-6 ||
          (Math.abs(gauges[i] - bestG) < 1e-6 && best >= 0 && winsTie(entities[i], entities[best]))) {
        best = i; bestG = gauges[i];
      }
    }
    if (best < 0) continue;

    const e = entities[best];
    gauges[best] = 0;
    const effects = [];

    if (e.isAlly) {
      if (e.gAmt > 0 && e.gTgt !== 'none') {
        const tgts = resolveTgts(e.gTgt, entities, best, true);
        tgts.forEach(j => { gauges[j] += e.gAmt; effects.push(`${entities[j].name} +${e.gAmt}%`); });
      }
      if (e.sTgt !== 'none') {
        const tgts = resolveTgts(e.sTgt, entities, best, true);
        tgts.forEach(j => {
          if (!entities[j].hasBuff) {
            entities[j].hasBuff = true;
            entities[j].curSpd = entities[j].speedBuff;
            effects.push(`${entities[j].name} 속버프(${entities[j].speedBuff})`);
          }
        });
      }
    }

    events.push({ tick, entity: e, gaugeAfter: gauges[best], effects });
  }
  return events;
}

// T틱 시점의 게이지 (1순위의 속버프는 T1틱 행동 이후부터 적용)
function gaugeAt(speed, arti, buffed, T1, T, bonus, tr) {
  const buffTicks = buffed ? Math.max(0, T - T1) : 0;
  return speed * tr * (T - buffTicks) + calcBuff(speed, arti) * tr * buffTicks + bonus;
}

// 아군 a가 같은 틱에 아군 b보다 먼저 턴을 받는지 (동률이면 몬1→몬2→몬3)
function allyGoesFirst(gaugeA, a, gaugeB, b) {
  return gaugeA > gaugeB + 1e-6 || (Math.abs(gaugeA - gaugeB) < 1e-6 && a.idx < b.idx);
}

function minRuneAnalysis(ally, totalBonus, enemySpd, targetTick, tickRate, ldr, tot) {
  const tr = tickRate;
  const needFromGauge = (enemySpd * tr * targetTick - totalBonus) / (tr * targetTick);
  const needFor100 = (100 - totalBonus) / (tr * targetTick);
  const needSpeed = Math.max(needFromGauge, needFor100);
  if (needSpeed <= 0) return { minSpeed: 0, minRune: 0, free: true };

  const extra = extraOf(ally);
  const mult = 1 + ldr/100 + tot/100;
  const swRaw = ally.swift ? ally.base * 0.25 : 0;
  const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
  const baseContrib = ally.base * mult + swRaw - swCeil;
  const minRune = Math.max(0, Math.ceil(needSpeed - extra - baseContrib));
  const achievedSpeed = calcSpeed(ally.base, minRune, ally.swift, ldr, tot) + extra;

  return { minSpeed: Math.ceil(needSpeed), minRune, achievedSpeed };
}

function runCalculation({ mode, ldr, tot, useEnemySpec, enemySpec, monsters }) {
  const tr = TICK_RATE[mode] || TICK_RATE.siege;
  // 속성이 달라 리더 효과를 받지 못하는 몬스터는 리더% 0으로 계산
  const ldrOf = m => (m.noLeader ? 0 : ldr);


  // 몬스터 speed 계산
  const allies = monsters.map(m => {
    let speed = calcSpeed(m.base, m.rune, m.swift, ldrOf(m), tot);
    speed += extraOf(m);
    const speedBuff = calcBuff(speed, m.arti);
    return { ...m, speed, speedBuff, isAlly: true };
  });

  // 적 공속 결정
  let enemySpd;
  if (useEnemySpec && enemySpec) {
    enemySpd = enemySpec.direct
      ? enemySpec.speed
      : calcSpeed(enemySpec.base, enemySpec.rune, enemySpec.swift, enemySpec.ldr, enemySpec.tot);
  } else {
    const firstAlly = allies.find(a => a.turn === 1);
    enemySpd = firstAlly.speed;
  }

  const sortedAllies = [...allies].sort((a, b) => a.turn - b.turn);
  const first = sortedAllies[0];

  // 케이스 3: 1순위 < 적
  if (useEnemySpec && first.speed < enemySpd) {
    return { warning: 'slower-first' };
  }

  const firstTick = Math.ceil(100 / (first.speed * tr));
  const lead1stGivesSpeedBuff = first.sTgt !== 'none';
  const savedBonus = [];
  const savedTargetTick = [];

  for (let turnIdx = 1; turnIdx < 3; turnIdx++) {
    const ally = sortedAllies[turnIdx];
    if (!ally) continue;

    let totalBonus = 0;
    for (let i = 0; i < turnIdx; i++) {
      const prev = sortedAllies[i];
      if (!prev) continue;
      const getsGauge = prev.gTgt === 'all' || parseInt(prev.gTgt) === ally.idx;
      if (getsGauge && prev.gAmt > 0) totalBonus += prev.gAmt;
    }

    const targetTick = firstTick + turnIdx;
    savedBonus.push(totalBonus);
    savedTargetTick.push(targetTick);

    const getsSpeedBuff = lead1stGivesSpeedBuff && (first.sTgt === 'all' || parseInt(first.sTgt) === ally.idx);
    let needSpeed;
    if (getsSpeedBuff && firstTick > 1) {
      const buffMul = calcBuff(ally.speed, ally.arti) / ally.speed;
      const noBuffTicks = firstTick;
      const buffTicks = targetTick - firstTick;
      const numerator = enemySpd * targetTick - totalBonus / tr;
      const denominator = noBuffTicks + buffMul * buffTicks;
      needSpeed = Math.ceil(numerator / denominator);
    } else {
      needSpeed = Math.ceil(enemySpd - totalBonus / (tr * targetTick));
    }

    const extra = extraOf(ally);
    const mult = 1 + ldrOf(ally)/100 + tot/100;
    const swRaw = ally.swift ? ally.base * 0.25 : 0;
    const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
    const baseContrib = ally.base * mult + swRaw - swCeil;
    const needRune = Math.max(0, Math.ceil(needSpeed - extra - baseContrib));

    ally.rune = needRune;
    ally.speed = calcSpeed(ally.base, needRune, ally.swift, ldrOf(ally), tot) + extra;
    ally.speedBuff = calcBuff(ally.speed, ally.arti);
  }

  // 게이지 기반 순서 검증
  if (sortedAllies[1] && sortedAllies[2]) {
    const ally2 = sortedAllies[1];
    const ally3 = sortedAllies[2];
    const bonus2 = savedBonus[0] || 0;
    let bonus3ForOrdering = 0;
    const lead = sortedAllies[0];
    if (lead) {
      const getsGauge = lead.gTgt === 'all' || parseInt(lead.gTgt) === ally3.idx;
      if (getsGauge && lead.gAmt > 0) bonus3ForOrdering = lead.gAmt;
    }
    const targetTick2 = savedTargetTick[0] || (firstTick + 1);
    const buffedByLead = a => lead1stGivesSpeedBuff && (first.sTgt === 'all' || parseInt(first.sTgt) === a.idx);
    const gauge3 = gaugeAt(ally3.speed, ally3.arti, buffedByLead(ally3), firstTick, targetTick2, bonus3ForOrdering, tr);

    // 2순위가 3순위보다 먼저 턴을 받을 때까지 뒷속을 올림
    const extra2 = extraOf(ally2);
    const speed2Of = r => calcSpeed(ally2.base, r, ally2.swift, ldrOf(ally2), tot) + extra2;
    let fixedRune = ally2.rune;
    while (!allyGoesFirst(gaugeAt(speed2Of(fixedRune), ally2.arti, buffedByLead(ally2), firstTick, targetTick2, bonus2, tr), ally2, gauge3, ally3)) fixedRune++;
    if (fixedRune !== ally2.rune) {
      ally2.rune = fixedRune;
      ally2.speed = speed2Of(fixedRune);
      ally2.speedBuff = calcBuff(ally2.speed, ally2.arti);
    }
  }

  // 필요 최저 뒷속 요약 계산
  const sortedByTurn = [...allies].sort((a,b) => a.turn - b.turn);
  const lead = sortedByTurn[0];
  const others = sortedByTurn.slice(1);
  const simForSummary = simulate(allies, enemySpd, tr, 100);
  const allyFirstTurns = {};
  simForSummary.forEach(ev => {
    if (ev.entity.isAlly && !(ev.entity.name in allyFirstTurns)) {
      allyFirstTurns[ev.entity.name] = ev.tick;
    }
  });
  const T1 = allyFirstTurns[lead.name] || Math.ceil(100 / (lead.speed * tr));
  const lead1stGivesSpeedBuffSummary = lead.sTgt !== 'none';

  const minRuneSummary = others.map(ally => {
    const priorTurns = allies.filter(m => m.turn < ally.turn).length;
    const estimatedTi = T1 + priorTurns;
    const bonus = allies.reduce((sum, other) => {
      if (other.idx === ally.idx) return sum;
      const tgtMatch = other.gTgt === 'all' || parseInt(other.gTgt) === ally.idx;
      if (tgtMatch && other.gAmt > 0) {
        const otherFirstTurn = allyFirstTurns[other.name] || Math.ceil(100 / (other.speed * tr));
        if (otherFirstTurn < estimatedTi) return sum + other.gAmt;
      }
      return sum;
    }, 0);

    const getsSpeedBuff = lead1stGivesSpeedBuffSummary && (lead.sTgt === 'all' || parseInt(lead.sTgt) === ally.idx);
    const buffMul = getsSpeedBuff ? calcBuff(ally.speed, ally.arti) / ally.speed : 1;
    let minSpeed;
    if (getsSpeedBuff && T1 > 1) {
      const noBuffTicks = T1;
      const buffTicks = estimatedTi - T1;
      const numerator = enemySpd * estimatedTi - bonus / tr;
      const denominator = noBuffTicks + buffMul * buffTicks;
      minSpeed = Math.ceil(numerator / denominator);
    } else {
      minSpeed = Math.ceil(enemySpd - bonus / (tr * estimatedTi));
    }

    const extra = extraOf(ally);
    const mult = 1 + ldrOf(ally)/100 + tot/100;
    const swRaw = ally.swift ? ally.base * 0.25 : 0;
    const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
    const baseContrib = ally.base * mult + swRaw - swCeil;
    let minRune = Math.max(0, Math.ceil(minSpeed - extra - baseContrib));

    // idx·buffed: 결과 표에서 아티를 바로 조정할 때 어느 카드인지, 아티가 결과에 영향이 있는지(선턴 속버프 대상) 표시용
    return { name: ally.name, idx: ally.idx, buffed: getsSpeedBuff, Ti: estimatedTi, bonus, minSpeed, minRune, arti: ally.arti };
  });

  // 순서 검증 (summary)
  if (minRuneSummary.length >= 2) {
    const a2 = sortedByTurn[1], a3 = sortedByTurn[2];
    const speedOf = (a, r) => calcSpeed(a.base, r, a.swift, ldrOf(a), tot) + extraOf(a);
    const buffedByLead = a => lead1stGivesSpeedBuffSummary && (lead.sTgt === 'all' || parseInt(lead.sTgt) === a.idx);
    const b2 = minRuneSummary[0].bonus;
    let b3ord = 0;
    const getsGaugeLead = lead.gTgt === 'all' || parseInt(lead.gTgt) === a3.idx;
    if (getsGaugeLead && lead.gAmt > 0) b3ord = lead.gAmt;
    const tTick2 = minRuneSummary[0].Ti;
    const g3 = gaugeAt(speedOf(a3, minRuneSummary[1].minRune), a3.arti, buffedByLead(a3), T1, tTick2, b3ord, tr);

    // 2순위가 3순위보다 먼저 턴을 받을 때까지 뒷속을 올림
    let rune2 = minRuneSummary[0].minRune;
    while (!allyGoesFirst(gaugeAt(speedOf(a2, rune2), a2.arti, buffedByLead(a2), T1, tTick2, b2, tr), a2, g3, a3)) rune2++;
    if (rune2 !== minRuneSummary[0].minRune) {
      minRuneSummary[0].minRune = rune2;
      minRuneSummary[0].minSpeed = speedOf(a2, rune2);
    }
  }

  // 지정한 턴 순서(아군 1→2→3→상대)대로 첫 턴을 잡는지 검증
  const actualOrder = [];
  simForSummary.forEach(ev => { if (!actualOrder.includes(ev.entity.name)) actualOrder.push(ev.entity.name); });
  const expectedOrder = [...sortedByTurn.map(a => a.name), '상대 선턴잡이'];
  const orderBroken = expectedOrder.some((name, i) => actualOrder[i] !== name);

  // 시뮬레이션
  const events = simulate(allies, enemySpd, tr, 30);

  // 타임라인
  const timeline = events.map(ev => ({
    tick: ev.tick,
    name: ev.entity.name,
    isAlly: ev.entity.isAlly,
    gaugeAfter: parseFloat(ev.gaugeAfter.toFixed(1)),
    effects: ev.effects,
  }));

  // 스탯 테이블
  const statTable = [
    { isAlly: false, name: '선턴잡이', speed: enemySpd, trPct: (enemySpd*tr).toFixed(2), firstTick: Math.ceil(100/(enemySpd*tr)), speedBuff: null },
    ...allies.map(m => ({
      isAlly: true,
      name: m.name,
      speed: m.speed,
      trPct: (m.speed*tr).toFixed(2),
      firstTick: Math.ceil(100/(m.speed*tr)),
      speedBuff: m.speedBuff,
    }))
  ];

  // 중턴 분석
  const allyTurnTicks = {};
  events.forEach(ev => {
    if (ev.entity.isAlly && !(ev.entity.name in allyTurnTicks)) {
      allyTurnTicks[ev.entity.name] = ev.tick;
    }
  });

  const analysis = allies.map(ally => {
    const getBonusAt = (targetTick) => {
      let bonus = 0;
      allies.forEach(other => {
        if (other.idx === ally.idx) return;
        const tgtMatch = other.gTgt === 'all' || parseInt(other.gTgt) === ally.idx;
        if (tgtMatch && other.gAmt > 0) {
          const giverTick = allyTurnTicks[other.name];
          if (giverTick && giverTick < targetTick) bonus += other.gAmt;
        }
      });
      return bonus;
    };

    const ticks = [];
    for (let T = 1; T <= 10; T++) {
      const bonus = getBonusAt(T);
      const res = minRuneAnalysis(ally, bonus, enemySpd, T, tr, ldrOf(ally), tot);
      ticks.push({ T, bonus, ...res, currentSpeed: ally.speed });
    }
    return { name: ally.name, ticks };
  });

  // 업데이트된 몬스터 정보
  const updatedMonsters = allies.map(m => ({
    idx: m.idx, name: m.name, speed: m.speed, rune: m.rune, speedBuff: m.speedBuff
  }));

  return {
    warning: null,
    orderBroken,
    actualOrder: actualOrder.slice(0, expectedOrder.length),
    enemySpd,
    minRuneSummary,
    statTable,
    timeline,
    analysis,
    updatedMonsters,
    leadName: lead.name,
    T1,
    tr,
  };
}

// ─── API ──────────────────────────────────────────────────────

// 계산 요청 검증. 문제가 있으면 사용자에게 보여줄 메시지를 반환
function validateCalcRequest(body) {
  const { monsters, enemySpec, useEnemySpec } = body || {};
  if (!Array.isArray(monsters) || monsters.length !== 3) return '몬스터 3마리 정보가 필요합니다.';
  const turns = monsters.map(m => m.turn).sort();
  if (turns.join() !== '1,2,3') return '턴 순서는 1·2·3순위가 하나씩 있어야 합니다.';
  for (const m of monsters) {
    if (!(m.base > 0)) return `${m.name}: 기본공속을 입력해 주세요.`;
    if (!(m.rune >= 0)) return `${m.name}: 뒷속은 0 이상이어야 합니다.`;
  }
  if (useEnemySpec && enemySpec) {
    const ok = enemySpec.direct ? enemySpec.speed > 0 : enemySpec.base > 0;
    if (!ok) return '상대 선턴잡이 공속을 입력해 주세요.';
  }
  return null;
}

// 계산 API
app.post('/api/calculate', calcLimit, (req, res) => {
  const invalid = validateCalcRequest(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const result = runCalculation(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 공속계산표: 1순위 뒷속을 바꿔가며 2·3순위 필요 뒷속을 한 번에 계산
app.post('/api/speed-table', tableLimit, (req, res) => {
  const invalid = validateCalcRequest(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const { monsters, range = 10 } = req.body;
    const lead = monsters.find(m => m.turn === 1);
    const span = Math.min(Math.max(+range || 10, 1), 30);

    const rows = [];
    for (let rune = Math.max(0, lead.rune - span); rune <= lead.rune + span; rune++) {
      const ms = monsters.map(m => (m.idx === lead.idx ? { ...m, rune } : { ...m }));
      const r = runCalculation({ ...req.body, monsters: ms });
      if (r.warning) {
        rows.push({ leadRune: rune, warning: r.warning });
        continue;
      }
      rows.push({
        leadRune: rune,
        leadSpeed: r.statTable.find(s => s.isAlly && s.name === r.leadName).speed,
        T1: r.T1,
        others: r.minRuneSummary.map(s => ({ name: s.name, minRune: s.minRune })),
        orderBroken: r.orderBroken,
      });
    }
    res.json({ leadName: lead.name, currentRune: lead.rune, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 전체 기록 조회
app.get('/api/records', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM deck_records ORDER BY created_at DESC LIMIT 100'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 기록 저장
app.post('/api/records', async (req, res) => {
  const { label, mode, leader_pct, totem_pct, enemy_speed, monsters, min_runes, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO deck_records (label, mode, leader_pct, totem_pct, enemy_speed, monsters, min_runes, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [label, mode, leader_pct, totem_pct, enemy_speed,
       JSON.stringify(monsters), JSON.stringify(min_runes), notes]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 기록 삭제
app.delete('/api/records/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM deck_records WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 데미지 계산 (통합) ─────────────────────────────────────────
// 공식·몬스터 수치를 화면 코드에 두지 않으려고 서버에서 계산하고 결과 숫자만 돌려줌
// 점령전 소환사 레벨 보너스: 공격 +61%(41+20), 체력·방어 +40%(20+20), 치명피해 +50(25+25)
const SIEGE = { atk: 1.61, hpDef: 1.4, cdmg: 50 };
const SKILL_UP = 0.25;  // 스킬 레벨업 피해 증가

// 몬스터 정의. coef: fixed(고정 계수) | spd(버프 후 공속 비례 (공속 + add) / div)
// ignoreDef: 상대 방어 무시 / critRed: 피치명피해 감소 반영 / reqSpd: 선턴잡이 기준 요구 뒷속 / buffCompare: 공격강화 버프 O·X 비교
// defaults: 화면 입력 기본값 (공개돼도 되는 값만)
const DMG_MONSTERS = {
  mulciri: {
    name: '물시리', element: '물', base: { hp: 9885, atk: 900, def: 582, spd: 106 },
    coef: { type: 'fixed', value: 4.7 }, ignoreDef: true, critRed: true, reqSpd: true, buffCompare: true,
    defaults: { hp: 8874, atk: 2000, def: 296, spd: 215, cdmg: 150, 'a-hp': 0.3, 'a-atk': 0, 'a-def': 0, 'a-spd': 0, 'a-cdmg': 35,
                'a-atkbuff': 8, 'a-spdbuff': 0, 'a-ele': 18, will: 0, leader: 28, 'ac-base': 115, 'ac-gear': 237, 'ac-g': 15,
                dmgred: 23, cdmgred: 15 },
  },
  mulmuhee: {
    name: '물무희', element: '물', base: { hp: 11205, atk: 670, def: 560, spd: 101 },
    coef: { type: 'spd', add: 66, div: 99 }, ignoreDef: false, critRed: false, reqSpd: false, buffCompare: false,
    defaults: { hp: 9844, atk: 1562, def: 284, spd: 200, cdmg: 187, 'a-hp': 0, 'a-atk': 7, 'a-def': 0, 'a-spd': 0, 'a-cdmg': 39,
                'a-atkbuff': 0, 'a-spdbuff': 0, 'a-ele': 20, will: 1, leader: 28, dmgred: 0, 'def-base': 461, 'def-stat': 508 },
  },
};
const DMG_FIELDS = ['hp', 'atk', 'def', 'spd', 'cdmg', 'a-hp', 'a-atk', 'a-def', 'a-spd', 'a-cdmg', 'a-atkbuff', 'a-spdbuff', 'a-ele',
                    'will', 'dmgred', 'cdmgred', 'def-base', 'def-stat', 'leader', 'ac-base', 'ac-gear', 'ac-g'];
function dmgInputs(body) {
  const v = {};
  DMG_FIELDS.forEach(k => { const n = parseFloat((body || {})[k]); v[k] = Number.isFinite(n) ? n : 0; });
  return v;
}

// 토템 15% + 속리더 % (28처럼 넣어도, 0.28처럼 넣어도 같은 값)
function leaderTotem(v) {
  const leaderPct = v['leader'];
  return 0.15 + (leaderPct > 1 ? leaderPct/100 : leaderPct);
}

// 선턴잡이(상대)가 첫 턴에 게이지를 올린 뒤에도 이 몬스터가 먼저 움직이기 위한 최소 룬 공속
function calcReqSpd(m, v) {
  const acBase = v['ac-base'], acGear = v['ac-gear'], G = v['ac-g'], aSpdBuff = v['a-spdbuff'];
  const leaderFinal = leaderTotem(v);
  const enh = aSpdBuff > 1 ? aSpdBuff/100 : aSpdBuff;
  const ac_final = Math.ceil(acBase*(1+leaderFinal)) + acGear;
  const T = Math.floor(100/(ac_final*0.07)) + 1;
  const buffMul = 1 + 0.3*(1+enh);
  const x = (ac_final*(T+1) - G/0.07) / (T + buffMul);
  const sbMinFinal = Math.max(0, Math.floor(x)+1);
  const b_base = Math.ceil(m.base.spd*(1+leaderFinal));
  return Math.max(0, sbMinFinal - b_base);
}

// 기대 데미지 = 스킬 딜 × (1 + 속성 주는 피해 증가 − 속성 피해 감소) × 방어 항 + 아티 딜
// 속성 증감·상대 방어·치명은 스킬 딜에만 적용, 아티 딜은 그대로 더함
function calcDamage(m, v) {
  // 최종 스탯 (기본 × 소환사 레벨 보너스 + 룬)
  const dHp   = m.base.hp * SIEGE.hpDef + v['hp'];
  const dAtk  = m.base.atk * SIEGE.atk + v['atk'] + m.base.atk * 0.08 * v['will'];  // 투지 세트당 기본 공격 8%
  const dDef  = m.base.def * SIEGE.hpDef + v['def'];
  const dSpd  = Math.ceil(m.base.spd * (1 + leaderTotem(v))) + v['spd'] - 1;
  const dCdmg = v['cdmg'] + v['a-cdmg'] + SIEGE.cdmg;

  // 버프 후 (공격강화 50%, 속버프 30%를 아티 강화% 만큼 키움)
  const eAtk = dAtk * (1 + 0.5 * (1 + v['a-atkbuff'] * 0.01));
  const eSpd = dSpd * (1 + 0.3 * (1 + v['a-spdbuff'] * 0.01));

  const coef = m.coef.type === 'fixed' ? m.coef.value : (eSpd + m.coef.add) / m.coef.div;
  const critMul = 1 + SKILL_UP + dCdmg * 0.01 - (m.critRed ? v['cdmgred'] * 0.01 : 0);
  const defTerm = m.ignoreDef ? 1000 / 1140 : 1000 / ((v['def-base'] * 1.4 + v['def-stat']) * 3.55 + 1140);
  const eleMul = 1 + v['a-ele'] * 0.01 - v['dmgred'] * 0.01;

  const skillOf = atk => atk * critMul * coef;
  const artiOf  = atk => (dHp * v['a-hp'] + atk * v['a-atk'] + dDef * v['a-def'] + eSpd * v['a-spd']) * 0.01;
  const expectOf = atk => skillOf(atk) * eleMul * defTerm + artiOf(atk);

  return {
    expectOn: expectOf(eAtk), expectOff: expectOf(dAtk), skill: skillOf(eAtk), arti: artiOf(eAtk), coef, spdBuff: eSpd,
    reqSpd: m.reqSpd ? calcReqSpd(m, v) : null,
    d: { hp: dHp, atk: dAtk, def: dDef, spd: dSpd, cdmg: dCdmg },
    e: { hp: dHp, atk: eAtk, def: dDef, spd: eSpd, cdmg: dCdmg },
  };
}

// 화면에 필요한 정보만 공개 (기본 스탯·계수는 비공개)
app.get('/api/dmg-monsters', (req, res) => {
  res.json(Object.entries(DMG_MONSTERS).map(([key, m]) => ({
    key, name: m.name, element: m.element, defaults: m.defaults,
    show: { def: !m.ignoreDef, critRed: m.critRed, reqSpd: m.reqSpd, buffCompare: m.buffCompare },
  })));
});

app.post('/api/dmg/:kind', dmgLimit, (req, res) => {
  const m = Object.hasOwn(DMG_MONSTERS, req.params.kind) ? DMG_MONSTERS[req.params.kind] : null;
  if (!m) return res.status(404).json({ error: '없는 몬스터입니다.' });
  res.json(calcDamage(m, dmgInputs(req.body)));
});

// ─── 즐겨찾기 저장 코드 ─────────────────────────────────────────
// 로그인 없이 코드 하나로 다른 기기·브라우저에서 즐겨찾기를 불러옴. 코드를 아는 사람만 읽고 고칠 수 있음
// 헷갈리는 0/O, 1/I 제외 32자 × 10자리 ≈ 50비트라 추측으로 맞히기 어려움
const FAV_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FAV_MAX = 100;

function newFavCode() {
  const s = [...crypto.randomBytes(10)].map(b => FAV_CODE_CHARS[b & 31]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

// 소문자·공백·하이픈 빠짐을 허용하고 'ABCDE-FGHJK' 형식으로 맞춤
function normFavCode(code) {
  const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NP-Z2-9]{10}$/.test(s) ? `${s.slice(0, 5)}-${s.slice(5)}` : null;
}

// index.html의 sanitizeFav와 같은 형식으로 정리 (카드 3장, 값은 40자 이하 문자열, 체크박스는 true/false)
const FAV_CARD_FIELDS = ['turn', 'nm', 'bs', 'rn', 'ex', 'at', 'ga', 'gt', 'st'];
const FAV_CARD_FLAGS = ['sw', 'nl'];
function normFavs(favs) {
  if (!Array.isArray(favs) || favs.length > FAV_MAX) return null;
  const str = v => String(v ?? '').slice(0, 40);
  const out = [];
  for (const f of favs) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.cards) || f.cards.length !== 3) return null;
    out.push({
      mode: f.mode === 'arena' ? 'arena' : 'siege',
      leader: str(f.leader), totem: str(f.totem),
      cards: f.cards.map(c => {
        const card = {};
        FAV_CARD_FIELDS.forEach(k => { card[k] = str(c && c[k]); });
        FAV_CARD_FLAGS.forEach(k => { card[k] = !!(c && c[k]); });
        return card;
      }),
      label: str(f.label) || '이름 없는 덱',
    });
  }
  return out;
}

const HOUR = 60 * 60 * 1000;
const favReadLimit   = rateLimit('fav-read', 60, 10 * 60 * 1000);  // 조회: 10분에 60번
const favWriteLimit  = rateLimit('fav-write', 300, HOUR);           // 갱신: 1시간에 300번
const favCreateLimit = rateLimit('fav-create', 10, HOUR);           // 새 코드 발급: 1시간에 10번

app.get('/api/favorites/:code', favReadLimit, async (req, res) => {
  const code = normFavCode(req.params.code);
  if (!code) return res.status(400).json({ error: '저장 코드 형식이 올바르지 않습니다.' });
  try {
    const { rows } = await pool.query('SELECT favs FROM fav_sync WHERE code=$1', [code]);
    if (!rows.length) return res.status(404).json({ error: '해당 저장 코드가 없습니다.' });
    res.json({ code, favs: rows[0].favs });
  } catch (e) {
    console.error('GET /api/favorites failed:', e);
    res.status(500).json({ error: '서버 오류로 불러오지 못했습니다.' });
  }
});

// code가 있으면 그 코드의 즐겨찾기를 덮어쓰고, 없으면 새 코드를 발급
app.post('/api/favorites', favWriteLimit, (req, res, next) => {
  // 새 코드 발급은 더 엄격하게 제한
  if (req.body && req.body.code) return next();
  favCreateLimit(req, res, next);
}, async (req, res) => {
  const { code: rawCode } = req.body || {};
  const favs = normFavs((req.body || {}).favs);
  if (!favs) return res.status(400).json({ error: `즐겨찾기 형식이 올바르지 않습니다. (최대 ${FAV_MAX}개)` });
  try {
    if (rawCode) {
      const code = normFavCode(rawCode);
      if (!code) return res.status(400).json({ error: '저장 코드 형식이 올바르지 않습니다.' });
      const { rowCount } = await pool.query(
        'UPDATE fav_sync SET favs=$2, updated_at=NOW() WHERE code=$1', [code, JSON.stringify(favs)]);
      if (!rowCount) return res.status(404).json({ error: '해당 저장 코드가 없습니다.' });
      return res.json({ code });
    }
    for (let i = 0; i < 3; i++) {
      const code = newFavCode();
      const { rowCount } = await pool.query(
        'INSERT INTO fav_sync (code, favs) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, JSON.stringify(favs)]);
      if (rowCount) return res.json({ code });
    }
    res.status(500).json({ error: '저장 코드를 만들지 못했습니다. 다시 시도해 주세요.' });
  } catch (e) {
    console.error('POST /api/favorites failed:', e);
    res.status(500).json({ error: '서버 오류로 저장하지 못했습니다.' });
  }
});

// ─── 시작 ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
