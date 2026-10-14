// Cloudflare Worker для плагина «Подслушано»: сохранёнки (/img/NN) и релей к модели (/relay).
// Картинки лежат статикой (public/NN.jpg). Плагин просит /img/NN и получает {dataUrl}:
// data:-картинку Tavo грузит надёжно, а прямой <img> на внешний адрес у неё может висеть
// (так было с memegen). Ответы кэшируются на краю — base64 считается только на промахе.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Стикеры Спотти для плашек ВК лежат статикой в public/stk (NN.webp + all.json) и
// отдаются напрямую, до кода воркера; заголовки к ним — в public/_headers.

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS, extra || {}) });
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}


// ── /relay: тонкий релей к OpenAI-совместимому провайдеру (порт api/bio.js с Vercel) ──
// Плагин из вебвью Tavo не может звать провайдера напрямую (CORS), поэтому шлёт сюда
// {providerUrl, key, model, messages, max_tokens, temperature}. Ответ ВСЕГДА HTTP 200 и
// приходит потоком: пока модель думает, раз в 8 с уходит пробел — соединение не простаивает
// и телефон его не рвёт; в конце — JSON {content} или {error, status, detail}.
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

// у «думающих» моделей max_tokens включает скрытое рассуждение — даём запас, иначе content пустой
const THINKING = /gemini|thinking|^o[134]|deepseek-r/i;

function normUrl(providerUrl) {
  let url = String(providerUrl).trim().replace(/\s+/g, '');
  if (!/\/chat\/completions\/?$/.test(url)) {
    url = url.replace(/\/+$/, '');
    if (!/\/v\d+(beta)?(\/openai)?$/.test(url)) url += '/v1';
    url += '/chat/completions';
  }
  return url;
}

// Читаем поток SSE (chat.completion.chunk) и собираем текст по кусочкам.
async function readSSE(r, meta) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', finish = '', head = '', streamError = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!meta.firstByteMs) meta.firstByteMs = Date.now() - meta.t0;
    const chunk = dec.decode(value, { stream: true });
    if (head.length < 800) head += chunk;
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.slice(0, 5) !== 'data:') continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch (e) { continue; }
      if (j.error) { streamError = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)); continue; }
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const delta = ch.delta || ch.message || {};
      let c = delta.content;
      if (Array.isArray(c)) c = c.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || '')).join('');
      if (typeof c === 'string' && c) { if (!meta.firstTokenMs) meta.firstTokenMs = Date.now() - meta.t0; content += c; }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content, finish, head, streamError };
}

// Один запрос к провайдеру. Просим поток (stream: true): провайдер начинает слать данные сразу,
// и его собственный таймаут на «тишину» (Cloudflare 524 через 100 с) не срабатывает.
async function upstream(url, key, payload, meta) {
  meta.t0 = Date.now(); meta.firstByteMs = 0; meta.firstTokenMs = 0;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(Object.assign({}, payload, { stream: true })),
    });
  } catch (e) {
    return { result: { error: 'адрес провайдера недоступен', status: 502, detail: String((e && e.message) || e) + ' · ' + url } };
  }
  meta.headersMs = Date.now() - meta.t0;
  meta.upstreamStatus = r.status;
  if (!r.ok) {
    const txt = await r.text();
    meta.totalMs = Date.now() - meta.t0;
    // провайдер не справился с reasoning_effort — повторяем без него. Тексты ошибок у шлюзов разные
    // (hk.linkapi.ai: «does not have a known Gemini thinking configuration», convert_request_failed),
    // поэтому повторяем при ЛЮБОМ 400 на запрос с этой настройкой: лишний быстрый запрос только при ошибке.
    if (r.status === 400 && payload.reasoning_effort) { meta.effortError = txt.slice(0, 200); return { retry: true }; }
    return { result: { error: 'провайдер ' + r.status, status: r.status, detail: txt.slice(0, 600) } };
  }
  const ctype = r.headers.get('content-type') || '';
  if (/event-stream/i.test(ctype)) {
    meta.stream = true;
    const s = await readSSE(r, meta);
    meta.totalMs = Date.now() - meta.t0;
    meta.finish = s.finish;
    meta.chars = s.content.length;
    if (!s.content.trim()) {
      if (s.streamError) return { result: { error: 'провайдер: ' + s.streamError, status: 502, detail: s.head.slice(0, 600) } };
      return { result: { error: 'модель вернула пустой ответ' + (s.finish ? ' (finish_reason: ' + s.finish + ')' : ''), status: 502, detail: s.head.slice(0, 600) } };
    }
    return { result: { content: s.content } };
  }
  // провайдер проигнорировал stream и прислал обычный ответ целиком
  meta.stream = false;
  const txt = await r.text();
  meta.firstByteMs = meta.firstByteMs || (Date.now() - meta.t0);
  meta.totalMs = Date.now() - meta.t0;
  let data;
  try { data = JSON.parse(txt); } catch (e) { return { result: { content: txt } }; }
  const content = pickContent(data);
  const ch0 = (data && data.choices && data.choices[0]) || {};
  const cand0 = (data && data.candidates && data.candidates[0]) || {};
  meta.finish = ch0.finish_reason || ch0.finishReason || cand0.finishReason || '';
  meta.chars = content.length;
  if (!content.trim()) {
    return { result: { error: 'модель вернула пустой ответ' + (meta.finish ? ' (finish_reason: ' + meta.finish + ')' : ''), status: 502, detail: txt.slice(0, 600) } };
  }
  return { result: { content: String(content) } };
}

async function relayCall(body, meta) {
  let { providerUrl, key, model, messages, max_tokens, temperature } = body || {};
  if (!providerUrl || !key || !model || !Array.isArray(messages) || !messages.length) {
    return { error: 'нужны providerUrl, key, model и messages', status: 400 };
  }
  // ключ без «умных» символов (автозамена телефона ломает заголовок Authorization)
  key = String(key)
    .replace(/[\u2010-\u2015\u2212]/g, '-')          // «умные» тире → обычный дефис
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')      // «умные» кавычки
    .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF]/g, '') // неразрывные и нулевые пробелы
    .replace(/[^\x21-\x7E]/g, '')                    // всё прочее вне видимого ASCII, включая пробелы
    .trim();
  const url = normUrl(providerUrl);
  const bt = badTarget(url) || badSize(messages);
  if (bt) return { error: bt, status: 400 };
  try { meta.host = new URL(url).host; } catch (e) { meta.host = '?'; }
  meta.model = String(model).slice(0, 80);

  let mt = Math.min(Number(max_tokens) || 900, MAX_TOKENS_CAP);
  if (THINKING.test(String(model))) mt = Math.max(mt, 4000);
  const payload = { model, messages, max_tokens: mt, temperature: (temperature == null ? 0.6 : temperature) };
  // gemini думает меньше — ответ приходит заметно быстрее (посты для стены не требуют глубоких раздумий)
  if (/gemini/i.test(String(model))) { payload.reasoning_effort = 'low'; meta.effort = 'low'; } else meta.effort = 'none';

  let out = await upstream(url, key, payload, meta);
  if (out.retry) {
    delete payload.reasoning_effort;
    meta.effort = 'dropped';
    out = await upstream(url, key, payload, meta);
  }
  return out.result;
}

// текст ошибки идёт в лог только коротким и без похожих на ключ строк (провайдер мог повторить ключ в ошибке)
function logSafe(e) {
  return String(e).replace(/sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S+|[A-Za-z0-9_\-]{20,}/g, '[hidden]').slice(0, 80);
}

function relayResponse(request, ctx) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const work = (async () => {
    const t0 = Date.now();
    const meta = {};
    const ping = setInterval(() => { writer.write(enc.encode(' ')).catch(() => {}); }, 8000);
    let result;
    try {
      const body = await request.json().catch(() => null);
      result = await relayCall(body, meta);
    } catch (e) {
      result = { error: String((e && e.message) || e), status: 500 };
    } finally {
      clearInterval(ping);
    }
    delete meta.t0;
    result.meta = meta;
    // одна строка в логи Cloudflare на запрос — без ключа и без текста сообщений
    console.log(JSON.stringify({
      relay: result.error ? 'error' : 'ok', ms: Date.now() - t0, host: meta.host, model: meta.model,
      status: result.error ? result.status : 200, stream: meta.stream, headersMs: meta.headersMs,
      firstByteMs: meta.firstByteMs, firstTokenMs: meta.firstTokenMs, finish: meta.finish, chars: meta.chars,
      effort: meta.effort, error: result.error ? logSafe(result.error) : undefined,
    }));
    try { await writer.write(enc.encode(JSON.stringify(result))); } catch (e) {}
    try { await writer.close(); } catch (e) {}
  })();
  ctx.waitUntil(work);
  return new Response(readable, { status: 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS) });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/relay') {
      if (request.method !== 'POST') return json({ error: 'только POST' }, 405);
      return relayResponse(request, ctx);
    }
    if (request.method !== 'GET') return json({ error: 'только GET' }, 405);

    const m = url.pathname.match(/^\/img\/(\d{1,3})$/);
    if (!m) return json({ error: 'не найдено' }, 404);

    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    const id = m[1].padStart(2, '0');
    const asset = await env.ASSETS.fetch(new Request(url.origin + '/' + id + '.jpg'));
    if (!asset.ok) return json({ error: 'нет картинки ' + id }, 404);
    const buf = await asset.arrayBuffer();

    const resp = json({ dataUrl: 'data:image/jpeg;base64,' + toBase64(buf) }, 200, { 'Cache-Control': 'public, max-age=86400, s-maxage=604800' });
    ctx.waitUntil(cache.put(request, resp.clone()));
    return resp;
  },
};
