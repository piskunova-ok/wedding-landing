'use strict';

/**
 * Netlify Function — backend для RSVP на статическом хостинге.
 * Путь: /.netlify/functions/rsvp
 *
 * - POST  — принять заявку (валидация + сохранение в Supabase + Telegram-уведомление)
 * - GET ?key=ADMIN_SECRET — список заявок со статистикой для /admin.html
 *
 * Хранилище — только Supabase (у serverless-функции нет локального диска).
 * Секреты задаются в Netlify Dashboard → Site settings → Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET,
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (необязательно)
 *
 * Зависимостей нет, только встроенный fetch (Node 18+).
 */

// Чистим URL: убираем пробелы, хвосты вида /rest/v1 и слэши в конце,
// чтобы работали и https://xxx.supabase.co, и полный Data API URL.
function normalizeSupabaseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  const i = s.toLowerCase().indexOf('/rest/');
  if (i !== -1) s = s.slice(0, i).replace(/\/+$/, '');
  return s;
}

const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'anna-mikhail-2026';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// Простой rate-limit в пределах одного инстанса функции: 20 запросов / 10 мин с IP
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 20) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(obj)
  };
}

function validate(data) {
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 100) : '';
  const attendance = data.attendance;
  const guests = Number(data.guests);
  const menuComment = typeof data.menuComment === 'string' ? data.menuComment.trim().slice(0, 500) : '';
  if (
    name.length < 2 ||
    (attendance !== 'yes' && attendance !== 'no') ||
    !Number.isInteger(guests) || guests < 1 || guests > 4
  ) {
    return null;
  }
  return { name, attendance, guests, menuComment };
}

function formatDateRU(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function notifyTelegram(entry) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const answer = entry.attendance === 'yes' ? 'Буду с радостью ❤️' : 'К сожалению, не смогу';
  const text =
    `Новое подтверждение на свадьбу\n` +
    `Имя: ${entry.name}\n` +
    `Ответ: ${answer}\n` +
    `Количество гостей: ${entry.guests}\n` +
    `Пожелания по меню: ${entry.menu_comment || '—'}\n` +
    `Дата отправки: ${formatDateRU(new Date(entry.created_at))}`;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
  } catch (e) {
    console.error('[rsvp] telegram error:', e.message);
  }
}

async function supabaseInsert(entry) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rsvp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      name: entry.name,
      attendance: entry.attendance,
      guests: entry.guests,
      menu_comment: entry.menu_comment
    })
  });
  if (!res.ok) throw new Error(`supabase insert: ${res.status} ${await res.text()}`);
}

async function supabaseList() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rsvp?select=id,name,attendance,guests,menu_comment,created_at&order=created_at.desc`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error(`supabase select: ${res.status} ${await res.text()}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

  const ip =
    (event.headers && (event.headers['x-forwarded-for'] || event.headers['client-ip'])) ||
    'unknown';

  // ---------- GET: список заявок для админки ----------
  if (event.httpMethod === 'GET') {
    const key = (event.queryStringParameters && event.queryStringParameters.key) || '';
    if (key !== ADMIN_SECRET) {
      return json(403, { success: false, message: 'Нет доступа. Укажите верный ключ.' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json(500, { success: false, message: 'Хранилище не настроено (SUPABASE_URL / SUPABASE_SERVICE_KEY).' });
    }
    try {
      const items = await supabaseList();
      const yes = items.filter((i) => i.attendance === 'yes');
      return json(200, {
        success: true,
        total: items.length,
        yesCount: yes.length,
        noCount: items.length - yes.length,
        guestsTotal: yes.reduce((s, i) => s + (Number(i.guests) || 0), 0),
        items
      });
    } catch (e) {
      console.error('[rsvp] list error:', e.message);
      return json(500, { success: false, message: 'Не удалось загрузить заявки. Попробуйте ещё раз.' });
    }
  }

  // ---------- POST: новая заявка ----------
  if (event.httpMethod === 'POST') {
    if (rateLimited(String(ip))) {
      return json(429, { success: false, message: 'Слишком много попыток. Попробуйте позже.' });
    }
    let data;
    try {
      data = JSON.parse(event.body || '{}');
    } catch (_) {
      return json(400, { success: false, message: 'Пожалуйста, заполните обязательные поля' });
    }
    const clean = validate(data);
    if (!clean) {
      return json(400, { success: false, message: 'Пожалуйста, заполните обязательные поля' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('[rsvp] supabase env missing');
      return json(500, { success: false, message: 'Не удалось отправить ответ. Попробуйте ещё раз.' });
    }
    const entry = {
      name: clean.name,
      attendance: clean.attendance,
      guests: clean.guests,
      menu_comment: clean.menuComment,
      created_at: new Date().toISOString()
    };
    try {
      await supabaseInsert(entry);
      // Ждём отправку в Telegram (с таймаутом), иначе serverless заморозит функцию раньше
      try {
        await Promise.race([
          notifyTelegram(entry),
          new Promise((_, reject) => setTimeout(() => reject(new Error('tg timeout')), 8000))
        ]);
      } catch (_) {}
      return json(200, { success: true, message: 'RSVP успешно сохранён' });
    } catch (e) {
      console.error('[rsvp] save error:', e.message);
      return json(500, { success: false, message: 'Не удалось отправить ответ. Попробуйте ещё раз.' });
    }
  }

  return json(405, { success: false, message: 'Метод не поддерживается' });
};
