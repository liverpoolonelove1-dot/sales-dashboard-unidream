-- Схема базы D1 для sync-worker.js (выполнить один раз в консоли D1, см. sync-worker-README.md)

CREATE TABLE IF NOT EXISTS portals (
  key           TEXT PRIMARY KEY,   -- SHA-256 от вебхука
  webhook       TEXT NOT NULL,
  extra         TEXT,               -- JSON: кастомные поля UF_* (например, причина отказа)
  phase         TEXT NOT NULL,      -- initial | rescan | delta
  cursor        INTEGER DEFAULT 0,  -- последний выгруженный ID при полной выгрузке
  scan_stamp    INTEGER,            -- метка текущей полной выгрузки (для удаления исчезнувших сделок)
  full_done     INTEGER DEFAULT 0,  -- 1 — первичная выгрузка завершена, база отдаётся дашборду
  last_modified TEXT,               -- самое позднее DATE_MODIFY среди сделок (в формате Bitrix24)
  last_full_at  INTEGER DEFAULT 0,
  updated_at    INTEGER DEFAULT 0,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS deals (
  portal      TEXT NOT NULL,
  id          INTEGER NOT NULL,
  title       TEXT,
  stage       TEXT,
  sem         TEXT,                 -- STAGE_SEMANTIC_ID: P / S / F
  category    INTEGER,
  opp         REAL,
  cur         TEXT,
  closed      TEXT,
  created     TEXT,
  created_day TEXT,                 -- YYYY-MM-DD по времени портала — для фильтра периода
  closedate   TEXT,
  modified    TEXT,
  assigned    TEXT,
  source      TEXT,
  contact     TEXT,
  extra       TEXT,
  seen        INTEGER,
  PRIMARY KEY (portal, id)
);

CREATE INDEX IF NOT EXISTS deals_period ON deals (portal, category, created_day, id);
CREATE INDEX IF NOT EXISTS deals_day ON deals (portal, created_day, id);
