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

// ─── API ──────────────────────────────────────────────────────

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
