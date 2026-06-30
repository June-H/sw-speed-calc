const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

app.use(express.json());

// ─── 라우트 (static 파일보다 먼저 정의) ────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/test', (req, res) => res.sendFile(path.join(__dirname, 'test.html')));
app.get('/index', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/mulciri', (req, res) => res.sendFile(path.join(__dirname, 'mulciri.html')));
app.get('/mulmuhee', (req, res) => res.sendFile(path.join(__dirname, 'mulmuhee.html')));

app.use(express.static(path.join(__dirname)));

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
  console.log('DB initialized');
}

// ─── 계산 로직 ──────────────────────────────────────────────────────

const TICK_RATE = { siege: 0.07, arena: 0.015 };

const PRESETS_EXTRA = {
  '물호박': 39.5,
  '암헬하': 25,
};

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

  for (let tick = 1; tick <= maxTicks; tick++) {
    for (let i = 0; i < entities.length; i++) gauges[i] += entities[i].curSpd * tickRate;

    let best = -1, bestG = 99.9999;
    for (let i = 0; i < entities.length; i++) {
      if (gauges[i] < 100) continue;
      if (gauges[i] > bestG + 1e-6 ||
          (Math.abs(gauges[i] - bestG) < 1e-6 && entities[i].isAlly && (best < 0 || !entities[best].isAlly))) {
        best = i; bestG = gauges[i];
      }
    }
    if (best < 0) continue;

    const e = entities[best];
    gauges[best] -= 100;
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

function minRuneAnalysis(ally, totalBonus, enemySpd, targetTick, tickRate, ldr, tot) {
  const tr = tickRate;
  const needFromGauge = (enemySpd * tr * targetTick - totalBonus) / (tr * targetTick);
  const needFor100 = (100 - totalBonus) / (tr * targetTick);
  const needSpeed = Math.max(needFromGauge, needFor100);
  if (needSpeed <= 0) return { minSpeed: 0, minRune: 0, free: true };

  const mult = 1 + ldr/100 + tot/100;
  const swRaw = ally.swift ? ally.base * 0.25 : 0;
  const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
  const baseContrib = ally.base * mult + swRaw - swCeil;
  const minRune = Math.max(0, Math.ceil(needSpeed - baseContrib));
  const achievedSpeed = calcSpeed(ally.base, minRune, ally.swift, ldr, tot);

  return { minSpeed: Math.ceil(needSpeed), minRune, achievedSpeed };
}

function runCalculation({ mode, ldr, tot, useEnemySpec, enemySpec, monsters }) {
  const tr = TICK_RATE[mode] || TICK_RATE.siege;

  // 몬스터 speed 계산
  const allies = monsters.map(m => {
    let speed = calcSpeed(m.base, m.rune, m.swift, ldr, tot);
    if (PRESETS_EXTRA[m.name]) speed += PRESETS_EXTRA[m.name];
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
  const lead1stGivesSpeedBuff = first.sTgt === 'all';
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

    const mult = 1 + ldr/100 + tot/100;
    const swRaw = ally.swift ? ally.base * 0.25 : 0;
    const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
    const baseContrib = ally.base * mult + swRaw - swCeil;
    const needRune = Math.max(0, Math.ceil(needSpeed - baseContrib));

    ally.rune = needRune;
    ally.speed = calcSpeed(ally.base, needRune, ally.swift, ldr, tot);
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
    const gauge2 = ally2.speed * targetTick2 * tr + bonus2;
    const gauge3 = ally3.speed * targetTick2 * tr + bonus3ForOrdering;

    if (gauge2 <= gauge3) {
      const requiredSpeed = Math.floor((ally3.speed * targetTick2 * tr + bonus3ForOrdering - bonus2) / (targetTick2 * tr)) + 1;
      const mult2 = 1 + ldr/100 + tot/100;
      const swRaw2 = ally2.swift ? ally2.base * 0.25 : 0;
      const swCeil2 = ally2.swift ? Math.ceil(swRaw2) : 0;
      const baseContrib2 = ally2.base * mult2 + swRaw2 - swCeil2;
      const fixedRune = Math.max(0, Math.ceil(requiredSpeed - baseContrib2));
      ally2.rune = fixedRune;
      ally2.speed = calcSpeed(ally2.base, fixedRune, ally2.swift, ldr, tot);
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
  const lead1stGivesSpeedBuffSummary = lead.sTgt === 'all';

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

    const mult = 1 + ldr/100 + tot/100;
    const swRaw = ally.swift ? ally.base * 0.25 : 0;
    const swCeil = ally.swift ? Math.ceil(swRaw) : 0;
    const baseContrib = ally.base * mult + swRaw - swCeil;
    let minRune = Math.max(0, Math.ceil(minSpeed - baseContrib));

    return { name: ally.name, Ti: estimatedTi, bonus, minSpeed, minRune, arti: ally.arti };
  });

  // 순서 검증 (summary)
  if (minRuneSummary.length >= 2) {
    const mult = 1 + ldr/100 + tot/100;
    const a2 = sortedByTurn[1], a3 = sortedByTurn[2];
    const s2 = calcSpeed(a2.base, minRuneSummary[0].minRune, a2.swift, ldr, tot);
    const s3 = calcSpeed(a3.base, minRuneSummary[1].minRune, a3.swift, ldr, tot);
    const b2 = minRuneSummary[0].bonus;
    let b3ord = 0;
    const getsGaugeLead = lead.gTgt === 'all' || parseInt(lead.gTgt) === a3.idx;
    if (getsGaugeLead && lead.gAmt > 0) b3ord = lead.gAmt;
    const tTick2 = minRuneSummary[0].Ti;
    const g2 = s2 * tTick2 * tr + b2;
    const g3 = s3 * tTick2 * tr + b3ord;
    if (g2 <= g3) {
      const reqSpd = Math.floor((s3 * tTick2 * tr + b3ord - b2) / (tTick2 * tr)) + 1;
      const swRaw2 = a2.swift ? a2.base * 0.25 : 0;
      const swCeil2 = a2.swift ? Math.ceil(swRaw2) : 0;
      const bc2 = a2.base * mult + swRaw2 - swCeil2;
      minRuneSummary[0].minRune = Math.max(0, Math.ceil(reqSpd - bc2));
      minRuneSummary[0].minSpeed = reqSpd;
    }
  }

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
      const res = minRuneAnalysis(ally, bonus, enemySpd, T, tr, ldr, tot);
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

// 계산 API
app.post('/api/calculate', (req, res) => {
  try {
    const result = runCalculation(req.body);
    res.json(result);
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

// ─── 시작 ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
