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
  let S = store.get("settings", null) || { clubs: [], teeSet: "IV/III", competition: false, temp: null, wind: null };

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
  const { C, grids, toLocal } = await GCGeo.loadCourse("data");
  const E = new GCEngine(grids);
  const holes = C.holes;
  $("loading").hidden = true;

  // ---- state ----
  let fix = null;          // {p:[x,z], acc ft, t}
  let holeN = store.get("hole", 1), manualUntil = 0;
  let pinSpot = "M", lie = "fairway";
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
  function setHole(n) { holeN = ((n - 1 + 18) % 18) + 1; store.set("hole", holeN); pinSpot = "M"; render(); }

  function pinPoint(h, from) {
    const g = h.green;
    if (pinSpot === "M") return g;
    const ref = h.line.length > 2 ? h.line[h.line.length - 2] : from || teeFor(h).p;
    const d = hyp(ref, g), u = [(g[0] - ref[0]) / d, (g[1] - ref[1]) / d], k = (pinSpot === "F" ? -8 : 8) * 3;
    return [g[0] + u[0] * k, g[1] + u[1] * k];
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
    const p = preview ? tee.p : fix.p;
    const onTee = preview || Object.values(h.tees).some((t) => hyp(p, t.p) < 45);
    const pin = pinPoint(h, p);
    const cond = conditions();
    $("holeNum").textContent = h.n;
    $("holeMeta").textContent = `Par ${h.par} · ${h.yards[S.teeSet] || h.yards[tee.name]} yd · ${S.teeSet}${tee.name !== S.teeSet ? ` (plays ${tee.name})` : ""}`;
    $("gps").textContent = preview ? (fix ? "Off the course: preview from the tee" : "Waiting for GPS: preview from the tee")
      : `GPS ±${r(fix.acc)} ft${fix.acc > 30 ? " (weak)" : ""}`;
    $("gps").className = "gps" + (preview || fix.acc > 30 ? " warn" : "");
    $("cond").textContent = `${r(cond.tempF)}°F · wind ${r(cond.wind.mph || 0)} mph ${cond.wind.mph ? "from " + compass(cond.wind.fromDeg) : ""}${S.temp != null || S.wind != null ? " (set)" : ""}`;
    document.querySelectorAll("[data-pin]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.pin === pinSpot)));
    document.querySelectorAll("[data-lie]").forEach((b) => { b.setAttribute("aria-pressed", String(b.dataset.lie === lie)); b.disabled = onTee; });

    // front, center, back: straight yards
    const g = h.green, ref = h.line.length > 2 ? h.line[h.line.length - 2] : p;
    const d = hyp(ref, g), u = [(g[0] - ref[0]) / d, (g[1] - ref[1]) / d];
    const yd = (k) => r(hyp(p, [g[0] + u[0] * k * 24, g[1] + u[1] * k * 24]) / 3);
    $("front").textContent = yd(-1); $("center").textContent = yd(0); $("back").textContent = yd(1);

    if (S.competition || !S.clubs.length) {
      $("call").hidden = true; $("compNote").hidden = !S.competition; $("setupNote").hidden = !!S.clubs.length || S.competition;
      $("plays").textContent = "";
      last = null; return;
    }
    $("call").hidden = false; $("compNote").hidden = true; $("setupNote").hidden = true;
    E.setup({ clubs: S.clubs, tempF: cond.tempF, wind: cond.wind, teeClubs: ["Driver", "3 wood", "5 hybrid", "4i", "5i"].filter((c) => S.clubs.some((k) => k.club === c)),
      layupClubs: ["3 wood", "5 hybrid", "4i", "5i", "6i", "7i", "8i", "9i", "PW"].filter((c) => S.clubs.some((k) => k.club === c)) });
    const plan = E.plan(p, h, pin, { onTee, lie });
    last = { plan, p, pin, h, onTee };
    $("plays").textContent = `plays ${r(plan.plays)}`;
    const b = plan.best, n = plan.next;
    if (!b) { $("club").textContent = "—"; $("target").textContent = "No clear shot found from here"; $("why").textContent = "Pick a club and take your medicine."; $("next").textContent = ""; return; }
    $("club").textContent = b.club;
    if (b.kind === "approach") {
      $("target").textContent = `to the ${pinSpot === "M" ? "center" : pinSpot === "F" ? "front pin" : "back pin"} · ${r(b.dist)} yd, plays ${r(b.plays)}`;
    } else {
      $("target").textContent = b.layup ? `lands ${r(b.land.s)} yd out, then ${b.layup.club}` : `lands ${r(b.land.s)} yd out`;
    }
    $("why").textContent = b.why.charAt(0).toUpperCase() + b.why.slice(1) + ".";
    $("next").innerHTML = n ? `<b>Or ${n.club}</b>: ${n.why}.` : "";
  }

  // ---- GPS ----
  function onFix(pos) {
    const c = pos.coords;
    fix = { p: toLocal(c.latitude, c.longitude), acc: c.accuracy * 3.28084, t: pos.timestamp };
    autoHole(); render();
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
  document.querySelectorAll("[data-lie]").forEach((b) => (b.onclick = () => { lie = b.dataset.lie; render(); }));
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
    const h = holes[holeN - 1], p = fix && !offCourse() ? fix.p : null;
    if (!p) { $("ballSheet").hidden = true; alertBar("No GPS fix on the course, so the shot was not saved."); return; }
    const list = shots();
    list.push({ t: Date.now(), hole: h.n, x: r(p[0]), z: r(p[1]), acc: r(fix.acc), club, lie: last && last.onTee ? "tee" : lie, tee: S.teeSet });
    store.set("shots", list);
    $("ballSheet").hidden = true;
    alertBar(`Saved: ${club} from here (shot ${list.filter((s) => s.hole === h.n && Date.now() - s.t < 3 * 3600e3).length} on ${h.n}).`);
  }

  // ---- settings ----
  $("btnSet").onclick = () => { fillSettings(); $("settings").hidden = false; };
  $("setClose").onclick = () => { readSettings(); $("settings").hidden = true; render(); };
  function fillSettings() {
    $("teeSet").innerHTML = C.tee_sets.map((t) => `<option ${t === S.teeSet ? "selected" : ""}>${t}</option>`).join("");
    $("comp").checked = !!S.competition;
    $("tempIn").value = S.temp == null ? "" : S.temp;
    $("windIn").value = S.wind == null ? "" : S.wind.mph;
    $("windDir").value = S.wind == null ? "" : compass(S.wind.fromDeg);
    const rows = ORDER.map((c) => { const k = S.clubs.find((x) => x.club === c) || {}; return `<tr><td>${c}</td>
      <td><input inputmode="numeric" data-carry="${c}" value="${k.carry || ""}" aria-label="${c} carry"></td>
      <td><input inputmode="numeric" data-fw="${c}" value="${k.fairway != null ? r(k.fairway * 100) : ""}" aria-label="${c} fairway percent"></td></tr>`; }).join("");
    $("clubRows").innerHTML = rows;
    $("learned").innerHTML = learnedTable();
  }
  function readSettings() {
    S.teeSet = $("teeSet").value; S.competition = $("comp").checked;
    S.temp = $("tempIn").value === "" ? null : +$("tempIn").value;
    const dirs = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
    S.wind = $("windIn").value === "" ? null : { mph: +$("windIn").value, fromDeg: dirs[($("windDir").value || "N").toUpperCase()] ?? 0 };
    S.clubs = ORDER.map((c) => {
      const v = document.querySelector(`[data-carry="${c}"]`).value, f = document.querySelector(`[data-fw="${c}"]`).value;
      return v ? { club: c, carry: +v, factor: FACTORS[c], fairway: f ? +f / 100 : null } : null;
    }).filter(Boolean);
    store.set("settings", S);
  }

  // what the logged shots say: distance per club (to the next ball position) and fairway rate off the tee
  function learned() {
    const L = shots(), out = {};
    for (let i = 0; i < L.length - 1; i++) {
      const a = L[i], b = L[i + 1];
      if (a.hole !== b.hole || b.t - a.t > 30 * 60e3 || a.acc > 40 || b.acc > 40) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z) / 3, o = (out[a.club] = out[a.club] || { d: [], fw: 0, tee: 0 });
      o.d.push(d);
      if (a.lie === "tee") { o.tee++; if (b.lie === "fairway") o.fw++; }
    }
    return out;
  }
  function learnedTable() {
    const L = learned(), ks = ORDER.filter((c) => L[c]);
    if (!ks.length) return "<p class='muted'>Tap Ball here before each shot. After a few rounds this shows your real distance per club and how often each tee club finds the fairway.</p>";
    return `<table><tr><th>Club</th><th>Shots</th><th>Median yd</th><th>Fairway off tee</th><th></th></tr>${ks.map((c) => {
      const d = L[c].d.slice().sort((a, b) => a - b), med = r(d[Math.floor(d.length / 2)]);
      return `<tr><td>${c}</td><td>${d.length}</td><td>${med}</td><td>${L[c].tee ? r((100 * L[c].fw) / L[c].tee) + "% of " + L[c].tee : ""}</td>
        <td>${d.length >= 5 ? `<button data-use="${c}" data-med="${med}">Use</button>` : ""}</td></tr>`;
    }).join("")}</table><p class="muted">Distances include roll. Use a number only once it has 5 or more shots.</p>`;
  }
  $("learned").addEventListener("click", (e) => {
    const b = e.target.closest("[data-use]"); if (!b) return;
    const inp = document.querySelector(`[data-carry="${b.dataset.use}"]`); if (inp) inp.value = b.dataset.med;
  });
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

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  fetchWeather();
  render();
})().catch((e) => {
  const l = document.getElementById("loading"); l.hidden = false;
  l.textContent = "The course did not load. Open the app once with signal so it can save the course on this phone.";
  console.error(e);
});
