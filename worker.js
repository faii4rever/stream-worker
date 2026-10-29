/**
 * FaStream Worker — resolver + proxy media untuk versi web.
 *
 *   GET /api/resolve?url=<halaman episode>  -> {sources:[{url,type}], embeds:[url]}
 *   GET /api/proxy?u=&r=&s=                 -> meneruskan media dengan Referer/CORS yang benar
 *
 * Variabel (wrangler.toml / dashboard):
 *   SIGN_KEY   (secret, wajib)  kunci penanda-tangan URL proxy -> proxy tidak bisa dipakai sembarang orang
 *   SITE_HOST  (opsional)       domain sumber, default "animeindo.me"
 * Selain /api/*, file statis (index.html, data.js, logo.png) disajikan dari folder public/.
 */

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const BAD = ['doubleclick', 'googlesyndication', 'adservice', 'popads', '/ads/', 'adsterra', 'banner', 'analytics', 'histats', 'facebook.', 'favicon'];
const MAX_EMBEDS = 6;
const FETCH_TIMEOUT = 9000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/api/resolve') return withCors(await handleResolve(url, env));
      if (url.pathname === '/api/proxy') return withCors(await handleProxy(url, req, env));
    } catch (e) {
      return withCors(json({ error: String(e && e.message || e), sources: [], embeds: [] }, 500));
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('FaStream API OK', { status: 200 });
  },
};

// ---------------------------------------------------------------- util
function withCors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (u) => { const l = u.toLowerCase(); return BAD.some(b => l.includes(b)); };
const siteHost = (env) => (env.SITE_HOST || 'animeindo.me').toLowerCase();
const baseDomain = (h) => { const p = h.toLowerCase().split('.'); return p.length <= 2 ? h.toLowerCase() : p.slice(-2).join('.'); };

function isPublicHttps(u) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'https:') return false;
  const h = x.hostname;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false;   // tanpa IP langsung
  return true;
}

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGN_KEY || 'change-me'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  let s = ''; for (let i = 0; i < 16; i++) s += sig[i].toString(16).padStart(2, '0');
  return s;
}
async function proxyUrl(origin, env, target, referer) {
  const s = await hmac(env, target + '|' + referer);
  return `${origin}/api/proxy?u=${encodeURIComponent(target)}&r=${encodeURIComponent(referer)}&s=${s}`;
}

async function fetchT(url, init = {}, ms = FETCH_TIMEOUT) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}
async function fetchHtml(url, referer) {
  const h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'id,en;q=0.8' };
  if (referer) { h['Referer'] = referer; try { h['Origin'] = new URL(referer).origin; } catch { } }
  const r = await fetchT(url, { headers: h });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' dari ' + new URL(url).hostname);
  return { text: await r.text(), finalUrl: r.url || url };
}

// ---------------------------------------------------------------- ekstraksi
function unpackAll(text) {
  // Dean Edwards p.a.c.k.e.r: eval(function(p,a,c,k,e,d){...}('payload',base,count,'a|b|c'.split('|'),0,{}))
  const re = /\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  let out = '', m;
  while ((m = re.exec(text))) {
    try {
      const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const a = +m[2]; let c = +m[3];
      const k = m[4].replace(/\\'/g, "'").split('|');
      const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
      const d = {};
      while (c--) d[e(c)] = k[c] || e(c);
      out += '\n' + p.replace(/\b\w+\b/g, w => d[w] !== undefined ? d[w] : w);
    } catch { }
  }
  return out;
}
function normalize(t) {
  return t.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u002F/gi, '/');
}
function findMedia(text, base) {
  const t = normalize(text + unpackAll(text));
  const found = new Map();
  const re = /(?:https?:)?\/\/[^\s"'<>\\)\]]+?\.(m3u8|mp4|webm)(?:\?[^\s"'<>\\)\]]*)?/gi;
  let m;
  while ((m = re.exec(t))) {
    let u = m[0]; if (u.startsWith('//')) u = 'https:' + u;
    if (!u.startsWith('https://') || bad(u)) continue;
    found.set(u, m[1].toLowerCase() === 'm3u8' ? 'hls' : 'mp4');
  }
  // sumber relatif: file:"/path/x.m3u8" / src:"x.mp4"
  const rel = /["'](\/[^"'\s]+?\.(m3u8|mp4)(?:\?[^"'\s]*)?)["']/gi;
  while ((m = rel.exec(t))) {
    try { const u = new URL(m[1], base).href; if (u.startsWith('https://') && !bad(u)) found.set(u, m[2].toLowerCase() === 'm3u8' ? 'hls' : 'mp4'); } catch { }
  }
  return found;
}
function findEmbeds(html, base) {
  const out = [];
  const add = (u) => {
    if (!u) return;
    try {
      u = u.trim().replace(/&amp;/g, '&');
      const a = new URL(u, base).href;
      if (a.startsWith('https://') && !bad(a) && !out.includes(a)) out.push(a);
    } catch { }
  };
  let m;
  const ifr = /<iframe[^>]+?(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi;
  while ((m = ifr.exec(html))) add(m[1]);
  // mirror ala tema Animestream: <option value="base64(<iframe src=...>)">
  const opt = /<option[^>]+value\s*=\s*["']([^"']{24,})["']/gi;
  while ((m = opt.exec(html))) {
    const v = m[1].replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(v)) {
      try {
        const d = atob(v);
        const s = d.match(/src\s*=\s*["']([^"']+)["']/i);
        if (s) add(s[1]); else if (/^https?:/i.test(d)) add(d);
      } catch { }
    } else if (/^(https?:)?\/\//.test(v)) add(v);
  }
  const dat = /data-(?:embed|video|iframe|url)\s*=\s*["']([^"']+)["']/gi;
  while ((m = dat.exec(html))) {
    const v = m[1];
    if (/^(https?:)?\/\//.test(v)) add(v);
    else if (/^[A-Za-z0-9+/=]{24,}$/.test(v)) { try { const s = atob(v).match(/src\s*=\s*["']([^"']+)["']/i); if (s) add(s[1]); } catch { } }
  }
  return out;
}

// ---------------------------------------------------------------- /api/resolve
async function handleResolve(url, env) {
  const page = url.searchParams.get('url') || '';
  let pu; try { pu = new URL(page); } catch { return json({ error: 'url tidak valid', sources: [], embeds: [] }, 400); }
  if (pu.protocol !== 'https:' || baseDomain(pu.hostname) !== baseDomain(siteHost(env)))
    return json({ error: 'domain tidak diizinkan', sources: [], embeds: [] }, 403);

  const origin = url.origin;
  const { text: html, finalUrl } = await fetchHtml(page, pu.origin + '/');
  const media = new Map();               // url -> {type, ref}
  const addMedia = (map, ref) => map.forEach((type, u) => { if (!media.has(u)) media.set(u, { type, ref }); });
  addMedia(findMedia(html, finalUrl), finalUrl);

  // embed level 1 (+ level 2 untuk iframe bersarang)
  const embeds = findEmbeds(html, finalUrl).slice(0, MAX_EMBEDS);
  const seen = new Set(embeds);
  const probe = async (eu, ref, depth) => {
    try {
      const { text, finalUrl: fu } = await fetchHtml(eu, ref);
      addMedia(findMedia(text, fu), eu);
      if (depth < 2) {
        const nested = findEmbeds(text, fu).filter(n => !seen.has(n)).slice(0, 3);
        nested.forEach(n => seen.add(n));
        await Promise.all(nested.map(n => probe(n, eu, depth + 1)));
      }
    } catch { }
  };
  if (media.size === 0) await Promise.all(embeds.map(e => probe(e, finalUrl, 1)));

  const list = [...media.entries()].sort((a, b) => (a[1].type === 'hls' ? 0 : 1) - (b[1].type === 'hls' ? 0 : 1)).slice(0, 6);
  const sources = await Promise.all(list.map(async ([u, v]) => ({
    type: v.type, url: await proxyUrl(origin, env, u, v.ref),
  })));
  return json({ sources, embeds });
}

// ---------------------------------------------------------------- /api/proxy
async function handleProxy(url, req, env) {
  const u = url.searchParams.get('u') || '';
  const r = url.searchParams.get('r') || '';
  const s = url.searchParams.get('s') || '';
  if (!isPublicHttps(u)) return new Response('bad url', { status: 400 });
  if (s !== await hmac(env, u + '|' + r)) return new Response('bad signature', { status: 403 });

  const h = { 'User-Agent': UA, 'Accept': '*/*' };
  if (r) { h['Referer'] = r; try { h['Origin'] = new URL(r).origin; } catch { } }
  const range = req.headers.get('Range');
  if (range) h['Range'] = range;
  const up = await fetchT(u, { headers: h }, 25000);

  const ct = up.headers.get('content-type') || '';
  const finalUrl = up.url || u;
  const looksM3u8 = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search);
  if (looksM3u8 && up.ok) {
    const text = await up.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      const body = await rewriteM3u8(text, finalUrl, r, url.origin, env);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } });
    }
    return new Response(text, { status: up.status, headers: { 'content-type': ct || 'text/plain' } });
  }
  const out = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(k); if (v) out.set(k, v);
  }
  out.set('cache-control', 'public, max-age=300');
  return new Response(up.body, { status: up.status, headers: out });
}

async function rewriteM3u8(text, base, referer, origin, env) {
  const wrap = (t) => proxyUrl(origin, env, new URL(t, base).href, referer);
  const lines = text.split(/\r?\n/);
  const out = await Promise.all(lines.map(async (line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      const uris = [...t.matchAll(/URI="([^"]+)"/g)];
      if (!uris.length) return line;
      let res = line;
      for (const m of uris) {
        try { res = res.replace(m[0], 'URI="' + await wrap(m[1]) + '"'); } catch { }
      }
      return res;
    }
    try { return await wrap(t); } catch { return line; }
  }));
  return out.join('\n');
}
