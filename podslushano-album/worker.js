// Cloudflare Worker для плагина «Подслушано»: сохранёнки (/img/NN). Релей к модели (/relay) убран:
// плагины ходят к провайдеру напрямую.
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


export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
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
