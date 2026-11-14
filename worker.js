// Adam Fowler – the website's own small server on Cloudflare.
// The site's files are served by Cloudflare as they are; only addresses under /api/ come here:
//   POST /api/hit      a page or work seen, how long, how close (from visits.js; anonymous)
//   POST /api/contact  a message from the Bio page's contact form
//   GET  /api/stats    the numbers and messages, for stats.html (needs the ADMIN_KEY password); ?range=1|7|30|90 limits
//                      everything except the day-by-day history to the last N days (New York days), omitted = all time
//   GET  /api/daily.csv every day's counts since the start, as a spreadsheet (same password)
// Everything is kept in one Durable Object with its own small SQL database (no setup needed).
// The password is a secret set once in Cloudflare: Workers & Pages → adam-fowler-site → Settings → Variables and Secrets → ADMIN_KEY.
import { DurableObject } from 'cloudflare:workers';

const HOSTS = /(^|\.)adamfowler\.com$|\.workers\.dev$|^localhost$|^127\.0\.0\.1$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const ny = d => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: +g('hour') % 24, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
};
async function who(req, env) {   // a one-way fingerprint of the address, only to stop floods; the address itself is never kept
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + (env.ADMIN_KEY || 'af')));
  return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
// browser and system from the browser's own description; only the two names are kept, never the description itself
function agent(ua, dev) {
  ua = String(ua || '');
  if (/bot|crawl|spider|slurp|headless|lighthouse|preview|python|curl|wget/i.test(ua)) return { browser: 'robot', os: null };
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Instagram/.test(ua) ? 'Instagram app' :
    /FBAN|FBAV/.test(ua) ? 'Facebook app' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /DuckDuckGo/.test(ua) ? 'DuckDuckGo' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const os = /iPhone|iPod/.test(ua) ? 'iOS' : /iPad/.test(ua) || (/Macintosh/.test(ua) && dev === 'tablet') ? 'iPadOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' :
    /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return { browser, os };
}
// the first language the browser asks for, e.g. "en-US"
const language = req => clean(String(req.headers.get('Accept-Language') || '').split(',')[0].split(';')[0], 20) || null;
const auth = (req, env) => { const pw = String(env.ADMIN_KEY || '').trim(), given = String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); return !pw ? 'no password set yet' : given !== pw ? 'not allowed' : null; };
const sameSite = req => { try { return HOSTS.test(new URL(req.headers.get('Origin') || req.headers.get('Referer') || '').hostname); } catch { return false; } };

// a short email to Adam for each new message (Cloudflare Email Service). Needs the EMAIL binding, adamfowler.com set up
// for sending (Cloudflare → Email Service), and ALERT_TO in wrangler.jsonc. If any of that is missing the message is still saved.
async function alert(env, m) {
  if (!env.EMAIL || !env.ALERT_TO) return;
  try {
    await env.EMAIL.send({
      to: env.ALERT_TO, from: env.ALERT_FROM || 'website@adamfowler.com', replyTo: m.email,
      subject: `Message from ${m.name} (adamfowler.com)`,
      text: `${m.message}\n\n— ${m.name}, ${m.email}${m.place ? '\n' + m.place : ''}\n\nReply to this email to answer them. All messages: https://adamfowler.com/stats`
    });
  } catch (e) { console.warn('alert email', e && (e.code || e.message)); }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const store = env.STORE.get(env.STORE.idFromName('main'));

    if (req.method === 'POST' && url.pathname === '/api/hit') {
      if (!sameSite(req)) return json({ error: 'not allowed' }, 403);
      let b = {}; try { b = JSON.parse(await req.text()); } catch { }
      const id = s => /^[a-z0-9]{8,32}$/i.test(String(s || '')) ? String(s) : null;
      const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null;
      const ev = ['view', 'time', 'open', 'look', 'out', 'contact'].includes(b.ev) ? b.ev : null;
      if (!id(b.pid) || !id(b.sid) || !ev) return json({ error: 'bad request' }, 400);
      const cf = req.cf || {}, now = new Date(), t = ny(now), place = v => clean(v, 60) || null, dev = ['phone', 'tablet', 'desktop'].includes(b.dev) ? b.dev : null;
      const coord = (v, lim) => { const n = parseFloat(v); return isFinite(n) && Math.abs(n) <= lim ? Math.round(n * 100) / 100 : null; };   // the city's rough centre, as Cloudflare gives it
      const { browser, os } = agent(req.headers.get('User-Agent'), dev);
      const scr = /^\d{2,5}x\d{2,5}$/.test(String(b.scr || '')) ? String(b.scr) : null;
      await store.hit({
        pid: id(b.pid), sid: id(b.sid), ev, ...t, page: clean(b.page, 40) || null, work: Number.isInteger(b.work) && b.work >= 0 && b.work < 100 ? b.work : null,
        label: clean(b.label, 120) || null, k: clean(b.k, 200) || null, v: num(b.v, 0, 864e5), z: num(b.z, 0, 1),
        src: clean(b.src, 60) || null, dev,
        country: place(cf.country), region: place(cf.region), city: place(cf.city), org: place(cf.asOrganization), ip: await who(req, env), created: now.toISOString(),
        browser, os, lang: language(req), tz: place(cf.timezone), scr, ref: clean(b.ref, 200) || null, camp: clean(b.camp, 80) || null, land: clean(b.land, 120) || null,
        lat: coord(cf.latitude, 90), lon: coord(cf.longitude, 180)
      });
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/contact') {
      if (!sameSite(req)) return json({ error: 'not allowed' }, 403);
      let b = {}; try { b = JSON.parse(await req.text()); } catch { }
      if (b.bot) return json({ ok: true });   // the hidden field only robots fill in
      const name = clean(b.name, 120), email = clean(b.email, 200), message = String(b.message ?? '').replace(/\r/g, '').trim().slice(0, 5000);
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) return json({ error: 'Please fill in each line.' }, 400);
      const cf = req.cf || {};
      const r = await store.contact({ name, email, message, ip: await who(req, env), place: [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || null, created: new Date().toISOString() });
      if (r.ok) ctx.waitUntil(alert(env, { name, email, message, place: [cf.city, cf.region, cf.country].filter(Boolean).join(', ') }));
      return json(r, r.ok ? 200 : 429);
    }

    if (url.pathname === '/api/stats' || url.pathname === '/api/message' || url.pathname === '/api/daily.csv') {
      const no = auth(req, env);   // spaces around the password are ignored
      if (no) return json({ error: no }, 401);
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        const n = [1, 7, 30, 90].includes(+url.searchParams.get('range')) ? +url.searchParams.get('range') : 0;
        const since = n ? ny(new Date(Date.now() - (n - 1) * 864e5)).day : '0000-00-00';
        return json({ ...(await store.stats(since)), range: n, since: n ? since : null, today: ny(new Date()).day });
      }
      if (req.method === 'GET' && url.pathname === '/api/daily.csv')
        return new Response(await store.dailyCsv(), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="adamfowler-daily.csv"', 'Cache-Control': 'no-store' } });
      if (req.method === 'POST' && url.pathname === '/api/message') {   // mark a message read, or remove it
        let b = {}; try { b = await req.json(); } catch { }
        if (!Number.isInteger(b.id) || !['read', 'unread', 'delete'].includes(b.action)) return json({ error: 'bad request' }, 400);
        await store.message(b.id, b.action); return json({ ok: true });
      }
    }
    return json({ error: 'not found' }, 404);
  }
};

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT, sid TEXT, day TEXT, hour INTEGER, wd INTEGER, ev TEXT, page TEXT, work INTEGER, label TEXT, k TEXT, v REAL, z REAL,
      src TEXT, dev TEXT, country TEXT, region TEXT, city TEXT, org TEXT, ip TEXT, created TEXT)`);
    // added Nov 2026: browser and system names, language, time zone, screen size, the page that linked here, campaign, landing address, rough coordinates
    const have = new Set(this.q('PRAGMA table_info(visits)').map(c => c.name));
    for (const [c, t] of [['browser', 'TEXT'], ['os', 'TEXT'], ['lang', 'TEXT'], ['tz', 'TEXT'], ['scr', 'TEXT'], ['ref', 'TEXT'], ['camp', 'TEXT'], ['land', 'TEXT'], ['lat', 'REAL'], ['lon', 'REAL']])
      if (!have.has(c)) this.sql.exec(`ALTER TABLE visits ADD COLUMN ${c} ${t}`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_ip_day ON visits (ip, day)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_day ON visits (day)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_sid ON visits (sid)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_pid ON visits (pid)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, place TEXT, ip TEXT, created TEXT, unread INTEGER DEFAULT 1)');
  }
  q(s, ...v) { return this.sql.exec(s, ...v).toArray(); }
  hit(r) {
    const [{ n }] = this.q('SELECT COUNT(*) AS n FROM visits WHERE ip = ? AND day = ?', r.ip, r.day);
    if (n >= 3000) return;
    this.sql.exec(`INSERT INTO visits (pid, sid, day, hour, wd, ev, page, work, label, k, v, z, src, dev, country, region, city, org, ip, created, browser, os, lang, tz, scr, ref, camp, land, lat, lon)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.pid, r.sid, r.day, r.hour, r.wd, r.ev, r.page, r.work, r.label, r.k, r.v, r.z, r.src, r.dev, r.country, r.region, r.city, r.org, r.ip, r.created,
      r.browser, r.os, r.lang, r.tz, r.scr, r.ref, r.camp, r.land, r.lat, r.lon);
  }
  contact(m) {
    const [{ n }] = this.q('SELECT COUNT(*) AS n FROM messages WHERE ip = ? AND created > ?', m.ip, new Date(Date.now() - 864e5).toISOString());
    if (n >= 5) return { ok: false, error: 'Sorry, too many messages today.' };
    this.sql.exec('INSERT INTO messages (name, email, message, place, ip, created) VALUES (?,?,?,?,?,?)', m.name, m.email, m.message, m.place, m.ip, m.created);
    return { ok: true };
  }
  message(id, action) {
    if (action === 'delete') this.sql.exec('DELETE FROM messages WHERE id = ?', id);
    else this.sql.exec('UPDATE messages SET unread = ? WHERE id = ?', action === 'unread' ? 1 : 0, id);
  }
  // every day since the first visit, oldest last: visitors, new visitors, visits, page views, works opened, time spent, messages
  daily() {
    return this.q(`SELECT v.day, COUNT(DISTINCT v.pid) AS visitors, COUNT(DISTINCT v.sid) AS visits, SUM(v.ev = 'view') AS views, SUM(v.ev = 'open') AS opens,
      COUNT(DISTINCT CASE WHEN v.ev = 'open' THEN v.pid END) AS openers, ROUND(SUM(CASE WHEN v.ev IN ('time','look') THEN v.v ELSE 0 END) / 1000.0) AS secs,
      COALESCE(MAX(n.newv), 0) AS newv, COUNT(DISTINCT v.country) AS countries
      FROM visits v LEFT JOIN (SELECT day, COUNT(*) AS newv FROM (SELECT pid, MIN(day) AS day FROM visits GROUP BY pid) GROUP BY day) n ON n.day = v.day
      GROUP BY v.day ORDER BY v.day DESC`);
  }
  dailyCsv() {
    const msgs = Object.fromEntries(this.q("SELECT substr(created, 1, 10) AS d, COUNT(*) AS n FROM messages GROUP BY d").map(r => [r.d, r.n]));
    const rows = this.daily().reverse();
    return 'date,visitors,new visitors,visits,page views,works opened,people who opened a work,minutes on the site,countries,messages\n' +
      rows.map(r => [r.day, r.visitors, r.newv, r.visits, r.views || 0, r.opens || 0, r.openers, Math.round((r.secs || 0) / 6) / 10, r.countries, msgs[r.day] || 0].join(',')).join('\n') + '\n';
  }
  stats(since = '0000-00-00') {
    // V is the visits table limited to the chosen days; days itself always covers everything
    const V = `(SELECT * FROM visits WHERE day >= '${/^\d{4}-\d\d-\d\d$/.test(since) ? since : '0000-00-00'}')`;
    const q = this.q.bind(this);
    const [tot] = q(`SELECT COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits, SUM(ev = 'view') AS views, SUM(ev = 'open') AS opens, SUM(CASE WHEN ev IN ('time','look') THEN v ELSE 0 END) AS ms FROM ${V}`);
    const [nw] = q(`SELECT COUNT(*) AS newv FROM (SELECT pid, MIN(day) AS d FROM visits GROUP BY pid) WHERE d >= '${since}'`);
    const [first] = q('SELECT MIN(day) AS day FROM visits');
    const days = this.daily();
    const pages = q(`SELECT page, SUM(ev = 'view') AS views, COUNT(DISTINCT CASE WHEN ev = 'view' THEN pid END) AS visitors, ROUND(SUM(CASE WHEN ev = 'time' THEN v ELSE 0 END) / 1000.0 / MAX(SUM(ev = 'view'), 1)) AS secs FROM ${V} WHERE page IS NOT NULL GROUP BY page HAVING views > 0 ORDER BY visitors DESC`);
    const works = q(`SELECT work, MAX(label) AS label, SUM(ev = 'open') AS opens, COUNT(DISTINCT CASE WHEN ev = 'open' THEN pid END) AS visitors,
      ROUND(SUM(CASE WHEN ev = 'look' THEN v ELSE 0 END) / 1000.0 / MAX(SUM(ev = 'look'), 1)) AS secs, SUM(ev = 'look' AND z > 0) AS zoomed, SUM(ev = 'look') AS looks,
      ROUND(AVG(CASE WHEN ev = 'look' AND z > 0 THEN z END), 3) AS depth, MAX(day) AS last FROM ${V} WHERE work IS NOT NULL GROUP BY work ORDER BY visitors DESC, opens DESC`);
    const firsts = `SELECT v.* FROM ${V} v JOIN (SELECT sid, MIN(id) AS id FROM ${V} GROUP BY sid) f ON v.id = f.id`;
    const by = (col, name, lim = 30, where = '') => q(`SELECT ${col} AS ${name}, COUNT(DISTINCT pid) AS visitors, COUNT(*) AS visits FROM (${firsts}) ${where ? 'WHERE ' + where : ''} GROUP BY 1 ORDER BY visitors DESC LIMIT ${lim}`);
    const sources = by("COALESCE(src, 'direct')", 'src');
    const devices = by("COALESCE(dev, 'unknown')", 'dev');
    const browsers = by('browser', 'browser', 20, 'browser IS NOT NULL');
    const oses = by('os', 'os', 20, 'os IS NOT NULL');
    const langs = by('lang', 'lang', 30, 'lang IS NOT NULL');
    const screens = by('scr', 'scr', 20, 'scr IS NOT NULL');
    const refs = by('ref', 'ref', 40, 'ref IS NOT NULL');
    const camps = by('camp', 'camp', 30, 'camp IS NOT NULL');
    const lands = by('land', 'land', 30, "land IS NOT NULL AND land NOT IN ('/', '')");
    const countries = q(`SELECT country, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits FROM ${V} WHERE country IS NOT NULL GROUP BY country ORDER BY visitors DESC LIMIT 100`);
    // one row per place, with its rough coordinates (older visits have none; the page fills those in), for the map
    const places = q(`SELECT country, region, city, ROUND(AVG(lat), 2) AS lat, ROUND(AVG(lon), 2) AS lon, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits,
      SUM(ev = 'open') AS opens, MAX(created) AS last, MIN(created) AS first, GROUP_CONCAT(DISTINCT org) AS orgs FROM ${V} WHERE city IS NOT NULL OR lat IS NOT NULL
      GROUP BY country, region, city ORDER BY visitors DESC LIMIT 500`);
    const orgs = q(`SELECT org, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits, MAX(day) AS last FROM ${V} WHERE org IS NOT NULL GROUP BY org ORDER BY visitors DESC, last DESC LIMIT 60`);
    const outs = q(`SELECT k, COUNT(DISTINCT pid) AS visitors FROM ${V} WHERE ev = 'out' AND k IS NOT NULL GROUP BY k ORDER BY visitors DESC LIMIT 20`);
    const per = q(`SELECT pid, COUNT(DISTINCT sid) AS visits FROM ${V} GROUP BY pid`);
    const returning = [[1, 1, '1 visit'], [2, 2, '2 visits'], [3, 5, '3–5 visits'], [6, 1e9, '6 or more']].map(([lo, hi, name]) => ({ name, visitors: per.filter(r => r.visits >= lo && r.visits <= hi).length }));
    const hours = q(`SELECT hour, COUNT(DISTINCT pid) AS visitors FROM ${V} WHERE ev = 'view' GROUP BY hour ORDER BY hour`);
    const weekdays = q(`SELECT wd, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits FROM ${V} WHERE wd IS NOT NULL GROUP BY wd ORDER BY wd`);
    const recent = q(`SELECT v.sid, v.pid, v.ev, v.page, v.work, v.label, v.k, v.v, v.z, v.src, v.dev, v.country, v.region, v.city, v.org, v.created,
      v.browser, v.os, v.lang, v.tz, v.scr, v.ref, v.camp, v.land, v.lat, v.lon, (SELECT MIN(day) FROM visits p WHERE p.pid = v.pid) AS since FROM visits v
      JOIN (SELECT sid, MAX(id) AS last FROM ${V} GROUP BY sid ORDER BY last DESC LIMIT 60) s ON v.sid = s.sid ORDER BY v.id LIMIT 4000`);
    const messages = q('SELECT id, name, email, message, place, created, unread FROM messages ORDER BY id DESC LIMIT 200');
    return { ...tot, ...nw, first: first.day, days, pages, works, sources, devices, browsers, oses, langs, screens, refs, camps, lands, countries, places, orgs, outs, returning, hours, weekdays, recent, messages };
  }
}
