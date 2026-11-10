/* Adam Fowler – the website's statistics, counted anonymously (read on stats.html).
   Pages seen and for how long; which works were opened, how long they were looked at and how close people went; links out.
   A visitor is an anonymous number kept in this browser; a visit ends after half an hour away. Cloudflare adds roughly
   where they are and whose network it is; no address is kept. index.html calls window.afTrack(...) at the moments that matter. */
(function () {
  if (window.afTrack) return;
  var on = /(^|\.)adamfowler\.com$/.test(location.hostname);
  var ls = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  var ss = function (k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } };
  if (ls('af-not-counted')) on = false;                                   // Adam's own browsers (set on the statistics page)
  var rid = function () { return (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 20); };
  var pid = ls('af-pid'); if (!/^[a-z0-9]{8,32}$/.test(pid || '')) { pid = rid(); ls('af-pid', pid); }
  var now = Date.now(), last = +(ls('af-last') || 0), sid = ss('af-sid') || (now - last < 18e5 ? ls('af-lsid') : null);
  var fresh = !sid || now - last > 18e5; if (fresh) { sid = rid(); ss('af-src', ''); }
  ss('af-sid', sid); ls('af-lsid', sid);
  var touch = function () { ls('af-last', String(Date.now())); }; touch();
  var src = ss('af-src');
  if (!src) {
    var u = new URLSearchParams(location.search);
    if (u.get('utm_source')) src = u.get('utm_source').toLowerCase().slice(0, 40);
    else { try { var h = new URL(document.referrer).hostname.replace(/^www\./, '');
      src = !h || /adamfowler\.com$/.test(h) ? 'direct' : /instagram/.test(h) ? 'instagram' : /facebook|fb\./.test(h) ? 'facebook' : /google\./.test(h) ? 'google' :
        /bing\.|duckduckgo|yahoo\./.test(h) ? 'other search' : /t\.co$|twitter|x\.com/.test(h) ? 'x / twitter' : /linkedin|lnkd/.test(h) ? 'linkedin' : /mail|outlook/.test(h) ? 'email' :
        /soniadutton/.test(h) ? 'dutton' : /artsy/.test(h) ? 'artsy' : h; } catch (e) { src = 'direct'; } }
    ss('af-src', src);
  }
  var dev = matchMedia('(pointer: coarse)').matches ? (Math.min(screen.width, screen.height) >= 700 ? 'tablet' : 'phone') : 'desktop';
  var send = function (o) {
    if (!on) return;
    o.pid = pid; o.sid = sid; o.src = src; o.dev = dev; touch();
    var body = JSON.stringify(o);
    try { if (navigator.sendBeacon && navigator.sendBeacon('/api/hit', new Blob([body], { type: 'text/plain' }))) return; } catch (e) { }
    try { fetch('/api/hit', { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) { }
  };
  var page = null, pageT = 0, work = null, workT = 0, depth = 0, label = null;
  var endPage = function () { if (page && pageT) { var v = Date.now() - pageT; if (v > 500) send({ ev: 'time', page: page, v: Math.min(v, 864e5) }); } pageT = 0; };
  var endWork = function () { if (work !== null && workT) { var v = Date.now() - workT; if (v > 300) send({ ev: 'look', work: work, label: label, v: Math.min(v, 864e5), z: depth }); } workT = 0; };
  window.afTrack = function (ev, a, b) {
    if (ev === 'view') { if (a === page && pageT) return; endPage(); page = a; pageT = Date.now(); send({ ev: 'view', page: a }); }
    else if (ev === 'open') { endWork(); work = a; label = b || null; depth = 0; workT = Date.now(); send({ ev: 'open', work: a, label: label }); }
    else if (ev === 'zoom') { if (work !== null && a > depth) depth = a; }
    else if (ev === 'close') { endWork(); work = null; }
    else if (ev === 'contact') send({ ev: 'contact', page: 'bio' });
  };
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { endPage(); if (work !== null) { endWork(); } }
    else { touch(); if (page) pageT = Date.now(); if (work !== null) workT = Date.now(); }
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="http"]'); if (!a) return;
    try { var h = new URL(a.href).hostname; if (!/adamfowler\.com$/.test(h)) send({ ev: 'out', k: h.replace(/^www\./, '') }); } catch (x) { }
  }, true);
})();
