// Cloudflare Worker — мем-обложка для плагина «Сплетник».
// Тянет картинку с memegen НА СЕРВЕРЕ (из вебвью Tavo прямой запрос к memegen висит)
// и отдаёт её плагину data:-картинкой. Перенесено с Vercel, чтобы разгрузить основной
// Vercel-аккаунт. Cloudflare free: ~100k запросов/день; повторные мемы отдаются из
// edge-кэша, base64 считается только на промахе кэша.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // повторные одинаковые мемы → из edge-кэша (без base64, почти без CPU)
    const cache = caches.default;
    const isGet = request.method === 'GET';
    if (isGet) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    try {
      let template, top, bottom, width;
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        template = b && b.template; top = b && b.top; bottom = b && b.bottom; width = b && b.width;
      } else {
        const u = new URL(request.url);
        template = u.searchParams.get('template');
        top = u.searchParams.get('top');
        bottom = u.searchParams.get('bottom');
        width = u.searchParams.get('width');
      }

      template = String(template || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!template || template.length < 2) return json({ error: 'нужен template' }, 400);

      const seg = (s) => { s = String(s == null ? '' : s).trim(); if (!s || s === '-') s = '_'; return encodeURIComponent(s.replace(/\s+/g, '_')); };
      const w = Math.max(200, Math.min(1000, parseInt(width, 10) || 520));
      const memeUrl = 'https://api.memegen.link/images/' + template + '/' + seg(top) + '/' + seg(bottom) + '.jpg?width=' + w;

      const img = await fetch(memeUrl, { cf: { cacheEverything: true, cacheTtl: 86400 } });
      if (!img.ok) {
        const t = await img.text();
        return json({ error: 'memegen ' + img.status, detail: t.slice(0, 300) }, img.status);
      }
      const buf = await img.arrayBuffer();
      if (!buf || !buf.byteLength) return json({ error: 'пустой ответ memegen' }, 502);

      const resp = new Response(JSON.stringify({ dataUrl: 'data:image/jpeg;base64,' + toBase64(buf) }), {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=86400' }, CORS),
      });
      if (isGet) ctx.waitUntil(cache.put(request, resp.clone()));
      return resp;
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
