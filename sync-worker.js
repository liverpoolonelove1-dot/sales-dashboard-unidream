// Cloudflare Worker: серверная синхронизация сделок Bitrix24 для дашборда (pulsecrm-sync).
//
// ЗАЧЕМ: дашборд работает в браузере и берёт сделки прямо у Bitrix24. Bitrix24 отдаёт максимум
// 50 сделок за страницу и ~2 запроса в секунду, агрегатов (сумм по стадиям/менеджерам) не умеет.
// У клиента с 200к сделок первая загрузка = ~4000 страниц — это минуты, быстрее Bitrix24 не даст.
// Этот воркер делает выгрузку ОДИН РАЗ на сервере в фоне и дальше каждые 5 минут докачивает только
// изменённые сделки (DATE_MODIFY). Дашборд при открытии берёт готовую базу у воркера одним-двумя
// запросами — быстро с первого же открытия, у любого пользователя, на любом устройстве.
//
// КАК УСТРОЕНО:
//   POST /register {webhook, extraFields[]}  — дашборд регистрирует портал (идемпотентно)
//   GET  /status   (заголовок X-Webhook)      — готова ли база портала
//   GET  /deals    (заголовок X-Webhook)      — сделки из базы: ?category=&from=&to=&won=1&after=
//   cron каждые 5 минут                        — первичная выгрузка / докачка изменений /
//                                                раз в сутки полная сверка (удаляет удалённые в CRM)
// Доступ к данным портала — только по его вебхуку (как и в самом Bitrix24): ключ портала —
// SHA-256 от вебхука, без вебхука данные не отдаются.
//
// КАК РАЗВЕРНУТЬ — см. sync-worker-README.md рядом с этим файлом.

const PAGE = 50;                    // размер страницы list-методов Bitrix24
const CHAIN = 50;                   // страниц в одном batch-запросе (лимит Bitrix24)
const RUN_BATCH_BUDGET = 30;        // batch-запросов на портал за один запуск cron (≈75к сделок)
const FULL_RESCAN_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS_PER_RESPONSE = 20000;
const BASE_FIELDS = ['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CATEGORY_ID','OPPORTUNITY','CURRENCY_ID','CLOSED',
  'DATE_CREATE','CLOSEDATE','DATE_MODIFY','ASSIGNED_BY_ID','SOURCE_ID','CONTACT_ID'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Webhook',
  'Access-Control-Max-Age': '86400'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {...CORS, 'Content-Type': 'application/json'}});

export default {
  async fetch(request, env, ctx){
    if(request.method === 'OPTIONS') return new Response(null, {headers: CORS});
    const url = new URL(request.url);
    try{
      if(url.pathname === '/register' && request.method === 'POST') return await handleRegister(request, env, ctx);
      if(url.pathname === '/status') return await handleStatus(request, env);
      if(url.pathname === '/deals') return await handleDeals(request, env, url);
      return json({error: 'not found'}, 404);
    }catch(e){
      return json({error: String(e && e.message || e)}, 500);
    }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil(syncAll(env));
  }
};

// ─── HTTP ────────────────────────────────────────────────────────────────────

function normalizeWebhook(w){
  w = String(w || '').trim();
  if(!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(w)) return null;
  return w.endsWith('/') ? w : w + '/';
}

async function portalKey(webhook){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(webhook));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function portalFromHeader(request, env){
  const webhook = normalizeWebhook(request.headers.get('X-Webhook'));
  if(!webhook) return null;
  return env.DB.prepare('SELECT * FROM portals WHERE key = ?').bind(await portalKey(webhook)).first();
}

async function handleRegister(request, env, ctx){
  const body = await request.json().catch(() => ({}));
  const webhook = normalizeWebhook(body.webhook);
  if(!webhook) return json({error: 'bad webhook'}, 400);
  const extra = (Array.isArray(body.extraFields) ? body.extraFields : [])
    .filter(f => /^UF_[A-Z0-9_]+$/.test(f)).slice(0, 5);
  const key = await portalKey(webhook);
  const existing = await env.DB.prepare('SELECT key, extra FROM portals WHERE key = ?').bind(key).first();
  if(existing){
    // новые кастомные поля — нужна полная пересинхронизация, чтобы они были у всех сделок
    const had = JSON.parse(existing.extra || '[]');
    if(extra.some(f => !had.includes(f))){
      await env.DB.prepare("UPDATE portals SET extra = ?, phase = 'rescan', cursor = 0, scan_stamp = ? WHERE key = ?")
        .bind(JSON.stringify([...new Set([...had, ...extra])]), Date.now(), key).run();
    }
    return json({ok: true, registered: false});
  }
  // Проверяем вебхук прежде чем хранить: он должен реально отвечать на crm.deal.list
  const probe = await bx(webhook, 'crm.deal.list', {select: ['ID'], start: -1});
  if(probe.error) return json({error: 'webhook check failed: ' + probe.error}, 400);
  await env.DB.prepare(`INSERT INTO portals (key, webhook, extra, phase, cursor, scan_stamp, full_done, last_modified, last_full_at, updated_at, error)
    VALUES (?, ?, ?, 'initial', 0, ?, 0, NULL, 0, 0, NULL)`).bind(key, webhook, JSON.stringify(extra), Date.now()).run();
  // первая порция выгрузки — сразу, не дожидаясь cron
  ctx.waitUntil(syncPortal(env, key).catch(() => {}));
  return json({ok: true, registered: true});
}

async function handleStatus(request, env){
  const p = await portalFromHeader(request, env);
  if(!p) return json({registered: false});
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM deals WHERE portal = ?').bind(p.key).first();
  return json({registered: true, ready: !!p.full_done, phase: p.phase, deals: count ? count.n : 0,
    lastModified: p.last_modified, updatedAt: p.updated_at, error: p.error});
}

async function handleDeals(request, env, url){
  const p = await portalFromHeader(request, env);
  if(!p) return json({error: 'not registered'}, 404);
  if(!p.full_done) return json({ready: false}, 409);
  const where = ['portal = ?'];
  const args = [p.key];
  const category = url.searchParams.get('category');
  if(category !== null && category !== ''){ where.push('category = ?'); args.push(parseInt(category, 10) || 0); }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if(from){ where.push('created_day >= ?'); args.push(from.slice(0, 10)); }
  if(to){ where.push('created_day <= ?'); args.push(to.slice(0, 10)); }
  if(url.searchParams.get('won') === '1') where.push("sem = 'S'");
  const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
  where.push('id > ?'); args.push(after);
  const {results} = await env.DB.prepare(
    `SELECT id, title, stage, sem, category, opp, cur, closed, created, closedate, modified, assigned, source, contact, extra
     FROM deals WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${MAX_ROWS_PER_RESPONSE}`).bind(...args).all();
  // Отдаём компактно: массив колонок + массив строк (в 2-3 раза меньше JSON, чем объекты)
  const cols = ['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CATEGORY_ID','OPPORTUNITY','CURRENCY_ID','CLOSED',
    'DATE_CREATE','CLOSEDATE','DATE_MODIFY','ASSIGNED_BY_ID','SOURCE_ID','CONTACT_ID','EXTRA'];
  const rows = results.map(r => [String(r.id), r.title, r.stage, r.sem, String(r.category), String(r.opp ?? ''), r.cur, r.closed,
    r.created, r.closedate, r.modified, r.assigned, r.source, r.contact, r.extra]);
  const next = results.length === MAX_ROWS_PER_RESPONSE ? results[results.length - 1].id : null;
  return json({ready: true, cols, rows, next, lastModified: p.last_modified});
}

// ─── Синхронизация ───────────────────────────────────────────────────────────

async function syncAll(env){
  const {results} = await env.DB.prepare('SELECT key FROM portals ORDER BY updated_at ASC').all();
  for(const p of results){
    try{ await syncPortal(env, p.key); }
    catch(e){
      await env.DB.prepare('UPDATE portals SET error = ?, updated_at = ? WHERE key = ?')
        .bind(String(e && e.message || e).slice(0, 500), Date.now(), p.key).run();
    }
  }
}

async function syncPortal(env, key){
  const p = await env.DB.prepare('SELECT * FROM portals WHERE key = ?').bind(key).first();
  if(!p) return;
  const extra = JSON.parse(p.extra || '[]');
  const select = [...BASE_FIELDS, ...extra];
  let phase = p.phase;
  // Раз в сутки — полная сверка: заново проходим всю базу и удаляем сделки, которых больше нет в CRM
  if(phase === 'delta' && Date.now() - (p.last_full_at || 0) > FULL_RESCAN_MS){
    phase = 'rescan';
    await env.DB.prepare("UPDATE portals SET phase = 'rescan', cursor = 0, scan_stamp = ? WHERE key = ?").bind(Date.now(), key).run();
    p.cursor = 0; p.scan_stamp = Date.now();
  }
  if(phase === 'initial' || phase === 'rescan') await fullScan(env, p, select, phase);
  else await deltaSync(env, p, select);
}

// Полная выгрузка по возрастанию ID (keyset: start=-1 + >ID, страницы связаны в batch через $result).
// Продолжается с курсора между запусками cron — 200к сделок укладываются в несколько запусков.
async function fullScan(env, p, select, phase){
  let cursor = p.cursor || 0;
  let maxModified = p.last_modified || null;
  for(let b = 0; b < RUN_BATCH_BUDGET; b++){
    const {rows, done} = await keysetBatch(p.webhook, {}, select, cursor);
    if(rows.length){
      await upsertDeals(env, p.key, rows, p.scan_stamp, JSON.parse(p.extra || '[]'));
      cursor = parseInt(rows[rows.length - 1].ID, 10);
      maxModified = maxDate(maxModified, rows);
    }
    await env.DB.prepare('UPDATE portals SET cursor = ?, last_modified = ?, updated_at = ?, error = NULL WHERE key = ?')
      .bind(cursor, maxModified, Date.now(), p.key).run();
    if(done){
      if(phase === 'rescan'){
        await env.DB.prepare('DELETE FROM deals WHERE portal = ? AND seen < ?').bind(p.key, p.scan_stamp).run();
      }
      await env.DB.prepare("UPDATE portals SET phase = 'delta', full_done = 1, cursor = 0, last_full_at = ?, updated_at = ? WHERE key = ?")
        .bind(Date.now(), Date.now(), p.key).run();
      return;
    }
  }
}

// Докачка изменённых с прошлой синхронизации сделок (DATE_MODIFY >= последнего увиденного изменения,
// в формате и часовом поясе самого Bitrix24 — без расхождения часов сервера и портала).
async function deltaSync(env, p, select){
  if(!p.last_modified) return;
  let cursor = 0;
  let maxModified = p.last_modified;
  for(let b = 0; b < RUN_BATCH_BUDGET; b++){
    const {rows, done} = await keysetBatch(p.webhook, {'>=DATE_MODIFY': p.last_modified}, select, cursor);
    if(rows.length){
      await upsertDeals(env, p.key, rows, Date.now(), JSON.parse(p.extra || '[]'));
      cursor = parseInt(rows[rows.length - 1].ID, 10);
      maxModified = maxDate(maxModified, rows);
    }
    if(done) break;
  }
  await env.DB.prepare('UPDATE portals SET last_modified = ?, updated_at = ?, error = NULL WHERE key = ?')
    .bind(maxModified, Date.now(), p.key).run();
}

function maxDate(current, rows){
  let best = current, bestT = current ? Date.parse(current) : 0;
  for(const r of rows){
    const t = r.DATE_MODIFY ? Date.parse(r.DATE_MODIFY) : 0;
    if(t > bestT){ bestT = t; best = r.DATE_MODIFY; }
  }
  return best;
}

// Один batch-запрос: до CHAIN страниц подряд, начиная после afterId. done=true — выборка закончилась.
async function keysetBatch(webhook, extraFilter, select, afterId){
  const cmd = {};
  for(let i = 0; i < CHAIN; i++){
    const qs = new URLSearchParams();
    appendParams(qs, 'select', select);
    appendParams(qs, 'order', {ID: 'ASC'});
    appendParams(qs, 'filter', {...extraFilter, '>ID': i === 0 ? afterId : `$result[c${i - 1}][${PAGE - 1}][ID]`});
    qs.set('start', '-1');
    cmd['c' + i] = `crm.deal.list?${qs.toString()}`;
  }
  const res = await bxBatch(webhook, cmd);
  const rows = [];
  let last = afterId;
  for(let i = 0; i < CHAIN; i++){
    const key = 'c' + i;
    if(res.result_error && res.result_error[key]){
      if(i === 0) throw new Error(res.result_error[key].error_description || res.result_error[key].error || 'batch error');
      break; // хвост цепочки не разрешился — продолжим со следующего batch
    }
    const page = (res.result && res.result[key]) || [];
    if(!Array.isArray(page)) throw new Error('unexpected response');
    // Ссылка $result не подставилась (страница началась не после предыдущей) — обрываем цепочку здесь
    if(page.length && parseInt(page[0].ID, 10) <= last) break;
    rows.push(...page);
    if(page.length) last = parseInt(page[page.length - 1].ID, 10);
    if(page.length < PAGE) return {rows, done: true};
  }
  return {rows, done: false};
}

async function upsertDeals(env, key, rows, seen, extra){
  const sql = `INSERT INTO deals (portal, id, title, stage, sem, category, opp, cur, closed, created, created_day, closedate, modified, assigned, source, contact, extra, seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal, id) DO UPDATE SET title=excluded.title, stage=excluded.stage, sem=excluded.sem, category=excluded.category,
      opp=excluded.opp, cur=excluded.cur, closed=excluded.closed, created=excluded.created, created_day=excluded.created_day,
      closedate=excluded.closedate, modified=excluded.modified, assigned=excluded.assigned, source=excluded.source,
      contact=excluded.contact, extra=excluded.extra, seen=excluded.seen`;
  const stmt = env.DB.prepare(sql);
  const bound = rows.map(r => {
    const ex = {};
    extra.forEach(f => { if(r[f] !== undefined && r[f] !== null && r[f] !== '') ex[f] = r[f]; });
    return stmt.bind(key, parseInt(r.ID, 10), r.TITLE || '', r.STAGE_ID || '', r.STAGE_SEMANTIC_ID || '',
      parseInt(r.CATEGORY_ID, 10) || 0, parseFloat(r.OPPORTUNITY) || 0, r.CURRENCY_ID || '', r.CLOSED || '',
      r.DATE_CREATE || '', (r.DATE_CREATE || '').slice(0, 10), r.CLOSEDATE || '', r.DATE_MODIFY || '',
      r.ASSIGNED_BY_ID || '', r.SOURCE_ID || '', r.CONTACT_ID || '', Object.keys(ex).length ? JSON.stringify(ex) : null, seen);
  });
  for(let i = 0; i < bound.length; i += 500) await env.DB.batch(bound.slice(i, i + 500));
}

// ─── Bitrix24 ────────────────────────────────────────────────────────────────

function appendParams(qs, prefix, value){
  if(Array.isArray(value)) value.forEach(v => qs.append(`${prefix}[]`, v));
  else if(value !== null && value !== undefined && typeof value === 'object'){
    for(const k in value) appendParams(qs, `${prefix}[${k}]`, value[k]);
  } else if(value !== null && value !== undefined) qs.append(prefix, value);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bxFetch(url, init){
  for(let attempt = 0; ; attempt++){
    let res;
    try{ res = await fetch(url, init); }
    catch(e){ if(attempt < 4){ await sleep(1000 * 2 ** attempt); continue; } throw e; }
    if((res.status === 429 || res.status === 503) && attempt < 8){ await sleep(Math.min(500 * 1.7 ** attempt, 8000)); continue; }
    const data = await res.json().catch(() => ({error: `HTTP ${res.status}`}));
    if(data.error === 'QUERY_LIMIT_EXCEEDED' && attempt < 8){ await sleep(Math.min(500 * 1.7 ** attempt, 8000)); continue; }
    return data;
  }
}

async function bx(webhook, method, params){
  const qs = new URLSearchParams();
  for(const k in params) appendParams(qs, k, params[k]);
  const data = await bxFetch(`${webhook}${method}.json?${qs.toString()}`);
  return data.error ? {error: data.error_description || data.error} : data;
}

async function bxBatch(webhook, cmd){
  const body = new URLSearchParams();
  body.append('halt', '0');
  for(const k in cmd) body.append(`cmd[${k}]`, cmd[k]);
  const data = await bxFetch(`${webhook}batch.json`, {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: body.toString()
  });
  if(data.error) throw new Error(data.error_description || data.error);
  return data.result;
}
