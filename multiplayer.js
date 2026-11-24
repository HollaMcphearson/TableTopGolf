/* ============================================================================
   TABLE TOP GOLF: play on separate devices
   One device hosts (it runs the real game and rolls every die). Everyone else joins with a room code and
   sees the same game. On your turn your device unlocks the controls and sends your shot to the host; the
   host plays it and every device replays it with the same dice, then the host sends a snapshot of the
   official state so every screen stays identical.
   Devices connect directly (WebRTC via the free PeerJS matchmaking service): no server of ours.
   ========================================================================== */
(function () {
  if (window.TTG_MP || typeof S === 'undefined') return;
  const MP = window.TTG_MP = { ver: 'v6-looks', info: '', role: null, code: '', cid: '', owners: [], clients: {}, slots: [], started: false, n: 0, seq: 0, mm: 0, q: [], busy: false, net: null, names: [], pending: false };
  const $q = s => document.querySelector(s), esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = s => String(s || '').replace(/[<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const SAVEJ = 'ttg_mp_join';

  /* ---------- connection layer (PeerJS); tests replace MP.net with an in-memory version ---------- */
  function loadPeer() {
    return new Promise((ok, no) => {
      if (window.Peer) return ok();
      const add = (u, f) => { const s = document.createElement('script'); s.src = u; s.onload = ok; s.onerror = f; document.head.appendChild(s); };
      add('https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js', () => add('https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js', () => no(new Error('the direct-connection library would not load (the network may block it)'))));
    });
  }
  function wrap(c) {
    const w = { send: m => { try { c.send(m) } catch (e) { } }, onmsg: null, onclose: null, close: () => { try { c.close() } catch (e) { } } };
    c.on('data', d => w.onmsg && w.onmsg(d)); c.on('close', () => w.onclose && w.onclose()); c.on('error', () => w.onclose && w.onclose());
    return w;
  }
  const PeerNet = {
    host(code, onconn) {
      return loadPeer().then(() => new Promise((ok, no) => {
        const p = new Peer('ttgolf-' + code);
        p.on('open', () => { p.on('connection', c => { const w = wrap(c); onconn(w) }); ok({ close: () => p.destroy() }) });
        p.on('error', e => no(e));
      }));
    },
    join(code) {
      return loadPeer().then(() => new Promise((ok, no) => {
        const p = new Peer(), t = setTimeout(() => no(new Error('the direct connection timed out')), 15000);
        p.on('open', () => { const c = p.connect('ttgolf-' + code, { reliable: true, serialization: 'json' }); c.on('open', () => { clearTimeout(t); ok(wrap(c)) }); });
        p.on('error', e => { clearTimeout(t); no(e.type == 'peer-unavailable' ? new Error('No game with that code. Check the code and that the host has opened the room.') : new Error('direct connection error: ' + (e.type || e.message || 'unknown'))) });
      }));
    }
  };

  /* ---------- backup route: free public relay servers (MQTT over secure websockets) ----------
     Used when a direct connection cannot be opened (strict wifi, mobile networks). Messages pass through the relay. */
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081'];
  function loadMqtt() {
    return new Promise((ok, no) => {
      if (window.mqtt) return ok();
      const add = (u, f) => { const s = document.createElement('script'); s.src = u; s.onload = ok; s.onerror = f; document.head.appendChild(s); };
      add('https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js', () => add('https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js', () => no(new Error('the relay library would not load (the network may block it)'))));
    });
  }
  function mqttOpen(url, ms) {
    return new Promise((ok, no) => {
      let c; try { c = mqtt.connect(url, { reconnectPeriod: 2000, connectTimeout: ms || 6000, clean: true, clientId: 'ttg_' + Math.random().toString(36).slice(2, 10) }) } catch (e) { return no(e) }
      const t = setTimeout(() => { try { c.end(true) } catch (e) { } no(new Error('timeout')) }, (ms || 6000) + 500);
      c.once('connect', () => { clearTimeout(t); ok(c) }); c.on('error', () => { });
    });
  }
  function relayWrap(pub, dead) {
    const w = { onmsg: null, onclose: null, _s: 0, _r: 0, _seen: Date.now(), closed: false,
      send(m) { if (!w.closed) pub({ s: ++w._s, m }) },
      close() { if (w.closed) return; w.closed = true; clearInterval(w._hb); try { pub({ k: 'bye' }) } catch (e) { } dead && dead(); w.onclose && w.onclose() },
      _in(o) {
        w._seen = Date.now();
        if (o.k == 'bye') { if (!w.closed) { w.closed = true; clearInterval(w._hb); dead && dead(); w.onclose && w.onclose() } return }
        if (o.k || !o.s || o.s <= w._r) return; w._r = o.s; w.onmsg && w.onmsg(o.m);
      } };
    w._hb = setInterval(() => { if (w.closed) return clearInterval(w._hb); try { pub({ k: 'ping' }) } catch (e) { } if (Date.now() - w._seen > 45000) { w.closed = true; clearInterval(w._hb); dead && dead(); w.onclose && w.onclose() } }, 5000);
    return w;
  }
  const RelayNet = {
    async host(code, onconn) {
      await loadMqtt(); const P = 'ttgolf/v1/' + code, conns = [], guests = {};
      const pubAll = (topic, o) => conns.forEach(c => { try { c.publish(topic, JSON.stringify(o), { qos: 1 }) } catch (e) { } });
      await Promise.all(BROKERS.map(u => mqttOpen(u, 5000).then(c => {
        conns.push(c); c.subscribe(P + '/h', { qos: 1 });
        c.on('message', (tp, pl) => {
          let o; try { o = JSON.parse(pl.toString()) } catch (e) { return } if (!o || !o.g) return;
          if (o.k == 'probe') { pubAll(P + '/g/' + o.g, { k: 'ack' }); return }
          let w = guests[o.g];
          if (!w) { if (o.k == 'ping') { pubAll(P + '/g/' + o.g, { k: 'bye' }); return } if (o.k == 'bye') return; w = guests[o.g] = relayWrap(x => pubAll(P + '/g/' + o.g, x), () => { delete guests[o.g] }); onconn(w); }
          w._in(o);
        });
      }).catch(() => { })));
      if (!conns.length) throw new Error('no relay server could be reached from this network');
      MP.relayUp = conns.length;
      return { close: () => { Object.values(guests).forEach(w => { try { w.close() } catch (e) { } }); conns.forEach(c => { try { c.end(true) } catch (e) { } }) } };
    },
    async join(code) {
      await loadMqtt(); const P = 'ttgolf/v1/' + code, gid = 'g' + Math.random().toString(36).slice(2, 10); let reached = false;
      for (const url of BROKERS) {
        let c; try { c = await mqttOpen(url, 5000) } catch (e) { continue }
        reached = true;
        const w = await new Promise(ok => {
          const t = setTimeout(() => ok(null), 3500); let ww = null;
          c.on('message', (tp, pl) => { let o; try { o = JSON.parse(pl.toString()) } catch (e) { return } if (o.k == 'ack' && !ww) { clearTimeout(t); ww = relayWrap(x => c.publish(P + '/h', JSON.stringify(Object.assign({ g: gid }, x)), { qos: 1 })); const cl = ww.close; ww.close = function () { cl.apply(this, arguments); try { c.end(true) } catch (e) { } }; ok(ww) } else if (ww) ww._in(o) });
          c.subscribe(P + '/g/' + gid, { qos: 1 }, () => c.publish(P + '/h', JSON.stringify({ k: 'probe', g: gid }), { qos: 1 }));
        });
        if (w) return w; try { c.end(true) } catch (e) { }
      }
      throw new Error(reached ? 'No game with that code. Check the code and that the host has opened the room.' : 'no relay server could be reached from this network');
    }
  };
  /* host listens on both routes; a guest tries the direct route first and starts the relay route if it is slow */
  const BothNet = {
    async host(code, onconn) {
      const [p, r] = await Promise.all([PeerNet.host(code, onconn).catch(e => ({ err: e })), RelayNet.host(code, onconn).catch(() => null)]);
      if (p && p.err) { if (p.err.type == 'unavailable-id' || !r) { if (r) r.close(); throw p.err } return { close: () => r.close() } }
      return { close: () => { try { p.close() } catch (e) { } if (r) r.close() } };
    },
    join(code) {
      return new Promise((ok, no) => {
        let done = false, fails = 0; const errs = [];
        const win = w => { if (done) { try { w.close() } catch (e) { } return } done = true; ok(w) };
        const fail = (e, which) => { errs.push([which, e]); if (++fails == 2 && !done) { done = true; const ng = errs.find(x => /No game/.test(x[1].message)); no(ng ? ng[1] : new Error('Could not connect to that room.\nDirect route: ' + ((errs.find(x => x[0] == 'direct') || [0, { message: 'not tried' }])[1].message) + '.\nRelay route: ' + ((errs.find(x => x[0] == 'relay') || [0, { message: 'not tried' }])[1].message) + '.')) } };
        PeerNet.join(code).then(win, e => fail(e, 'direct'));
        setTimeout(() => { if (!done) RelayNet.join(code).then(win, e => fail(e, 'relay')); else fails++ }, 2500);
      });
    }
  };
  MP.nets = { Peer: PeerNet, Relay: RelayNet, Both: BothNet };
  MP.net = BothNet;

  /* ---------- shared helpers ---------- */
  MP.snapS = () => snapS();
  const SKIP = ['an', 'res', 'tm', 'ct', 'mX', 'mY', 'mg', 'sn', 'rsKey', 'pkKey', 'pk', 'lastKind', 'finFx', 'hist', 'pop', 'intro', 'cf', 'dxHide', 'club', 'aim', 'tok'];
  function snapS() { const o = {}; for (const k in S) { if (!SKIP.includes(k) && typeof S[k] != 'function') o[k] = S[k] } return JSON.parse(JSON.stringify(o)); }
  function snapAll() { return { S: snapS(), COL: Object.assign({}, COL), wind: H.map(h => [h[2], h[3]]), course: S.course || 0, owners: MP.owners.slice() }; }
  const dxBusy = () => typeof DX != 'undefined' && !!DX.busy;
  const ctxNow = () => ({ club: S.club, aim: S.aim, tok: (S.tok || [0, 0, 0, 0, 0]).slice() });
  const me = () => MP.role == 'host' ? 'host' : MP.cid;
  const mine = i => !MP.role || !MP.started || MP.owners[i == null ? S.cur : i] === me();
  function idle(pred, max) { return new Promise(res => { const t0 = Date.now(); (function chk() { if ((!S.an && !(dxBusy()) && (!pred || pred())) || Date.now() - t0 > (max || 25000)) return res(); setTimeout(chk, 60) })() }) }
  const uniqName = (nm, except) => { const all = new Set(Object.values(MP.clients).filter(c => c.cid != except).map(c => c.name.toLowerCase())); [...document.querySelectorAll('#app .nm')].forEach(i => { if (!i.readOnly) all.add(i.value.trim().toLowerCase()) }); all.add('host'); let n = nm || 'Player', k = 1, b = n; while (all.has(n.toLowerCase())) n = b.slice(0, 12) + ' ' + (++k); return n; };

  /* ---------- UI ---------- */
  function css() {
    if ($q('#mpcss')) return; const st = document.createElement('style'); st.id = 'mpcss';
    st.textContent = `.mpc small,.mpd small{opacity:.8}.mpc .mpcode{font:900 34px/1 ui-monospace,monospace;letter-spacing:6px;padding:4px 10px;border-radius:10px;background:color-mix(in srgb,var(--ac,#e52521) 14%,transparent);display:inline-block;margin:4px 0}
.mpc .mpl{margin:6px 0;display:flex;flex-wrap:wrap;gap:6px}.mpc .mpl span{padding:3px 10px;border-radius:999px;border:2px solid var(--ln,#333);font-weight:800}.mpc .mpl span.off{opacity:.45}
.mpd{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:12px}.mpd .p{max-width:420px;width:100%;box-sizing:border-box;margin:0}.mpd input{width:100%;box-sizing:border-box;margin:3px 0 8px;font-size:18px}
.mplk{margin:8px 0}.mplk .avg{grid-template-columns:repeat(auto-fill,minmax(78px,1fr));max-height:230px;overflow:auto}.mplk .avg button.on{outline:3px solid var(--ac,#e52521)}.mplk .avg span{font-size:11px}.mpsw{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}.mpsw button{width:38px;height:38px;border-radius:50%;border:3px solid var(--ln,#333);padding:0;margin:0}.mpsw button.on{outline:3px solid var(--ac,#e52521);outline-offset:2px}.mpsw button:disabled{opacity:.25}
.mpd .mpcin{text-transform:uppercase;letter-spacing:6px;text-align:center;font-size:26px}.mpd .mpe{color:var(--pen,#c00);font-weight:800;min-height:1.2em;white-space:pre-line}
.mpbn{margin:0 0 8px;padding:8px 12px;border-radius:12px;border:3px dashed var(--ln,#333);background:color-mix(in srgb,var(--act,#ffd200) 35%,var(--pn,#fff));color:var(--ink,#000);font-weight:800;text-align:center}
#app.mpwait .swb{pointer-events:none;opacity:.5;filter:grayscale(.4)}
.mpguest #top button[onclick^="S.cf"],.mpon #top button[onclick="undo()"]{display:none!important}
.mpon #top .mpst{font-weight:800;padding:0 6px}`;
    document.head.appendChild(st);
  }
  function dlg(html) { closeDlg(); const d = document.createElement('div'); d.className = 'mpd'; d.id = 'mpd'; d.innerHTML = '<div class="p">' + html + '</div>'; document.body.appendChild(d); return d; }
  function closeDlg() { const d = $q('#mpd'); if (d) d.remove(); }
  const rowsNm = () => [...document.querySelectorAll('#app .row')].filter(e => e.querySelector('.nm'));
  function rowOf(c) { const k = MP.slots.indexOf(c.cid); return k >= 0 ? rowsNm()[k] : null }
  const rowLook = r => ({ av: +r.querySelector('.avb').dataset.av, col: r.querySelector('.cl').value });
  function takenBy(except) { const av = [], col = []; rowsNm().forEach(r => { if (r === except || !r.querySelector('.nm').value.trim()) return; const l = rowLook(r); av.push(l.av); col.push(l.col) }); return { av, col } }
  function lobbyFor(c) { const r = rowOf(c); return { t: 'lobby', names: joinedList(), me: r ? rowLook(r) : null, taken: takenBy(r) } }
  function bcastLobby() { Object.values(MP.clients).forEach(c => { if (c.on && c.w) c.w.send(lobbyFor(c)) }) }
  function setRowLook(r, av, col) { const b = r.querySelector('.avb'); b.dataset.av = av; b.innerHTML = AV.face(av); b.title = AV.name(av); r.querySelector('.cl').value = col }
  function onLook(c, m) {
    const r = rowOf(c); if (!r || MP.started) return; const t = takenBy(r), L = rowLook(r); let av = L.av, col = L.col;
    if (Number.isInteger(m.av) && m.av >= 0 && m.av < AV.L.length && !t.av.includes(m.av)) av = m.av;
    if (typeof m.col == 'string' && CL.some(x => x[1] == m.col) && !t.col.includes(m.col)) col = m.col;
    setRowLook(r, av, col); c.look = { av, col }; bcastLobby();
  }
  let lastLobbySig = '';
  setInterval(() => { try { if (MP.role == 'host' && !MP.started && S.ph == 'setup') { const sig = JSON.stringify(Object.values(MP.clients).map(c => lobbyFor(c))); if (sig != lastLobbySig) { lastLobbySig = sig; bcastLobby() } } } catch (e) { } }, 1500);
  function joinedList() { const l = [{ name: 'Host', on: true }]; Object.values(MP.clients).forEach(c => l.push({ name: c.name, on: c.on })); return l; }

  function setupCard() {   // host-side card on the tee-up screen, and the guest lobby
    const app = $q('#app'); if (!app) return;
    if (MP.role == 'guest') { guestLobby(); return; }
    const old = $q('#app .mpr'); if (old) old.remove();
    const sv = !MP.role && readJoin();
    if (sv) { const r = $q('#app .rsm'); if (r) r.remove(); app.insertAdjacentHTML('afterbegin', '<div class="p mpr"><div class="big">📱 Game in progress</div><p>You were playing in room <b>' + esc(sv.code) + '</b> as <b>' + esc(sv.name) + '</b>.</p><button class="on" onclick="TTG_MP.rejoin()">Rejoin the game</button> <button onclick="TTG_MP.forget()">Forget it</button><div class="mpe" id="mprm"></div></div>') }
    else if (!MP.role) { const r = $q('#app .rsm'); let d = null; try { d = gameLoad() } catch (e) { } if (r && d && d.mp) { const p = r.querySelector('p'); if (p) p.insertAdjacentHTML('beforeend', '<br><small>Reopens room ' + esc(d.mp.code) + '. Friends reconnect on their own.</small>') } }
    let card = $q('#app .mpc'); if (card) card.remove();
    let h = '<div class="p mpc"><div class="big">📱 Play on separate devices</div>';
    if (MP.role == 'host') {
      const link = location.href.split('#')[0].split('?')[0] + '?join=' + MP.code;
      h += '<p>Share this code or link. Friends open the game, tap <b>Join a game</b> and type the code.</p><div class="mpcode">' + MP.code + '</div><p><small>' + esc(link) + '</small></p><p><button onclick="TTG_MP.copy()">Copy link</button><button onclick="TTG_MP.close()">Close room</button></p><div class="mpl">' + joinedList().map(x => '<span class="' + (x.on ? '' : 'off') + '">📱 ' + esc(x.name) + '</span>').join('') + '</div><p><small>' + esc(MP.info) + ' · version ' + MP.ver + '</small></p><p><small>Each friend takes the next free name slot below. Fill the rest yourself for anyone sharing your device. Press Start when everyone is in.</small></p>';
    } else {
      h += '<p>Everyone plays on their own phone or tablet. One person hosts, everyone else joins with a room code.</p><button class="on" onclick="TTG_MP.host()">Host a game</button><button onclick="TTG_MP.joinDlg()">Join a game</button>';
    }
    app.insertAdjacentHTML('afterbegin', h + '<div class="mpe" id="mpe"></div></div>');
  }
  function guestLobby() {
    const app = $q('#app'); if (!app || MP.started) return;
    const saved = MP.connected ? '' : '<p class="mpe">Disconnected. <button class="on" onclick="TTG_MP.rejoin()">Reconnect</button></p>';
    app.innerHTML = '<div class="p mpc"><div class="big">📱 You are in room ' + esc(MP.code) + '</div><p>You are playing as <b>' + esc(MP.myname || '') + '</b>. Waiting for the host to start the round…</p><div class="mpl">' + (MP.names || []).map(x => '<span class="' + (x.on ? '' : 'off') + '">📱 ' + esc(x.name) + '</span>').join('') + '</div>' + lookUI() + saved + '<p><button onclick="TTG_MP.leave()">Leave game</button></p></div>';
  }
  function lookUI() {
    if (!MP.me || typeof AV == 'undefined') return ''; const tk = MP.taken || { av: [], col: [] }, me = MP.me;
    return '<div class="mplk"><b>Pick your golfer</b><div class="avg">' + AV.L.map((a, j) => '<button type="button" class="' + (me.av === j ? 'on' : '') + '" ' + (tk.av.includes(j) ? 'disabled title="Taken"' : '') + ' onclick="TTG_MP.look(\'av\',' + j + ')">' + AV.face(j) + '<span>' + esc(a.n) + (tk.av.includes(j) ? ' · taken' : '') + '</span></button>').join('') + '</div>'
      + '<b>Pick your ball color</b><div class="mpsw">' + CL.map(c => '<button type="button" class="' + (me.col === c[1] ? 'on' : '') + '" ' + (tk.col.includes(c[1]) ? 'disabled' : '') + ' title="' + esc(c[0]) + (tk.col.includes(c[1]) ? ' (taken)' : '') + '" aria-label="' + esc(c[0]) + '" style="background:' + c[1] + '" onclick="TTG_MP.look(\'col\',\'' + c[1] + '\')"></button>').join('') + '</div></div>';
  }
  MP.look = function (k, v) { if (MP.role != 'guest' || !MP.connected) return; const me = Object.assign({}, MP.me || {}); me[k] = v; MP.me = me; MP.w.send({ t: 'look', av: me.av, col: me.col }); guestLobby() };
  function applyLobby() {
    rowsNm().forEach((r, k) => {
      const i = r.querySelector('.nm'), cid = MP.slots[k], c = cid && MP.clients[cid];
      if (c) { i.value = c.name; i.readOnly = true; i.title = 'Playing on their own device'; if (c.look) setRowLook(r, c.look.av, c.look.col) } else if (i.readOnly) { i.readOnly = false; i.value = ''; i.title = '' }
    });
  }
  function banner() {
    const app = $q('#app'); if (!app) return; const old = $q('#app .mpbn'); if (old) old.remove();
    app.classList.remove('mpwait'); document.documentElement.classList.toggle('mpon', !!MP.role); document.documentElement.classList.toggle('mpguest', MP.role == 'guest');
    if (MP.role == 'host' && MP.started && MP.hostMsg) app.insertAdjacentHTML('afterbegin', '<div class="mpbn">' + esc(MP.hostMsg) + '</div>');
    if (!MP.role || !MP.started || (S.ph != 'play')) return;
    const locked = !mine(), p = S.P[S.cur]; if (!p) return;
    if (locked) {
      app.classList.add('mpwait');
      const cl = MP.clients[MP.owners[S.cur]], off = MP.role == 'host' && cl && !cl.on;
      app.insertAdjacentHTML('afterbegin', '<div class="mpbn">⏳ Waiting for ' + esc(p.nm) + (cl ? ' (' + esc(cl.name) + ')' : '') + (off ? ' — their device is offline' : '') + '…' + (MP.role == 'host' ? ' <button onclick="TTG_MP.takeover()">Take over this player</button>' : '') + '</div>');
    } else if (MP.pending) {
      app.classList.add('mpwait');
    }
  }
  const render_mp = render;
  render = function () {
    // the "your turn" card is only for the player whose turn it is
    let t0, quiet = false; try { quiet = MP.role && MP.started && S.ph == 'play' && !mine(S.cur) && typeof GS != 'undefined' && GS.pop; if (quiet) { t0 = GS.pop.turn; GS.pop.turn = false } } catch (e) { quiet = false }
    try { render_mp.apply(this, arguments) } finally { if (quiet) GS.pop.turn = t0 }
    try {
      css();
      if (S.ph == 'setup') {
        if (MP.role && MP.started) { MP.started = false; if (MP.role == 'host') bcastLobby() }
        if (MP.role == 'host') { setupCard(); applyLobby() } else setupCard();
      } else banner();
      if (MP.role == 'guest' && S.ph != 'setup') document.querySelectorAll('#app button').forEach(b => { if (/New Game|New Round/.test(b.textContent)) b.style.display = 'none' });
    } catch (e) { console.error(e) }
  };
  const gs0 = window.gameSave;
  window.gameSave = function () {
    if (MP.role == 'guest') return;
    const r = gs0 && gs0.apply(this, arguments);
    if (MP.role == 'host' && MP.started) { try { const d = JSON.parse(localStorage.getItem(SAVEK) || 'null'); if (d) { d.mp = { code: MP.code, owners: MP.owners, n: MP.n, clients: Object.values(MP.clients).map(c => ({ cid: c.cid, name: c.name })) }; localStorage.setItem(SAVEK, JSON.stringify(d)) } } catch (e) { } }
    return r;
  };
  const gr0 = window.gameResume;
  window.gameResume = function () { let d = null; try { d = gameLoad() } catch (e) { } const r = gr0.apply(this, arguments); if (d && d.mp && !MP.role) restoreHost(d.mp); return r };
  async function restoreHost(mp) {
    MP.code = mp.code; MP.role = 'host'; MP.owners = mp.owners || []; MP.n = mp.n || 0; MP.clients = {}; MP.slots = []; MP.started = true; MP.seq = 0; MP.relayUp = 0;
    (mp.clients || []).forEach(c => { MP.clients[c.cid] = { cid: c.cid, name: c.name, on: false, w: null } });
    MP.hostMsg = 'Reopening room ' + mp.code + '… your friends will reconnect on their own.'; try { banner() } catch (e) { }
    for (let i = 0; i < 25 && MP.role == 'host'; i++) {
      try { MP.srv = await MP.net.host(mp.code, onConn); MP.info = 'Direct: ready · Relay: ' + (MP.relayUp ? MP.relayUp + ' of 3 servers connected' : 'not connected (this network blocks it)'); MP.hostMsg = 'Room ' + mp.code + ' is open again.'; banner(); setTimeout(() => { MP.hostMsg = ''; try { banner() } catch (e) { } }, 6000); return }
      catch (e) { await new Promise(r => setTimeout(r, 2500)) }
    }
    MP.hostMsg = 'Could not reopen room ' + mp.code + '. Check your connection, then reload and resume again.'; try { banner() } catch (e) { }
  }

  /* shot-result card: everyone sees it; only the player who just shot gets the buttons, and it closes for all when they choose */
  const resPop0 = window.resPop;
  window.resPop = function () {
    let h = resPop0.apply(this, arguments);
    if (!MP.role || !MP.started) return h;
    if (mine(S.last)) return h.replace('onclick="S.res=null;render()"', 'onclick="TTG_MP.resDone()"');
    const i = h.indexOf('<div class="rbt">'); if (i < 0) return h;
    const p = S.P[S.last];
    return h.slice(0, i) + '<div class="rbt"><small>Waiting for ' + esc(p ? p.nm : 'the player') + '…</small></div></div></div>';
  };
  MP.resDone = function () {
    S.res = null;
    if (MP.role == 'host') bcast({ t: 'resdone' }); else if (MP.role == 'guest' && MP.connected) MP.w.send({ t: 'req', name: 'resdone' });
    render();
  };

  /* ---------- host ---------- */
  const randCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++)s += A[Math.floor(Math.random() * A.length)]; return s };
  function bcast(m, except) { Object.values(MP.clients).forEach(c => { if (c.on && c.w && c.cid != except) c.w.send(m) }) }
  const sendTo = (c, m) => { if (c.on && c.w) c.w.send(m) };
  MP.host = async function () {
    if (MP.role) return;
    MP.relayUp = 0;
    try {
      for (let tries = 0; tries < 5; tries++) {
        const code = randCode();
        try { MP.srv = await MP.net.host(code, onConn); MP.code = code; break } catch (e) { if (!(e && e.type == 'unavailable-id')) throw e }
      }
      if (!MP.code) throw new Error('Could not open a room. Try again.');
      MP.info = 'Direct: ready · Relay: ' + (MP.relayUp ? MP.relayUp + ' of 3 servers connected' : 'not connected (this network blocks it)'); MP.role = 'host'; MP.owners = []; MP.clients = {}; MP.slots = []; MP.started = false; S.ph == 'setup' && render();
    } catch (e) { const el = $q('#mpe'); if (el) el.textContent = (e && e.message) || 'Could not open a room.'; }
  };
  MP.close = function () { try { MP.srv && MP.srv.close() } catch (e) { } Object.values(MP.clients).forEach(c => { try { c.w.send({ t: 'bye', why: 'The host closed the room.' }); c.w.close() } catch (e) { } }); MP.role = null; MP.clients = {}; MP.slots = []; MP.owners = []; MP.started = false; MP.code = ''; document.documentElement.classList.remove('mpon', 'mpguest'); const a = $q('#app'); if (a) a.classList.remove('mpwait'); render(); };
  MP.copy = function () { const link = location.href.split('#')[0].split('?')[0] + '?join=' + MP.code; try { navigator.clipboard.writeText(link); const el = $q('#mpe'); if (el) el.textContent = 'Link copied.' } catch (e) { } };
  function onConn(w) {
    w.onmsg = m => { try { hostMsg(w, m) } catch (e) { console.error(e) } };
    w.onclose = () => { const c = w._cl; if (!c || c.w !== w) return; c.on = false; if (!MP.started) { const k = MP.slots.indexOf(c.cid); if (k >= 0) MP.slots[k] = null; delete MP.clients[c.cid]; if (S.ph == 'setup') applyLobby() } bcastLobby(); S.ph == 'setup' ? setupCard() : banner() };
  }
  function hostMsg(w, m) {
    if (!m || typeof m != 'object') return;
    if (m.t == 'hello') return onHello(w, m);
    const c = w._cl; if (!c) return;
    if (m.t == 'req') return onReq(c, m);
    if (m.t == 'look') return onLook(c, m);
  }
  function onHello(w, m) {
    let name = clean(m.name) || 'Player', c = null;
    if (m.cid && MP.clients[m.cid]) { c = MP.clients[m.cid]; c.w = w; c.on = true }
    else if (MP.started) {
      const i = S.P.findIndex((p, j) => p.nm.toLowerCase() == name.toLowerCase() && MP.owners[j] != 'host' && !(MP.clients[MP.owners[j]] && MP.clients[MP.owners[j]].on));
      if (i < 0) { w.send({ t: 'deny', why: 'That round has already started and there is no open seat under the name "' + name + '".' }); return }
      const old = MP.owners[i]; c = MP.clients[old] || { cid: old, name: S.P[i].nm }; c.w = w; c.on = true; MP.clients[c.cid] = c;
    } else {
      if (Object.keys(MP.clients).length >= 5) { w.send({ t: 'deny', why: 'This room is full (6 players).' }); return }
      const cid = 'c' + (++MP.n); name = uniqName(name); c = { cid, name, on: true, w };
      const rows = rowsNm(); let k = -1; for (let j = 1; j < Math.max(rows.length, 6); j++) { if (!MP.slots[j]) { k = j; break } }
      if (k < 0) { w.send({ t: 'deny', why: 'This room is full.' }); return }
      MP.slots[k] = cid; MP.clients[cid] = c;
    }
    w._cl = c; c.w = w;
    w.send({ t: 'welcome', cid: c.cid, name: c.name, started: MP.started });
    if (MP.started) w.send({ t: 'begin', snap: snapAll(), names: joinedList(), n: MP.seq });
    bcastLobby();
    if (S.ph == 'setup') { applyLobby(); setupCard() } else banner();
  }
  function onReq(c, m) {
    if (!MP.started || !c) return;
    if (m.name == 'resync') { sendTo(c, { t: 'snap', snap: snapAll(), force: 1, n: MP.seq }); return }
    if (m.name == 'resdone') { if (MP.owners[S.last] == c.cid && S.res) { S.res = null; bcast({ t: 'resdone' }, c.cid); render() } return }
    if (m.name == 'next') { if (S.ph == 'holedone') { MP.force = true; try { window.next() } finally { MP.force = false } } return }
    if (m.name == 'swing') {
      if (S.ph != 'play' || MP.owners[S.cur] != c.cid || (dxBusy())) return;
      const x = m.ctx || {}; S.club = x.club | 0; S.aim = x.aim | 0; S.tok = (x.tok || [0, 0, 0, 0, 0]).map(v => v ? 1 : 0); S.pk = 1; MP.force = true; try { window.swing() } finally { MP.force = false } return;
    }
    if (m.name == 'mull') { const i = +(m.args || [])[0]; if (MP.owners[i] == c.cid) { MP.force = true; try { window.mull(i) } finally { MP.force = false } } }
  }
  MP.takeover = function () { if (MP.role != 'host' || !MP.started) return; MP.owners[S.cur] = 'host'; bcast({ t: 'owners', owners: MP.owners }); render() };

  /* host: wrap the actions that change the game, so every shot is broadcast with its dice */
  function hostWrap(name, ok) {
    const f = window[name];
    window[name] = function () {
      if (MP.role != 'host' || !MP.started || MP.replay) return f.apply(this, arguments);
      const g = ok.apply(null, arguments); if (g === 2) return f.apply(this, arguments); if (!g) return;
      const args = [...arguments], ctx = ctxNow(); window.MPL = []; MP.hb = (MP.hb || 0) + 1;
      let r; try { r = f.apply(this, args) } finally {
        const rolls = (window.MPL || []).slice(); window.MPL = null;
        bcast({ t: 'act', name, args, rolls, ctx, n: ++MP.seq });
      }
      Promise.resolve(r).then(() => idle(name == 'next' ? () => S.ph != 'holedone' : null)).then(() => { bcast({ t: 'snap', snap: snapAll(), n: ++MP.seq }); MP.hb--; }, () => { MP.hb-- });
      return r;
    };
  }
  hostWrap('swing', () => S.ph != 'play' ? 0 : !S.pk ? (MP.force || mine() ? 2 : 0) : dxBusy() ? 0 : (MP.force || mine()) ? 1 : 0);
  hostWrap('mull', i => MP.force || mine(i));
  hostWrap('next', () => S.ph == 'holedone');

  const setup0 = window.setup;
  window.setup = function () {
    if (MP.role != 'host') return setup0.apply(this, arguments);
    const rows = rowsNm().map((r, k) => [capWords(r.querySelector('.nm').value.trim().replace(/[<>&"]/g, '')), k]).filter(x => x[0]);
    const owners = rows.map(x => MP.slots[x[1]] && MP.clients[MP.slots[x[1]]] ? MP.slots[x[1]] : 'host');
    setup0.apply(this, arguments);
    if (S.ph == 'setup' && !dxBusy()) return;   // refused (for example duplicate names)
    idle(() => S.ph == 'play').then(() => { if (S.ph != 'play') return; MP.owners = owners; MP.started = true; MP.seq = 0; bcast({ t: 'begin', snap: snapAll(), names: joinedList(), n: MP.seq }); render() });
  };

  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 };
  setInterval(() => { try { if (MP.role == 'host' && MP.started && !MP.hb && !S.an && !dxBusy() && S.ph != 'setup') bcast({ t: 'ver', n: MP.seq, h: hash(JSON.stringify(snapS())) }) } catch (e) { } }, 3000);

  /* ---------- guest ---------- */
  MP.joinDlg = function (code) {
    css(); let sv = {}; try { sv = JSON.parse(localStorage.getItem(SAVEJ) || '{}') } catch (e) { }
    dlg('<div class="big">Join a game</div><small>Room code from the host</small><input id="mpc" class="mpcin" maxlength="4" autocapitalize="characters" autocomplete="off" value="' + esc(code || '') + '"><small>Your name</small><input id="mpn" maxlength="14" autocomplete="off" value="' + esc(sv.name || '') + '"><div class="mpe" id="mpje"></div><button class="on" onclick="TTG_MP.join()">Join</button><button onclick="TTG_MP.dlgClose()">Cancel</button><p><small>version ' + MP.ver + '</small></p>');
    const i = $q('#mpc'); if (i) { i.addEventListener('input', () => { i.value = i.value.toUpperCase().replace(/[^A-Z]/g, '') }); setTimeout(() => (code ? $q('#mpn') : i).focus(), 50) }
  };
  MP.dlgClose = closeDlg;
  MP.join = async function (code, name) {
    code = (code || ($q('#mpc') || {}).value || '').toUpperCase().trim(); name = clean(name || ($q('#mpn') || {}).value);
    const err = t => { const e = $q('#mpje'); if (e) e.textContent = t; };
    if (code.length != 4) return err('Enter the 4-letter room code.'); if (!name) return err('Enter your name.');
    err('Connecting…');
    try { await connect(code, name, null); closeDlg() } catch (e) { err((e && e.message) || 'Could not connect.') }
  };
  function connect(code, name, cid) {
    return new Promise(async (ok, no) => {
      let w; try { w = await MP.net.join(code) } catch (e) { return no(e) }
      let done = false;
      w.onmsg = m => { try { if (m && m.t == 'welcome' && !done) { done = true; ok() } if (m && m.t == 'deny' && !done) { done = true; MP.role = null; MP.connected = false; MP.w = null; try { w.close() } catch (e) { } no(new Error(m.why)); return } guestMsg(w, m) } catch (e) { console.error(e) } };
      w.onclose = () => { if (MP.w !== w) return; MP.connected = false; if (!done) { done = true; no(new Error('Connection closed.')) } if (S.ph == 'setup' || !MP.started) guestLobby(); else bannerOff(); autoRejoin() };
      MP.w = w; MP.code = code; MP.myname = name; MP.role = 'guest'; MP.connected = true;
      try { localStorage.setItem(SAVEJ, JSON.stringify({ code, name, cid: cid || MP.cid || '', t: Date.now() })) } catch (e) { }
      w.send({ t: 'hello', name, cid: cid || MP.cid || '' });
      setTimeout(() => { if (!done) { done = true; no(new Error('The host did not answer.')) } }, 12000);
    });
  }
  MP.rejoin = async function () {
    let sv = {}; try { sv = JSON.parse(localStorage.getItem(SAVEJ) || '{}') } catch (e) { } if (!sv.code) return 'nothing saved';
    const el = $q('#mprm'); if (el) el.textContent = 'Connecting…';
    try { await connect(sv.code, sv.name, sv.cid || MP.cid); if (el) el.textContent = ''; return '' } catch (e) { MP.connected = false; const a = $q('#mprm') || $q('#app .mpe'); if (a) a.textContent = e.message; return e.message || 'failed' }
  };
  function autoRejoin() {
    if (MP.rj || MP.role != 'guest') return; MP.rj = true;
    (async () => { for (let i = 0; i < 40 && MP.role == 'guest' && !MP.connected; i++) { await new Promise(r => setTimeout(r, i ? 4000 : 1200)); if (MP.role != 'guest' || MP.connected) break; const e = await MP.rejoin(); if (!e) break; if (/no open seat|room is full/.test(e)) break } MP.rj = false })();
  }
  const readJoin = () => { try { const d = JSON.parse(localStorage.getItem(SAVEJ) || 'null'); return d && d.code && Date.now() - d.t < 432e5 ? d : null } catch (e) { return null } };
  MP.forget = function () { try { localStorage.removeItem(SAVEJ) } catch (e) { } render() };
  MP.leave = function () { try { MP.w && MP.w.send({ t: 'bye' }); MP.w && MP.w.close() } catch (e) { } MP.w = null; MP.role = null; MP.started = false; MP.code = ''; try { localStorage.removeItem(SAVEJ) } catch (e) { } document.documentElement.classList.remove('mpon', 'mpguest'); S.ph = 'setup'; render(); };
  function bannerOff() { const app = $q('#app'); if (!app) return; const o = $q('#app .mpbn'); if (o) o.remove(); app.classList.add('mpwait'); app.insertAdjacentHTML('afterbegin', '<div class="mpbn">⚠ Disconnected from the host. <button class="on" onclick="TTG_MP.rejoin()">Reconnect</button></div>') }
  function guestMsg(w, m) {
    if (!m || typeof m != 'object') return;
    if (m.t == 'welcome') { MP.cid = m.cid; MP.myname = m.name; try { localStorage.setItem(SAVEJ, JSON.stringify({ code: MP.code, name: m.name, cid: m.cid, t: Date.now() })) } catch (e) { } if (!m.started && S.ph != 'setup') { S.ph = 'setup'; render() } else if (S.ph == 'setup') guestLobby(); return }
    if (m.t == 'lobby') { MP.names = m.names || []; MP.me = m.me || MP.me; MP.taken = m.taken || { av: [], col: [] }; if (MP.started && S.ph == 'end') { MP.started = false; S.ph = 'setup'; render() } else if (!MP.started) guestLobby(); return }
    if (m.t == 'owners') { MP.owners = m.owners || []; if (MP.started) render(); return }
    if (m.t == 'bye') { MP.connected = false; MP.role = null; MP.started = false; try { localStorage.removeItem(SAVEJ) } catch (e) { } S.ph = 'setup'; render(); const a = $q('#app'); if (a) a.insertAdjacentHTML('afterbegin', '<div class="mpbn">' + esc(m.why || 'The host left.') + '</div>'); return }
    if (m.t == 'ver') {
      if (MP.busy || MP.q.length || S.an || dxBusy() || !MP.started) { MP.mm = 0; return }
      const bad = m.n !== MP.lastN || hash(JSON.stringify(snapS())) !== m.h;
      if (bad) { if (++MP.mm >= 2) { MP.mm = 0; resync() } } else MP.mm = 0; return;
    }
    if (m.t == 'snap' && m.force) { MP.q.length = 0; window.MPQ = null; MP.replay = false; S.an = null; MP.lastN = m.n; MP.pending = false; applySnap(m.snap, false); banner(); return }
    if ((m.t == 'act' || m.t == 'snap') && MP.started) { if (MP.lastN != null && m.n !== MP.lastN + 1) resync(); MP.lastN = m.n }
    if (m.t == 'begin') MP.lastN = m.n;
    if (m.t == 'begin' || m.t == 'act' || m.t == 'snap' || m.t == 'resdone') { MP.q.push(m); drain() }
  }
  function resync() { if (!MP.w || !MP.connected || Date.now() - (MP.lastRs || 0) < 4000) return; MP.lastRs = Date.now(); MP.w.send({ t: 'req', name: 'resync' }) }
  async function drain() {
    if (MP.busy) return; MP.busy = true;
    try {
      while (MP.q.length) {
        const m = MP.q.shift();
        if (m.t == 'begin') { applySnap(m.snap, true); MP.names = m.names || MP.names; MP.started = true; { const fresh = S.P.every(p => !p.st); S.intro = fresh ? 1 : 0; S.pop = fresh ? 1 : 0 } S.cf = 0; S.pk = 0; S.tok = [0, 0, 0, 0, 0]; S.club = 0; S.aim = 0; S.an = null; if (!Array.isArray(S.hist)) S.hist = []; clr(); render() }
        else if (m.t == 'act') {
          if (!MP.started) continue; MP.pending = false;
          if (!Array.isArray(S.hist)) S.hist = [];
          if (m.name == 'swing') { const x = m.ctx || {}; S.club = x.club | 0; S.aim = x.aim | 0; S.tok = (x.tok || [0, 0, 0, 0, 0]).slice(); S.pk = 1 }
          window.MPQ = (m.rolls || []).slice(); MP.replay = true; let r;
          try { r = window[m.name].apply(null, m.args || []) } catch (e) { console.error(e) } finally { MP.replay = false }
          try { await Promise.resolve(r) } catch (e) { }
          await idle(m.name == 'next' ? () => S.ph != 'holedone' : null); window.MPQ = null;
        }
        else if (m.t == 'snap') { await idle(); applySnap(m.snap, false) }
        else if (m.t == 'resdone') { await idle(); if (S.res) { S.res = null; render() } }
      }
    } finally { MP.busy = false; window.MPQ = null }
  }
  function applySnap(d, full) {
    if (!d || !d.S) return;
    MP.owners = d.owners || MP.owners;
    if (full) { useCourse(d.course || 0) }
    (d.wind || []).forEach((w, i) => { if (H[i] && w) { H[i][2] = w[0]; H[i][3] = w[1] } });
    Object.keys(COL).forEach(k => delete COL[k]); Object.assign(COL, d.COL || {});
    if (!full && JSON.stringify(snapS()) === JSON.stringify(d.S)) { banner(); return }   // already identical
    if (!full) MP.fixes = (MP.fixes || 0) + 1;
    Object.assign(S, d.S); S.an = null; S.res = null; if (!Array.isArray(S.tok)) S.tok = [0, 0, 0, 0, 0]; if (!Array.isArray(S.hist)) S.hist = []; if (!full) render();
  }
  /* what a guest's controls send instead of acting locally */
  function guestWrap(name, build) {
    const f = window[name];
    window[name] = function () {
      if (MP.role != 'guest' || !MP.started || MP.replay) return f.apply(this, arguments);
      const m = build.apply(null, arguments); if (!m || !MP.connected) return;
      MP.pending = true; clearTimeout(MP.pt); MP.pt = setTimeout(() => { MP.pending = false; banner() }, 8000); MP.w.send({ t: 'req', name, args: m.args || [], ctx: m.ctx }); banner();
    };
  }
  guestWrap('swing', () => (S.ph == 'play' && S.pk && mine() && !MP.pending) ? { ctx: ctxNow() } : null);
  guestWrap('mull', i => (mine(i) && !MP.pending) ? { args: [i] } : null);
  guestWrap('next', () => S.ph == 'holedone' ? {} : null);

  /* a link like ...?join=ABCD opens the join box */
  try { const c = new URLSearchParams(location.search).get('join'); if (c) setTimeout(() => { if (S.ph == 'setup' && !MP.role) MP.joinDlg(c.toUpperCase().slice(0, 4)) }, 600); } catch (e) { }
  try { if (S.ph == 'setup') render() } catch (e) { }
})();
