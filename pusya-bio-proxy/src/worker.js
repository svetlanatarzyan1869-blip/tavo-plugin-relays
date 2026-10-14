// pusya-bio-proxy — релей для плагина «Цикл и беременность» на Cloudflare Workers.
// Почему Workers, а не Vercel: релей почти всё время ЖДЁТ ответа провайдера, а Workers
// тарифицируют CPU-время (ожидание subrequest в него не входит) — в отличие от Vercel,
// где считается вся длительность функции.
// Контракт тот же: POST {providerUrl, key, model, messages, max_tokens, temperature} -> {content}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

// Достаём текст из всех распространённых форм ответа: разные шлюзы (rout.my, LinkAPI и пр.)
// заворачивают gemini по-разному — строкой, массивом частей, в reasoning_content, либо нативно.
function pickContent(data) {
  try {
    const ch = data && data.choices && data.choices[0];
    const msg = ch && ch.message;
    let c = msg && msg.content;
    if (Array.isArray(c)) c = c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
    if (typeof c === 'string' && c.trim()) return c;
    const rc = msg && (msg.reasoning_content || msg.reasoning);
    if (typeof rc === 'string' && rc.trim()) return rc;
    if (ch && typeof ch.text === 'string' && ch.text.trim()) return ch.text;
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (Array.isArray(parts)) { const t = parts.map(p => (p && p.text) || '').join(''); if (t.trim()) return t; }
    if (data && typeof data.content === 'string' && data.content.trim()) return data.content;
  } catch (e) {}
  return '';
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    try {
      let body = {};
      try { body = await request.json(); } catch (e) { body = {}; }
      body = body || {};

      let { providerUrl, key, model, messages, max_tokens, temperature } = body;
      if (!providerUrl || !key || !model || !Array.isArray(messages) || !messages.length) {
        return json({ error: 'нужны providerUrl, key, model и messages' }, 400);
      }

      // Чистим ключ от «умных» символов (автозамена телефона ломает заголовок Authorization).
      key = String(key)
        .replace(/[‐-―−]/g, '-')
        .replace(/[‘’“”]/g, '')
        .replace(/[  -​]/g, '')
        .replace(/[^\x00-\x7F]/g, '')
        .trim();

      // Нормализуем адрес до .../v1/chat/completions
      let url = String(providerUrl).trim().replace(/\s+/g, '');
      if (!/\/chat\/completions\/?$/.test(url)) {
        url = url.replace(/\/+$/, '');
        if (!/\/v\d+$/.test(url)) url += '/v1';
        url += '/chat/completions';
      }
      const bt = badTarget(url) || badSize(messages);
      if (bt) return json({ error: bt }, 400);

      // У «думающих» моделей (gemini 2.x, o1/o3, deepseek-r) лимит max_tokens включает
      // скрытые токены рассуждения: при тесном лимите весь бюджет уходит в «мышление»,
      // а content приходит ПУСТОЙ. Даём таким моделям заведомый запас.
      const thinking = /gemini|thinking|^o[13]|deepseek-r/i.test(String(model));
      let mt = Math.min(Number(max_tokens) || 900, MAX_TOKENS_CAP);
      if (thinking) mt = Math.max(mt, 4000);

      const payload = {
        model,
        messages,
        max_tokens: mt,
        temperature: (temperature == null ? 0.6 : temperature),
        stream: false
      };

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(payload)
      });

      const txt = await r.text();
      if (!r.ok) return json({ error: 'провайдер ' + r.status, detail: txt.slice(0, 600) }, r.status);

      let data;
      try { data = JSON.parse(txt); } catch (e) { return json({ content: txt }); }

      const content = pickContent(data);
      if (!content.trim()) {
        // Пустой content при 200 — типично для gemini: бюджет съело «мышление» (finish_reason: length)
        // либо сработали фильтры (content_filter / SAFETY). Отдаём явную ошибку, а не тишину.
        const ch0 = (data && data.choices && data.choices[0]) || {};
        const cand0 = (data && data.candidates && data.candidates[0]) || {};
        const fr = ch0.finish_reason || ch0.finishReason || cand0.finishReason || '';
        return json({
          error: 'модель вернула пустой ответ' + (fr ? ' (finish_reason: ' + fr + ')' : ''),
          detail: txt.slice(0, 600)
        }, 502);
      }
      return json({ content: String(content) });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};
