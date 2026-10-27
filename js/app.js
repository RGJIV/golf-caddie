/* Golf caddie: the call for where you stand, offline.
   © 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const r = Math.round;
  const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  // ---- saved settings (this phone only) ----
  const FACTORS = { "58 deg": 0.67, "54 deg": 0.70, "48 deg": 0.75, PW: 0.78, "9i": 0.81, "8i": 0.84, "7i": 0.84, "6i": 0.87,
    "5i": 0.93, "4i": 0.97, "5 hybrid": 1.0, "3 wood": 1.07, Driver: 1.26 };
  const ORDER = Object.keys(FACTORS);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("gc-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("gc-" + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  // Richard's numbers (about 75°F). Built in so the app works on first open; change them in Settings any time.
  const DEFAULT_CLUBS = [["58 deg", 80], ["54 deg", 100], ["48 deg", 120], ["PW", 140], ["9i", 150], ["8i", 160],
    ["7i", 170, 0.90], ["6i", 180, 0.88], ["5i", 190, 0.85], ["4i", 200, 0.80], ["5 hybrid", 230, 0.75], ["3 wood", 260, 0.66], ["Driver", 280, 0.25]]
    .map(([club, carry, fairway]) => ({ club, carry, factor: FACTORS[club], fairway: fairway == null ? null : fairway }));
  let S = store.get("settings", null) || { clubs: [], teeSet: "IV/III", competition: false, temp: null, wind: null };
  if (!S.clubs || !S.clubs.length) { S.clubs = DEFAULT_CLUBS; store.set("settings", S); }

  // setup link: #setup=<base64 json> puts the club numbers on this phone, then leaves the address bar clean
  if (location.hash.startsWith("#setup=")) {
    try {
      const d = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7)))));
      S.clubs = d.clubs.map(([club, carry, fairway]) => ({ club, carry, factor: FACTORS[club] || 1, fairway: fairway == null ? null : fairway }));
      if (d.teeSet) S.teeSet = d.teeSet;
      store.set("settings", S);
    } catch (e) { alertBar("That setup link did not read. Ask for a new one."); }
    history.replaceState(null, "", location.pathname);
  }

  // ---- course ----
  const { C, grids, toLocal, toLatLon } = await GCGeo.loadCourse("data");
  const E = new GCEngine(grids);
  const holes = C.holes;
  $("loading").hidden = true;

  // ---- state ----
  let fix = null;          // {p:[x,z], acc ft, t}
  let holeN = store.get("hole", 1), manualUntil = 0;
  let pinSpot = "M", lie = "fairway";
  let lieManual = null;    // {lie, p}: a tapped lie, kept until you walk 10 yd away; otherwise the lie comes from the fairway map
  let openLine = null;     // {p}: "I can see the green" for the shot from this spot (trees ignored), until you walk 10 yd away
  let hold = null, still = null;   // hold {p}: the spot the call is held for; still {t, pts}: GPS fixes while standing
  const recent = [];       // last 3 fixes, averaged to tell walking away from GPS wobble
  let teeMemo = { key: null, plan: null };
  let last = null;         // last plan
  const offCourse = () => !fix || Math.min(...holes.map((h) => distToHole(fix.p, h))) > 900;

  function teeFor(h) {
    const set = S.teeSet;
    const name = h.combo && h.combo[set] ? h.combo[set] : set;
    return { name, ...(h.tees[name] || h.tees.V) };
  }
  function distToHole(p, h) {
    const pts = [teeFor(h).p, ...h.line.slice(1)];
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) m = Math.min(m, segDist(p, pts[i], pts[i + 1]));
    Object.values(h.tees).forEach((t) => (m = Math.min(m, hyp(p, t.p))));
    return m;
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
  }
  function autoHole() {
    if (!fix || offCourse() || Date.now() < manualUntil) return;
    const cur = holes[holeN - 1], dCur = distToHole(fix.p, cur);
    // on a tee box of another hole: that is the hole you are playing
    for (const h of holes) if (h.n !== holeN && Object.values(h.tees).some((t) => hyp(fix.p, t.p) < 45)) { setHole(h.n); return; }
    if (dCur < 150) return;
    let best = cur, bd = dCur;
    holes.forEach((h) => { const d = distToHole(fix.p, h); if (d < bd - 60) { best = h; bd = d; } });
    if (best !== cur) setHole(best.n);
  }
  function setHole(n) { holeN = ((n - 1 + 18) % 18) + 1; store.set("hole", holeN); pinSpot = "M"; lieManual = null; openLine = null; render(); }

  // the green along your line to it: front edge, center and back edge (from the traced outline; 8 yd either side without one)
  function greenAxis(h, from) {
    const g = h.green, d = hyp(from, g) || 1, u = [(g[0] - from[0]) / d, (g[1] - from[1]) / d];
    const edge = (dir) => {                    // distance from the center to the outline along dir
      const P = h.greenPoly; if (!P) return 24;
      let best = Infinity;
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ez = b[1] - a[1];
        const den = dir[0] * ez - dir[1] * ex; if (Math.abs(den) < 1e-9) continue;
        const t = ((a[0] - g[0]) * ez - (a[1] - g[1]) * ex) / den, s = ((a[0] - g[0]) * dir[1] - (a[1] - g[1]) * dir[0]) / den;
        if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
      }
      return isFinite(best) ? best : 24;
    };
    const dF = edge([-u[0], -u[1]]), dB = edge(u);
    return { g, u, front: [g[0] - u[0] * dF, g[1] - u[1] * dF], back: [g[0] + u[0] * dB, g[1] + u[1] * dB], dF, dB };
  }
  function pinPoint(h, from) {
    if (pinSpot === "M") return h.green;
    const a = greenAxis(h, from || teeFor(h).p), k = pinSpot === "F" ? -a.dF * 0.55 : a.dB * 0.55;   // front/back pin: halfway to the edge
    return [a.g[0] + a.u[0] * k, a.g[1] + a.u[1] * k];
  }

  // ---- weather: temperature and wind, fetched when there is signal ----
  const weather = store.get("weather", null);
  async function fetchWeather() {
    try {
      const u = "https://api.open-meteo.com/v1/forecast?latitude=35.101&longitude=-83.081&current=temperature_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph";
      const j = await (await fetch(u, { cache: "no-store" })).json();
      const w = { tempF: j.current.temperature_2m, mph: j.current.wind_speed_10m, fromDeg: j.current.wind_direction_10m, t: Date.now() };
      store.set("weather", w); Object.assign(weatherNow, w); render();
    } catch (e) { /* no signal: keep the last reading */ }
  }
  const weatherNow = weather || { tempF: 75, mph: 0, fromDeg: 0, t: 0 };
  function conditions() {
    const tempF = S.temp != null ? S.temp : weatherNow.tempF;
    const wind = S.wind != null ? S.wind : { mph: weatherNow.mph, fromDeg: weatherNow.fromDeg };
    return { tempF, wind };
  }

  // ---- the call ----
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  function render() {
    const h = holes[holeN - 1], tee = teeFor(h);
    const preview = offCourse();
    const p = preview ? tee.p : hold ? hold.p : fix.p;
    const onTee = preview || Object.values(h.tees).some((t) => hyp(p, t.p) < 45);
    if (lieManual && hyp(p, lieManual.p) > 30) lieManual = null;
    if (openLine && hyp(p, openLine.p) > 30) openLine = null;
    lie = lieManual ? lieManual.lie : E.onFairway(p) >= 0.5 ? "fairway" : "rough";
    const pin = pinPoint(h, p);
    const cond = conditions();
    $("holeNum").textContent = h.n;
    $("holeMeta").textContent = `Par ${h.par} · ${h.yards[S.teeSet] || h.yards[tee.name]} yd · ${S.teeSet}${tee.name !== S.teeSet ? ` (plays ${tee.name})` : ""}`;
    $("gps").textContent = preview ? (fix ? "Off the course: preview from the tee" : "Waiting for GPS: preview from the tee")
      : `GPS ±${r(fix.acc)} ft${fix.acc > 30 ? " (weak)" : ""}${hold ? " · call held for this spot" : ""}`;
    $("gps").className = "gps" + (preview || fix.acc > 30 ? " warn" : "");
    $("cond").textContent = `${r(cond.tempF)}°F · wind ${r(cond.wind.mph || 0)} mph ${cond.wind.mph ? "from " + compass(cond.wind.fromDeg) : ""}${S.temp != null || S.wind != null ? " (set)" : ""}`;
    document.querySelectorAll("[data-pin]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pin === pinSpot)));
    document.querySelectorAll("[data-lie]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.lie === lie)); b.disabled = onTee;
      b.classList.toggle("auto", !onTee && !lieManual && b.dataset.lie === lie);
    });
    $("btnOpen").setAttribute("aria-pressed", String(!!openLine));

    // front, center, back: straight yards
    const ax = greenAxis(h, p);
    $("front").textContent = r(hyp(p, ax.front) / 3); $("center").textContent = r(hyp(p, ax.g) / 3); $("back").textContent = r(hyp(p, ax.back) / 3);

    if (S.competition || !S.clubs.length) {
      $("changed").hidden = true; $("call").hidden = true; $("btnOpen").disabled = true; $("compNote").hidden = !S.competition; $("setupNote").hidden = !!S.clubs.length || S.competition;
      $("plays").textContent = "";
      last = null; return;
    }
    $("call").hidden = false; $("compNote").hidden = true; $("setupNote").hidden = true;
    E.setup({ clubs: S.clubs, tempF: cond.tempF, wind: cond.wind, comfortYd: comfortYd(), spread: learnedSpread(),
      teeClubs: ["Driver", "3 wood", "5 hybrid", "4i", "5i"].filter((c) => S.clubs.some((k) => k.club === c)),
      layupClubs: ["3 wood", "5 hybrid", "4i", "5i", "6i", "7i", "8i", "9i", "PW"].filter((c) => S.clubs.some((k) => k.club === c)) });
    const tp = onTee ? null : teePlan(h, cond);
    const plan = E.plan(p, h, pin, { onTee, lie, openLine: !!openLine });
    const ch = tp ? changeNote(plan, tp, p, pin) : "";
    $("changed").hidden = !ch; $("changed").textContent = ch;
    $("btnOpen").disabled = plan.mode !== "approach" || (onTee && h.par > 3);
    if ($("btnOpen").disabled && openLine) { openLine = null; $("btnOpen").setAttribute("aria-pressed", "false"); }
    last = { plan, p, pin, h, onTee };
    $("plays").textContent = `plays ${r(plan.plays)}`;
    const b = plan.best, n = plan.next;
    if (!b) { $("club").textContent = "—"; $("target").textContent = "No clear shot found from here"; $("why").textContent = "Pick a club and take your medicine."; $("next").textContent = ""; return; }
    $("club").textContent = b.club;
    if (b.kind === "approach") {
      $("target").textContent = `to the ${pinSpot === "M" ? "center" : pinSpot === "F" ? "front pin" : "back pin"} · ${r(b.dist)} yd, plays ${r(b.plays)}`;
    } else if (b.kind === "layup") {
      $("target").textContent = `lay up ${r(b.dist)} yd to open fairway`;
    } else {
      $("target").textContent = `lands ${r(b.land.s)} yd out${b.aim ? ` · aim ${Math.abs(b.aim)} yd ${b.aim > 0 ? "right" : "left"}` : ""}`;
    }
    $("why").textContent = b.why.charAt(0).toUpperCase() + b.why.slice(1) + ".";
    $("next").innerHTML = n ? `<b>Or ${n.club}</b>: ${n.why}.` : "";
  }

  // ---- GPS ----
  function onFix(pos) {
    const c = pos.coords;
    fix = { p: toLocal(c.latitude, c.longitude), acc: c.accuracy * 3.28084, t: pos.timestamp };
    recent.push(fix.p); if (recent.length > 3) recent.shift();
    track(); autoHole(); render();
  }
  // hold the call: after 5 seconds standing still (or a Mark shot) the spot is kept, so GPS wobble cannot flip the call
  // over the ball; it lets go once you walk 10 yd away (average of the last 3 fixes, so one jumpy fix does not count)
  function track() {
    if (!fix || offCourse()) { hold = still = null; return; }
    const now = Date.now(), m = [recent.reduce((a, q) => a + q[0], 0) / recent.length, recent.reduce((a, q) => a + q[1], 0) / recent.length];
    if (hold && hyp(m, hold.p) > 30) hold = null;
    if (!still || hyp(fix.p, still.pts[0]) > 20) still = { t: now, pts: [fix.p] };
    else if (still.pts[still.pts.length - 1] !== fix.p) still.pts.push(fix.p);
    if (!hold && now - still.t >= 5000) {
      const n = still.pts.length;
      hold = { p: [still.pts.reduce((a, q) => a + q[0], 0) / n, still.pts.reduce((a, q) => a + q[1], 0) / n] };
    }
  }
  // the phone sends fewer fixes when you stand still, so check once a second too
  setInterval(() => { const h0 = hold; track(); if (hold !== h0) render(); }, 1000);

  // the tee plan for this hole (same clubs, weather and pin), to say when the call from the ball differs from it
  function teePlan(h, cond) {
    const tee = teeFor(h), key = JSON.stringify([h.n, tee.name, pinSpot, S.clubs, cond, comfortYd()]);
    if (teeMemo.key !== key) teeMemo = { key, plan: E.plan(tee.p, h, pinPoint(h, tee.p), { onTee: h.par > 3, lie: "fairway" }) };
    return teeMemo.plan;
  }
  const treeTrouble = (tr) => !!tr && (tr.comfort || tr.hit >= 0.1);
  function changeNote(plan, tp, p, pin) {
    const b = plan.best, t = tp.best;
    if (!b || !t || t.kind !== "full" || !t.next) return "";
    let want = t.next;                                   // the tee plan's next shot: go at the green, or a layup
    if (want.kind === "layup" && hyp(p, pin) < hyp(want.target, pin) + 60) want = want.leave;   // already past the layup spot
    if (want.kind === "layup" && b.kind === "approach")
      return `Changed from the tee plan: go at the green. The tee plan laid up with ${want.club}; ${b.tree && b.tree.open ? "you can see the green" : treeTrouble(b.tree) ? "going is the better bet from here" : "the trees are clear from here"}.`;
    if (want.kind === "approach" && b.kind === "layup") {
      const a = plan.all.find((c) => c.kind === "approach");
      return `Changed from the tee plan: lay up instead of going at the green${a && treeTrouble(a.tree) ? ", trees are in the way from here" : ""}.`;
    }
    if (want.kind === "approach" && b.kind === "approach" && want.club !== b.club)
      return `The tee plan left ${r(want.plays)} (${want.club}); from here it plays ${r(b.plays)}, so ${b.club}.`;
    if (want.club !== b.club) return `Changed from the tee plan: ${b.club} from here (the tee plan had ${want.club} next).`;
    return "";
  }
  if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(onFix, (e) => { $("gps").textContent = e.code === 1 ? "Location is off for this app: turn on Precise Location" : "No GPS fix yet"; },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  // keep the screen on while the app is open
  let lock = null;
  async function wake() { try { if (navigator.wakeLock && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch (e) { /* not allowed here */ } }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { wake(); fetchWeather(); } });
  wake();

  // ---- controls ----
  $("prev").onclick = () => { manualUntil = Date.now() + 120000; setHole(holeN - 1); };
  $("nextHole").onclick = () => { manualUntil = Date.now() + 120000; setHole(holeN + 1); };
  document.querySelectorAll("[data-pin]").forEach((b) => (b.onclick = () => { pinSpot = b.dataset.pin; render(); }));
  const herePt = () => (last ? last.p : fix ? fix.p : null);
  document.querySelectorAll("[data-lie]").forEach((b) => (b.onclick = () => { const q = herePt(); if (q) lieManual = { lie: b.dataset.lie, p: q }; render(); }));
  $("btnOpen").onclick = () => { const q = herePt(); openLine = openLine || !q ? null : { p: q }; render(); };
  $("btnAim").onclick = () => { if (last) GCAim.open(last, grids, C, E); };

  // ---- ball here: log the shot ----
  const shots = () => store.get("shots", []);
  $("btnBall").onclick = () => {
    const list = $("clubList"); list.innerHTML = "";
    const clubs = S.clubs.length ? S.clubs.map((c) => c.club) : ORDER;
    clubs.forEach((c) => {
      const b = document.createElement("button"); b.textContent = c;
      if (last && last.plan.best && last.plan.best.club === c) b.className = "pick";
      b.onclick = () => saveShot(c); list.appendChild(b);
    });
    $("ballSheet").hidden = false;
  };
  $("ballCancel").onclick = () => ($("ballSheet").hidden = true);
  function saveShot(club) {
    const h = holes[holeN - 1], p = fix && !offCourse() ? (hold ? hold.p : fix.p) : null;
    if (!p) { $("ballSheet").hidden = true; alertBar("No GPS fix on the course, so the shot was not saved."); return; }
    const list = shots();
    // what the app said at the time, so plan and result can be compared later
    const cond = conditions(), b = last && last.plan.best;
    const latlon = toLatLon(p[0], p[1]);
    list.push({ t: Date.now(), hole: h.n, x: r(p[0]), z: r(p[1]), acc: r(fix.acc), club, lie: last && last.onTee ? "tee" : lie, tee: S.teeSet,
      lat: latlon ? +latlon[0].toFixed(6) : null, lon: latlon ? +latlon[1].toFixed(6) : null,
      rec: b ? b.club : null, recNext: last && last.plan.next ? last.plan.next.club : null,
      // where the call was aimed (local ft), so left/right misses can be measured per club
      aimX: b ? r((b.kind === "full" ? b.land.p : b.target)[0]) : null, aimZ: b ? r((b.kind === "full" ? b.land.p : b.target)[1]) : null,
      toPin: last ? r(last.plan.dist) : null, plays: last ? r(last.plan.plays) : null, pin: pinSpot,
      tempF: cond.tempF != null ? r(cond.tempF) : null, windMph: cond.wind && cond.wind.mph != null ? r(cond.wind.mph) : null,
      windFrom: cond.wind && cond.wind.mph ? r(cond.wind.fromDeg) : null,
      lieFromMap: !(last && last.onTee) && !lieManual, openLine: !!openLine, held: !!hold });
    hold = { p }; render();                              // keep the call for this spot while you hit
    store.set("shots", list);
    $("ballSheet").hidden = true;
    alertBar(`Saved: ${club} from here (shot ${list.filter((s) => s.hole === h.n && Date.now() - s.t < 3 * 3600e3).length} on ${h.n}).`);
  }

  // ---- settings ----
  $("btnSet").onclick = () => { fillSettings(); $("settings").hidden = false; };
  $("setClose").onclick = () => { readSettings(); $("settings").hidden = true; render(); };
  // close without saving: the X and Cancel leave every setting as it was
  $("setX").onclick = $("setCancel").onclick = () => { $("settings").hidden = true; $("exportBox").hidden = true; };
  $("ballX").onclick = () => ($("ballSheet").hidden = true);
  // the boxes change only on screen; nothing is kept until Save
  $("resetClubs").onclick = () => fillClubRows(DEFAULT_CLUBS);
  function fillClubRows(clubs) {
    $("clubRows").innerHTML = ORDER.map((c) => { const k = clubs.find((x) => x.club === c) || {}; return `<tr><td>${c}</td>
      <td><input inputmode="numeric" data-carry="${c}" value="${k.carry || ""}" aria-label="${c} carry"></td>
      <td><input inputmode="numeric" data-fw="${c}" value="${k.fairway != null ? r(k.fairway * 100) : ""}" aria-label="${c} fairway percent"></td></tr>`; }).join("");
  }
  function fillSettings() {
    $("teeSet").innerHTML = C.tee_sets.map((t) => `<option ${t === S.teeSet ? "selected" : ""}>${t}</option>`).join("");
    $("comp").checked = !!S.competition;
    $("tempIn").value = S.temp == null ? "" : S.temp;
    $("windIn").value = S.wind == null ? "" : S.wind.mph;
    $("windDir").value = S.wind == null ? "" : compass(S.wind.fromDeg);
    $("comfortIn").value = S.comfortYd == null ? 10 : S.comfortYd;
    $("summer").checked = S.summerPad !== false;
    fillClubRows(S.clubs);
    $("learned").innerHTML = learnedTable(); sendInfo();
  }
  function readSettings() {
    S.teeSet = $("teeSet").value; S.competition = $("comp").checked;
    S.temp = $("tempIn").value === "" ? null : +$("tempIn").value;
    const dirs = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
    S.wind = $("windIn").value === "" ? null : { mph: +$("windIn").value, fromDeg: dirs[($("windDir").value || "N").toUpperCase()] ?? 0 };
    S.comfortYd = $("comfortIn").value === "" ? 10 : Math.max(0, +$("comfortIn").value);
    S.summerPad = $("summer").checked;
    S.clubs = ORDER.map((c) => {
      const v = document.querySelector(`[data-carry="${c}"]`).value, f = document.querySelector(`[data-fw="${c}"]`).value;
      return v ? { club: c, carry: +v, factor: FACTORS[c], fairway: f ? +f / 100 : null } : null;
    }).filter(Boolean);
    store.set("settings", S);
  }

  // tree comfort zone: Settings (default 10 yd), plus 2 yd May to October when the trees are in leaf
  function comfortYd() {
    const base = S.comfortYd == null ? 10 : S.comfortYd, m = new Date().getMonth();
    return base + (S.summerPad !== false && m >= 4 && m <= 9 ? 2 : 0);
  }
  // left/right spread per club from the shot log: twice the standard deviation of the miss angle, once 8+ shots
  function learnedSpread() {
    const out = {}, L = learned();
    for (const [c, o] of Object.entries(L)) if (o.ang.length >= 8) {
      const m = o.ang.reduce((x, y) => x + y, 0) / o.ang.length;
      const sd = Math.sqrt(o.ang.reduce((x, y) => x + (y - m) ** 2, 0) / (o.ang.length - 1));
      out[c] = Math.min(15, Math.max(2, 2 * sd));
    }
    return out;
  }
  // what the logged shots say: distance per club (to the next ball position), fairway rate off the tee, miss angle
  function learned() {
    const L = shots(), out = {};
    for (let i = 0; i < L.length - 1; i++) {
      const a = L[i], b = L[i + 1];
      if (a.hole !== b.hole || b.t - a.t > 30 * 60e3 || a.acc > 40 || b.acc > 40) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z) / 3, o = (out[a.club] = out[a.club] || { d: [], fw: 0, tee: 0, ang: [] });
      o.d.push(d);
      if (a.lie === "tee") { o.tee++; if (b.lie === "fairway") o.fw++; }
      if (a.aimX != null && d > 40) {
        const t1 = Math.atan2(a.aimX - a.x, -(a.aimZ - a.z)), t2 = Math.atan2(b.x - a.x, -(b.z - a.z));
        let dAng = ((t2 - t1) * 180) / Math.PI; dAng = ((dAng + 540) % 360) - 180;
        if (Math.abs(dAng) < 45) o.ang.push(dAng);
      }
    }
    return out;
  }
  function learnedTable() {
    const L = learned(), ks = ORDER.filter((c) => L[c]);
    if (!ks.length) return "<p class='muted'>Tap Mark shot before each shot. After a few rounds this shows your real distance per club and how often each tee club finds the fairway.</p>";
    const sp = learnedSpread();
    return `<table><tr><th>Club</th><th>Shots</th><th>Median yd</th><th>Fairway off tee</th><th>Spread</th><th></th></tr>${ks.map((c) => {
      const d = L[c].d.slice().sort((a, b) => a - b), med = r(d[Math.floor(d.length / 2)]);
      return `<tr><td>${c}</td><td>${d.length}</td><td>${med}</td><td>${L[c].tee ? r((100 * L[c].fw) / L[c].tee) + "% of " + L[c].tee : ""}</td>
        <td>${sp[c] ? "±" + sp[c].toFixed(1) + "°" : `±${GCEngine.SPREAD[c] || 4}° (default)`}</td>
        <td>${d.length >= 5 ? `<button data-use="${c}" data-med="${med}">Use</button>` : ""}</td></tr>`;
    }).join("")}</table><p class="muted">Distances include roll. Use a number only once it has 5 or more shots. Spread (left/right) switches from the default to yours on its own after 8 shots with a call to aim at.</p>`;
  }
  $("learned").addEventListener("click", (e) => {
    const b = e.target.closest("[data-use]"); if (!b) return;
    const inp = document.querySelector(`[data-carry="${b.dataset.use}"]`); if (inp) inp.value = b.dataset.med;
  });
  // ---- send the shot log to Claude: an email to claude@cowrock.com that the hub turns into a task ----
  const unsent = () => { const t = store.get("sentUpTo", 0); return shots().filter((s) => s.t > t); };
  function sendInfo() {
    const all = shots().length, n = unsent().length;
    $("sendInfo").textContent = all ? `${all} shot${all === 1 ? "" : "s"} logged on this phone · ${n} not sent yet.` : "No shots logged yet. Tap Mark shot before each shot.";
  }
  function payload(list) {
    const days = [...new Set(list.map((s) => new Date(s.t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })))];
    const holesPlayed = [...new Set(list.map((s) => s.hole))].sort((a, b) => a - b);
    return { app: "Caddie", course: C.name, sent: new Date().toISOString(), days, holes: holesPlayed, count: list.length,
      clubs: S.clubs.map((c) => [c.club, c.carry, c.fairway]), shots: list };
  }
  $("sendClaude").onclick = () => {
    const list = unsent().length ? unsent() : shots();
    if (!list.length) { alertBar("No shots logged yet."); return; }
    const p = payload(list);
    const subject = `Hub: Golf - Caddie shot data, ${p.days.join(" and ")} (${p.count} shots)`;
    const body = `Caddie shot data from ${C.name}: ${p.count} shots on holes ${p.holes.join(", ")}, ${p.days.join(" and ")}.\n` +
      `Please save it in AI_Files 04_Personal/Golf and update the club numbers and analysis.\n\n` + JSON.stringify(p);
    if (body.length > 60000) { alertBar("Too many shots for one email: use Share as a file instead."); return; }
    location.href = `mailto:claude@cowrock.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    store.set("sentUpTo", Math.max(...list.map((s) => s.t)));
    sendInfo();
  };
  $("shareFile").onclick = async () => {
    const list = shots();
    if (!list.length) { alertBar("No shots logged yet."); return; }
    const p = payload(list), name = `caddie-shots-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([JSON.stringify(p, null, 1)], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Caddie shot data" }); return; }
    } catch (e) { if (e.name === "AbortError") return; }
    $("export").onclick();
  };

  $("export").onclick = async () => {
    const txt = JSON.stringify({ shots: shots(), clubs: S.clubs });
    try { await navigator.clipboard.writeText(txt); alertBar("Round data copied. Paste it into a note or a message to Claude."); }
    catch (e) { $("exportBox").hidden = false; $("exportBox").value = txt; $("exportBox").select(); }
  };
  $("clearShots").onclick = () => {
    if ($("clearShots").dataset.armed) { store.set("shots", []); $("learned").innerHTML = learnedTable(); $("clearShots").textContent = "Clear logged shots"; delete $("clearShots").dataset.armed; }
    else { $("clearShots").dataset.armed = "1"; $("clearShots").textContent = "Tap again to clear every logged shot"; }
  };

  function alertBar(msg) { const a = $("toast"); a.textContent = msg; a.hidden = false; clearTimeout(alertBar.t); alertBar.t = setTimeout(() => (a.hidden = true), 4500); }

  if ("serviceWorker" in navigator) {
    // a new version takes over: reload once so the screen shows it (first install has no old version to replace)
    const hadOld = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadOld && !sessionStorage.getItem("gc-reloaded")) { sessionStorage.setItem("gc-reloaded", "1"); location.reload(); } });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  fetchWeather();
  render();
})().catch((e) => {
  const l = document.getElementById("loading"); l.hidden = false;
  l.textContent = "The course did not load. Open the app once with signal so it can save the course on this phone.";
  console.error(e);
});
