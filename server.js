/**
 * Анна & Михаил — RSVP backend (zero-dependency, Node.js built-in only).
 * - Раздаёт статику (index.html, styles.css, script.js, img/)
 * - POST /api/rsvp: валидация, rate-limit, сохранение, уведомления
 *
 * Хранение:
 *   1) всегда — data/rsvp.json (локальный файл, учебный режим);
 *   2) если заданы SUPABASE_URL + SUPABASE_SERVICE_KEY — дублирует в Supabase (таблица rsvp).
 * Уведомления (best-effort, не блокируют ответ):
 *   - Telegram, если заданы TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   - иначе — лог в консоль (и RSVP_NOTIFICATION_EMAIL как пометка получателя)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'rsvp.json');

// Чистим URL: убираем пробелы, хвосты вида /rest/v1 и слэши в конце.
function normalizeSupabaseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  const i = s.toLowerCase().indexOf('/rest/');
  if (i !== -1) s = s.slice(0, i).replace(/\/+$/, '');
  return s;
}

const ENV = {
  supabaseUrl: normalizeSupabaseUrl(process.env.SUPABASE_URL),
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || '',
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  notifyEmail: process.env.RSVP_NOTIFICATION_EMAIL || '',
  // Пароль для просмотра заявок на /admin.html. ОБЯЗАТЕЛЬНО задайте свой в .env при публикации!
  adminSecret: process.env.ADMIN_SECRET || 'anna-mikhail-2026'
};

// ---------- rate limit: 10 запросов / 10 минут с одного IP ----------
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 10) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// ---------- helpers ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function saveLocal(entry) {
  ensureDataFile();
  const arr = readLocal();
  arr.push(entry);
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
  return arr.length;
}

function readLocal() {
  ensureDataFile();
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function formatDateRU(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function notifyOrganizers(entry) {
  const answer = entry.attendance === 'yes' ? 'Буду с радостью ❤️' : 'К сожалению, не смогу';
  const text =
    `Новое подтверждение на свадьбу\n` +
    `Имя: ${entry.name}\n` +
    `Ответ: ${answer}\n` +
    `Количество гостей: ${entry.guests}\n` +
    `Пожелания по меню: ${entry.menu_comment || '—'}\n` +
    `Дата отправки: ${formatDateRU(new Date(entry.created_at))}`;

  if (ENV.notifyEmail) console.log(`[notify] получатель e-mail: ${ENV.notifyEmail}`);
  console.log('[notify]\n' + text);

  if (ENV.tgToken && ENV.tgChat) {
    try {
      const url = `https://api.telegram.org/bot${ENV.tgToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ENV.tgChat, text })
      });
    } catch (e) {
      console.error('[notify] telegram error:', e.message);
    }
  }
}

async function saveToSupabase(entry) {
  if (!ENV.supabaseUrl || !ENV.supabaseKey) return false;
  try {
    const res = await fetch(`${ENV.supabaseUrl.replace(/\/$/, '')}/rest/v1/rsvp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ENV.supabaseKey,
        Authorization: `Bearer ${ENV.supabaseKey}`,
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        name: entry.name,
        attendance: entry.attendance,
        guests: entry.guests,
        menu_comment: entry.menu_comment
      })
    });
    if (!res.ok) console.error('[supabase] error:', res.status, await res.text());
    return res.ok;
  } catch (e) {
    console.error('[supabase] fetch error:', e.message);
    return false;
  }
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Запрет выхода за пределы ROOT
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString();

  if (req.method === 'GET' && req.url.split('?')[0] === '/api/rsvp') {
    const key = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
    if (key !== ENV.adminSecret) {
      return send(res, 403, { success: false, message: 'Нет доступа. Укажите верный ключ.' });
    }
    const items = readLocal()
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(({ ip, ...rest }) => rest); // IP не отдаём наружу
    const yes = items.filter((i) => i.attendance === 'yes');
    return send(res, 200, {
      success: true,
      total: items.length,
      yesCount: yes.length,
      noCount: items.length - yes.length,
      guestsTotal: yes.reduce((s, i) => s + (Number(i.guests) || 0), 0),
      items
    });
  }

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/rsvp') {
    if (rateLimited(ip)) {
      return send(res, 429, { success: false, message: 'Слишком много попыток. Попробуйте позже.' });
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch (_) {
      return send(res, 400, { success: false, message: 'Пожалуйста, заполните обязательные поля' });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return send(res, 400, { success: false, message: 'Пожалуйста, заполните обязательные поля' });
    }

    // Серверная валидация
    const name = typeof data.name === 'string' ? data.name.trim().slice(0, 100) : '';
    const attendance = data.attendance;
    const guests = Number(data.guests);
    const menuComment = typeof data.menuComment === 'string' ? data.menuComment.trim().slice(0, 500) : '';

    if (
      name.length < 2 ||
      (attendance !== 'yes' && attendance !== 'no') ||
      !Number.isInteger(guests) || guests < 1 || guests > 4
    ) {
      return send(res, 400, { success: false, message: 'Пожалуйста, заполните обязательные поля' });
    }

    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      attendance,
      guests,
      menu_comment: menuComment,
      created_at: new Date().toISOString(),
      ip
    };

    try {
      saveLocal(entry);
      saveToSupabase(entry).catch(() => {});
      notifyOrganizers(entry).catch(() => {});
      return send(res, 200, { success: true, message: 'RSVP успешно сохранён' });
    } catch (e) {
      console.error('[rsvp] save error:', e.message);
      return send(res, 500, { success: false, message: 'Не удалось отправить ответ. Попробуйте ещё раз.' });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: false, message: 'Метод не поддерживается' }));
});

server.listen(PORT, () => {
  console.log(`💍 Анна & Михаил — сервер запущен: http://localhost:${PORT}`);
  console.log(`   RSVP хранится в: ${DATA_FILE}`);
  if (ENV.supabaseUrl) console.log('   Supabase: включён');
  else console.log('   Supabase: не настроен (используется локальный файл). См. .env.example');
  if (!process.env.ADMIN_SECRET) {
    console.log('   ⚠ ADMIN_SECRET не задан — для /admin.html действует пароль по умолчанию: anna-mikhail-2026');
    console.log('     Перед публикацией задайте свой пароль в переменной окружения ADMIN_SECRET!');
  }
});
