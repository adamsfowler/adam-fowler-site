// Adam Fowler – the website's own small server on Cloudflare.
// The site's files are served by Cloudflare as they are; only addresses under /api/ come here:
//   POST /api/hit      a page or work seen, how long, how close (from visits.js; anonymous)
//   POST /api/contact  a message from the Bio page's contact form
//   GET  /api/stats    the numbers and messages, for stats.html (needs the ADMIN_KEY password)
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
const sameSite = req => { try { return HOSTS.test(new URL(req.headers.get('Origin') || req.headers.get('Referer') || '').hostname); } catch { return false; } };

export default {
  async fetch(req, env) {
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
      const cf = req.cf || {}, now = new Date(), t = ny(now), place = v => clean(v, 60) || null;
      await store.hit({
        pid: id(b.pid), sid: id(b.sid), ev, ...t, page: clean(b.page, 40) || null, work: Number.isInteger(b.work) && b.work >= 0 && b.work < 100 ? b.work : null,
        label: clean(b.label, 120) || null, k: clean(b.k, 200) || null, v: num(b.v, 0, 864e5), z: num(b.z, 0, 1),
        src: clean(b.src, 60) || null, dev: ['phone', 'tablet', 'desktop'].includes(b.dev) ? b.dev : null,
        country: place(cf.country), region: place(cf.region), city: place(cf.city), org: place(cf.asOrganization), ip: await who(req, env), created: now.toISOString()
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
      return json(r, r.ok ? 200 : 429);
    }

    if (url.pathname === '/api/stats' || url.pathname === '/api/message') {
      if (!env.ADMIN_KEY || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_KEY}`) return json({ error: env.ADMIN_KEY ? 'not allowed' : 'no password set yet' }, 401);
      if (req.method === 'GET' && url.pathname === '/api/stats') return json(await store.stats());
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
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_ip_day ON visits (ip, day)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS visits_sid ON visits (sid)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, message TEXT, place TEXT, ip TEXT, created TEXT, unread INTEGER DEFAULT 1)');
  }
  q(s, ...v) { return this.sql.exec(s, ...v).toArray(); }
  hit(r) {
    const [{ n }] = this.q('SELECT COUNT(*) AS n FROM visits WHERE ip = ? AND day = ?', r.ip, r.day);
    if (n >= 3000) return;
    this.sql.exec('INSERT INTO visits (pid, sid, day, hour, wd, ev, page, work, label, k, v, z, src, dev, country, region, city, org, ip, created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      r.pid, r.sid, r.day, r.hour, r.wd, r.ev, r.page, r.work, r.label, r.k, r.v, r.z, r.src, r.dev, r.country, r.region, r.city, r.org, r.ip, r.created);
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
  stats() {
    const q = this.q.bind(this);
    const [tot] = q("SELECT COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits, SUM(ev = 'view') AS views, SUM(ev = 'open') AS opens, SUM(CASE WHEN ev IN ('time','look') THEN v ELSE 0 END) AS ms FROM visits");
    const days = q("SELECT day, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits, SUM(ev = 'open') AS opens FROM visits GROUP BY day ORDER BY day DESC LIMIT 60");
    const pages = q("SELECT page, SUM(ev = 'view') AS views, COUNT(DISTINCT CASE WHEN ev = 'view' THEN pid END) AS visitors, ROUND(SUM(CASE WHEN ev = 'time' THEN v ELSE 0 END) / 1000.0 / MAX(SUM(ev = 'view'), 1)) AS secs FROM visits WHERE page IS NOT NULL GROUP BY page HAVING views > 0 ORDER BY visitors DESC");
    const works = q(`SELECT work, MAX(label) AS label, SUM(ev = 'open') AS opens, COUNT(DISTINCT CASE WHEN ev = 'open' THEN pid END) AS visitors,
      ROUND(SUM(CASE WHEN ev = 'look' THEN v ELSE 0 END) / 1000.0 / MAX(SUM(ev = 'look'), 1)) AS secs, SUM(ev = 'look' AND z > 0) AS zoomed, SUM(ev = 'look') AS looks,
      ROUND(AVG(CASE WHEN ev = 'look' AND z > 0 THEN z END), 3) AS depth, MAX(day) AS last FROM visits WHERE work IS NOT NULL GROUP BY work ORDER BY visitors DESC, opens DESC`);
    const firsts = 'SELECT v.* FROM visits v JOIN (SELECT sid, MIN(id) AS id FROM visits GROUP BY sid) f ON v.id = f.id';
    const sources = q(`SELECT COALESCE(src, 'direct') AS src, COUNT(DISTINCT pid) AS visitors, COUNT(*) AS visits FROM (${firsts}) GROUP BY 1 ORDER BY visitors DESC LIMIT 30`);
    const devices = q(`SELECT COALESCE(dev, 'unknown') AS dev, COUNT(DISTINCT pid) AS visitors FROM (${firsts}) GROUP BY 1 ORDER BY visitors DESC`);
    const countries = q('SELECT country, COUNT(DISTINCT pid) AS visitors FROM visits WHERE country IS NOT NULL GROUP BY country ORDER BY visitors DESC LIMIT 40');
    const places = q('SELECT country, region, city, COUNT(DISTINCT pid) AS visitors FROM visits WHERE city IS NOT NULL GROUP BY country, region, city ORDER BY visitors DESC LIMIT 40');
    const orgs = q('SELECT org, COUNT(DISTINCT pid) AS visitors, COUNT(DISTINCT sid) AS visits, MAX(day) AS last FROM visits WHERE org IS NOT NULL GROUP BY org ORDER BY visitors DESC, last DESC LIMIT 60');
    const outs = q("SELECT k, COUNT(DISTINCT pid) AS visitors FROM visits WHERE ev = 'out' AND k IS NOT NULL GROUP BY k ORDER BY visitors DESC LIMIT 20");
    const per = q('SELECT pid, COUNT(DISTINCT sid) AS visits FROM visits GROUP BY pid');
    const returning = [[1, 1, '1 visit'], [2, 2, '2 visits'], [3, 5, '3–5 visits'], [6, 1e9, '6 or more']].map(([lo, hi, name]) => ({ name, visitors: per.filter(r => r.visits >= lo && r.visits <= hi).length }));
    const hours = q("SELECT hour, COUNT(DISTINCT pid) AS visitors FROM visits WHERE ev = 'view' GROUP BY hour ORDER BY hour");
    const recent = q(`SELECT v.sid, v.pid, v.ev, v.page, v.work, v.label, v.k, v.v, v.z, v.src, v.dev, v.country, v.region, v.city, v.org, v.created FROM visits v
      JOIN (SELECT sid, MAX(id) AS last FROM visits GROUP BY sid ORDER BY last DESC LIMIT 40) s ON v.sid = s.sid ORDER BY v.id LIMIT 3000`);
    const messages = q('SELECT id, name, email, message, place, created, unread FROM messages ORDER BY id DESC LIMIT 200');
    return { ...tot, days, pages, works, sources, devices, countries, places, orgs, outs, returning, hours, recent, messages };
  }
}
