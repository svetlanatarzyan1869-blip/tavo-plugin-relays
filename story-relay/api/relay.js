// api/relay.js — generic passthrough для ПЛАГИНОВ Tavo (ключ в настройках плагина, без шифрования).
// Плагин из браузера (tavo.vercel.app) не ходит к провайдеру напрямую (CORS), поэтому шлёт сюда
// {providerUrl, key, model, messages, max_tokens, temperature}, а мы server-side дёргаем провайдера
// (OpenAI-совместимый /chat/completions) и возвращаем {content}. Совместим по интерфейсу с pusya-bio.
// Существующий /api/story_proxy (шифрованный, для сайта-раздачи) НЕ трогаем.
export const config = { maxDuration: 60 };

// ── защита релея: только внешние http(s)-адреса и разумный объём. Релей не прокси «куда угодно»:
// внутренние адреса (localhost, 10.x, 192.168.x, 169.254.x …) и гигантские запросы отклоняем.
const MAX_MESSAGES = 300, MAX_CHARS = 400000, MAX_TOKENS_CAP = 32000;
function badTarget(u) {
  let x; try { x = new URL(u); } catch (e) { return 'адрес провайдера не похож на ссылку (нужно https://…)'; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return 'адрес провайдера должен начинаться с https://';
  if (x.username || x.password) return 'в адресе провайдера не должно быть логина и пароля';
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const internal = 'внутренние адреса не поддерживаются — нужен адрес провайдера в интернете';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return internal;
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m4) {
    const a = +m4[1], b = +m4[2];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return internal;
  }
  if (h.includes(':') && (h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'))) return internal;
  return '';
}
function badSize(messages) {
  if (messages.length > MAX_MESSAGES) return 'слишком много сообщений в запросе';
  let n = 0;
  for (const m of messages) n += String((m && m.content) == null ? '' : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).length;
  return n > MAX_CHARS ? 'слишком большой запрос' : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; } }
    body = body || {};

    let { providerUrl, key, model, messages, max_tokens, temperature } = body;
    if (!providerUrl || !key || !model || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'нужны providerUrl, key, model и messages' });
    }

    // Чистим ключ от «умных» символов (автозамена телефона ломает заголовок Authorization).
    key = String(key)
      .replace(/[‐-―−]/g, '-')
      .replace(/[‘’“”]/g, '')
      .replace(/[^\x00-\x7F]/g, '')
      .trim();

    // Нормализуем адрес до .../v1/chat/completions
    let url = String(providerUrl).trim().replace(/\s+/g, '');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // без схемы — добавляем https
    if (!/\/chat\/completions\/?$/.test(url)) {
      url = url.replace(/\/+$/, '');
      if (!/\/v\d+$/.test(url)) url += '/v1';   // без /v1 многие провайдеры не отвечают
      url += '/chat/completions';
    }
    const bt = badTarget(url) || badSize(messages);
    if (bt) return res.status(400).json({ error: bt });

    const payload = {
      model,
      messages,
      max_tokens: Math.min(Number(max_tokens) || 500, MAX_TOKENS_CAP),
      temperature: (temperature == null ? 0.6 : temperature),
      stream: false
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: 'провайдер ' + r.status, detail: txt.slice(0, 600) });
    }

    let data;
    try { data = JSON.parse(txt); } catch (e) { return res.status(200).json({ content: txt }); }
    const content =
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      (data && data.content) || '';
    return res.status(200).json({ content: String(content || '') });
  } catch (e) {
    const em = String((e && e.message) || e);
    return res.status(500).json({ error: em });
  }
}
