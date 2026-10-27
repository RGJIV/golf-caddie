/* Golf caddie engine: what to hit from where you stand. Runs fully on the phone.
   © 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential.

   Local frame: x = ft east, z = ft south, heights in ft. Distances shown in yards.
   Plays-like (player's factor table): horizontal yd - factor x 0.925 x drop, or + factor x 1.075 x rise (height in yd);
   drops over 25 yd give back 1.5 yd. Plans are ranked by expected strokes: PGA Tour strokes-to-hole-out from the leave
   (fairway at the club's fairway rate, else rough + 0.10), plus 0.015 per yard the leave sits off a full carry. */
(function (root) {
  "use strict";

  const FAIRWAY = [[20, 2.40], [40, 2.60], [60, 2.70], [80, 2.75], [100, 2.80], [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.05],
    [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.35], [280, 3.45], [300, 3.55], [350, 3.75], [400, 3.95], [450, 4.10], [500, 4.30], [600, 4.65]];
  const ROUGH_ADD = [[20, 0.10], [100, 0.12], [150, 0.17], [200, 0.25], [600, 0.25]];
  const TROUBLE = 0.10, GAP_COST = 0.015, WATER_COST = 1.0;
  const LIE = { fairway: 1.0, rough: 0.95, bunker: 0.9 };
  // typical peak height (ft) by club, for the tree and hill check along the flight
  const APEX = { "58 deg": 80, "54 deg": 85, "48 deg": 88, PW: 90, "9i": 92, "8i": 94, "7i": 96, "6i": 97, "5i": 98, "4i": 100,
    "5 hybrid": 104, "3 wood": 108, Driver: 112 };

  const interp = (tab, x) => {
    if (x <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return tab[tab.length - 1][1];
  };
  const strokes = (yd, fairway) => interp(FAIRWAY, yd) + (fairway ? 0 : interp(ROUGH_ADD, yd) + TROUBLE);
  const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  function playsLike(hYd, dzYd, f) {
    if (dzYd >= 0) return hYd + f * 1.075 * dzYd;
    const drop = -dzYd;
    return hYd - f * 0.925 * drop + (drop > 25 ? 1.5 : 0);
  }

  function Engine(grids) {
    // grids: { ground(x, z) -> ft, canopy(x, z) -> top ft or 0, water(x, z) -> bool }
    this.g = grids;
  }

  Engine.prototype.setup = function (ctx) {
    // ctx: { clubs: [{club, carry, factor, fairway}], tempF, wind: {mph, fromDeg} | null, lie, teeClubs, layupClubs }
    this.ctx = ctx;
    const t = 1 + 0.0013 * ((ctx.tempF == null ? 75 : ctx.tempF) - 75);
    this.clubs = ctx.clubs.map((c) => ({ ...c, eff: c.carry * t }));
    this.byName = Object.fromEntries(this.clubs.map((c) => [c.club, c]));
    this.approach = this.clubs.filter((c) => c.club !== "Driver");
    this.maxCarry = Math.max(...this.approach.map((c) => c.eff));
  };

  // wind: extra plays-like yards and sideways drift for a shot of hYd on bearing (deg from north)
  Engine.prototype.wind = function (hYd, bearing) {
    const w = this.ctx.wind;
    if (!w || !w.mph) return { add: 0, drift: 0 };
    const rel = ((w.fromDeg - bearing) * Math.PI) / 180;
    const head = w.mph * Math.cos(rel), cross = w.mph * Math.sin(rel);
    return { add: head > 0 ? hYd * 0.01 * head : hYd * 0.005 * head, drift: 0.8 * cross * hYd / 150 };
  };
  const bearingOf = (a, b) => ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360;

  // full plays-like for one club from a to b (heights from the ground grid unless given)
  Engine.prototype.need = function (a, za, b, zb, club, lie) {
    const h = hyp(a, b) / 3, w = this.wind(h, bearingOf(a, b));
    const pl = playsLike(h, (zb - za) / 3, club.factor) + w.add;
    return { h, pl, carry: club.eff * (LIE[lie || "fairway"] || 1), drift: w.drift };
  };

  // is the flight from a to b clear of trees and hills? (simple arc peaking a little past halfway)
  Engine.prototype.clear = function (a, za, b, zb, club) {
    const apex = APEX[club.club] || 95, L = hyp(a, b);
    for (let t = 0.04; t < 0.97; t += 0.03) {
      const s = t < 0.55 ? t / 0.55 : (1 - t) / 0.45;
      const ball = za + (zb - za) * t + apex * (1 - (1 - s) * (1 - s)) + 3;
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const top = this.g.canopy(x, z);
      if (top > 0 && top > ball) return { ok: false, by: "trees", atYd: Math.round((L * t) / 3) };
      if (this.g.ground(x, z) > ball) return { ok: false, by: "the hill", atYd: Math.round((L * t) / 3) };
    }
    return { ok: true };
  };

  Engine.prototype.waterNear = function (p, r) {
    for (let dx = -r; dx <= r; dx += 9) for (let dz = -r; dz <= r; dz += 9)
      if (dx * dx + dz * dz <= r * r && this.g.water(p[0] + dx, p[1] + dz)) return true;
    return false;
  };
  Engine.prototype.treesAt = function (p, r) {
    let m = 0;
    for (let dx = -r; dx <= r; dx += 9) for (let dz = -r; dz <= r; dz += 9) {
      const t = this.g.canopy(p[0] + dx, p[1] + dz); if (t > 0) m = Math.max(m, t - this.g.ground(p[0] + dx, p[1] + dz));
    }
    return m;
  };

  // ranked approach clubs to a target (best fit first; blocked flights marked)
  Engine.prototype.approachFit = function (p, zp, tgt, zt, lie) {
    const rows = this.approach.map((c) => {
      const n = this.need(p, zp, tgt, zt, c, lie);
      return { club: c.club, plays: n.pl, dist: n.h, gap: n.pl - n.carry, drift: n.drift, c };
    }).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
    rows.slice(0, 4).forEach((r) => (r.flight = this.clear(p, zp, tgt, zt, r.c)));
    return rows;
  };

  // landing spot of a full shot along a path (first point whose plays-like from the start equals the carry)
  Engine.prototype.land = function (path, z0, club, lie) {
    const a = path[0];
    let s = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i], q = path[i + 1], L = hyp(p, q), n = Math.max(1, Math.round(L / 3));
      for (let k = 1; k <= n; k++) {
        const x = p[0] + ((q[0] - p[0]) * k) / n, z = p[1] + ((q[1] - p[1]) * k) / n, pt = [x, z];
        const nd = this.need(a, z0, pt, this.g.ground(x, z), club, lie);
        if (nd.pl >= nd.carry) return { p: pt, z: this.g.ground(x, z), s: (s + (L * k) / n) / 3 };
      }
      s += L;
    }
    return null;
  };

  // path from here to the pin through the hole's bends that are still ahead
  Engine.prototype.pathFrom = function (p, hole, pin) {
    const dP = hyp(p, pin);
    const bends = hole.line.slice(1, -1).filter((b) => hyp(b, pin) < dP - 30 && hyp(p, b) < dP);
    return [p, ...bends, pin];
  };

  Engine.prototype.leaveStrokes = function (fit, fp) {
    const L = fit.plays, gap = fit.club === "out of reach" ? 0 : Math.abs(fit.gap);
    return fp * strokes(L, true) + (1 - fp) * strokes(L, false) + GAP_COST * gap;
  };
  Engine.prototype.leave = function (p, zp, pin, zg) {
    const rows = this.approachFit(p, zp, pin, zg, "fairway");
    let r = rows[0];
    if (r.plays > this.maxCarry + 10) r = { ...r, club: "out of reach", gap: 0 };
    return r;
  };

  /* The call from where you stand.
     hole: {par, line, green}; pin: [x, z]; opts: {onTee, lie}
     Returns {mode: "approach"|"full", best, next, all, pin, dist, plays} with short reasons. */
  Engine.prototype.plan = function (p, hole, pin, opts) {
    const lie = opts.onTee ? "fairway" : opts.lie || "fairway";
    const zp = this.g.ground(p[0], p[1]), zg = this.g.ground(pin[0], pin[1]);
    const fits = this.approachFit(p, zp, pin, zg, lie);
    const direct = fits[0];
    const reachable = direct.plays <= this.maxCarry * (LIE[lie] || 1) + 10;
    const teeShotPar4plus = opts.onTee && hole.par > 3;
    const out = { dist: direct.dist, dz: zg - zp, pin };

    if (reachable && !(teeShotPar4plus && direct.plays > 230)) {
      // approach: the club that fits, skipping flights that hit trees or the hill
      const clearFits = fits.filter((f) => !f.flight || f.flight.ok);
      const ranked = (clearFits.length ? clearFits : fits).slice(0, 3);
      const blocked = fits.find((f) => f.flight && !f.flight.ok && Math.abs(f.gap) < Math.abs((ranked[0] || {}).gap || 99));
      const wet = this.waterNear(pin, 30) || this.lineWater(p, pin);
      const mk = (f) => ({ club: f.club, plays: f.plays, dist: f.dist, gap: f.gap, drift: f.drift,
        why: this.whyApproach(f, zg - zp, blocked, wet), target: pin, kind: "approach" });
      return { ...out, mode: "approach", plays: direct.plays, best: ranked[0] && mk(ranked[0]), next: ranked[1] && mk(ranked[1]), all: fits };
    }

    // full shot: tee club or layup, ranked by expected strokes to hole out
    const path = this.pathFrom(p, hole, pin);
    const names = opts.onTee ? this.ctx.teeClubs : this.ctx.layupClubs;
    const opts2 = [];
    for (const name of names) {
      const c = this.byName[name]; if (!c) continue;
      const l = this.land(path, zp, c, lie); if (!l) continue;
      const fl = this.clear(p, zp, l.p, l.z, c);
      if (!fl.ok) { opts2.push({ club: name, blocked: fl, expected: 99 }); continue; }
      const fp = c.fairway != null ? c.fairway : 0.85;
      const trees = this.treesAt(l.p, 15), wet = this.waterNear(l.p, 30);
      const fp2 = trees > 15 ? Math.min(fp, 0.3) : fp;
      let lv = this.leave(l.p, l.z, pin, zg), e = 1 + this.leaveStrokes(lv, fp2) + (wet ? WATER_COST * 0.3 : 0);
      let layup = null;
      if (lv.club === "out of reach") {
        // one more full shot to a stock leave
        const rest = this.pathFrom(l.p, hole, pin);
        let bestL = null;
        for (const ln of this.ctx.layupClubs) {
          const c2 = this.byName[ln]; if (!c2) continue;
          const l2 = this.land(rest, l.z, c2, "fairway"); if (!l2) continue;
          const lv2 = this.leave(l2.p, l2.z, pin, zg); if (lv2.club === "out of reach") continue;
          const fq = c2.fairway != null ? c2.fairway : 0.85;
          const e2 = 2 + (1 - fp2) * (TROUBLE + 0.05) + this.leaveStrokes(lv2, fq) + (this.waterNear(l2.p, 30) ? WATER_COST * 0.3 : 0);
          if (!bestL || e2 < bestL.e) bestL = { club: ln, land: l2, leave: lv2, e: e2 };
        }
        if (bestL) { layup = bestL; lv = bestL.leave; e = bestL.e; }
      }
      opts2.push({ club: name, land: l, leave: lv, layup, fp, trees, wet, expected: e, kind: "full" });
    }
    const ranked = opts2.filter((o) => o.expected < 90).sort((a, b) => a.expected - b.expected);
    ranked.forEach((o) => (o.why = this.whyFull(o, ranked[0])));
    return { ...out, mode: "full", plays: direct.plays, best: ranked[0], next: ranked[1], all: opts2, path };
  };

  Engine.prototype.lineWater = function (a, b) {
    const L = hyp(a, b);
    for (let s = 30; s < L; s += 9) if (this.g.water(a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L)) return true;
    return false;
  };

  const r = Math.round;
  Engine.prototype.whyApproach = function (f, dzFt, blocked, wet) {
    const parts = [];
    if (Math.abs(f.gap) < 2) parts.push(`a full ${f.club}`);
    else parts.push(`${f.club} ${f.gap > 0 ? "hit firm" : "a touch soft"} (${Math.abs(r(f.gap))} yd ${f.gap > 0 ? "more" : "less"} than full)`);
    if (Math.abs(dzFt) >= 6) parts.push(`green ${Math.abs(r(dzFt))} ft ${dzFt > 0 ? "up" : "down"}`);
    if (blocked) parts.push(`${blocked.club} would catch ${blocked.flight.by}`);
    if (wet) parts.push("water near the line");
    if (Math.abs(f.drift) >= 3) parts.push(`aim ${Math.abs(r(f.drift))} yd ${f.drift > 0 ? "right" : "left"} for wind`);
    return parts.join(", ");
  };
  Engine.prototype.whyFull = function (o, best) {
    const lv = o.leave, parts = [];
    if (o.layup) parts.push(`then ${o.layup.club} leaves ${r(lv.plays)}${lv.club !== "out of reach" ? ` (${Math.abs(lv.gap) < 3 ? "full " : ""}${lv.club})` : ""}`);
    else if (lv.club === "out of reach") parts.push(`leaves ${r(lv.plays)}`);
    else parts.push(`leaves ${r(lv.plays)}, ${Math.abs(lv.gap) < 3 ? "a full " + lv.club : lv.club + (lv.gap > 0 ? " hit firm" : " soft")}`);
    if (o.fp != null && o.fp < 0.6) parts.push(`fairway ${r(o.fp * 100)}% of the time`);
    if (o.trees > 15) parts.push("trees near the landing");
    if (o.wet) parts.push("water near the landing");
    if (o !== best && best) parts.push(`${(o.expected - best.expected).toFixed(2)} strokes behind`);
    return parts.join(", ");
  };

  /* Ball flight shape: PGA Tour TrackMan peak heights (yd) and the landing angles from the player's elevation table.
     Two parabolas meet at the peak: a long climb, then a descent sized so the ball comes down at the club's landing
     angle. Short (partial) shots peak lower in proportion. Returns height above the straight line from start to landing. */
  const FLIGHT = { "58 deg": [27, 56], "54 deg": [28, 55], "48 deg": [29, 53], PW: [29, 52], "9i": [30, 51], "8i": [31, 50],
    "7i": [32, 50], "6i": [30, 49], "5i": [31, 47], "4i": [28, 46], "5 hybrid": [29, 45], "3 wood": [30, 43], Driver: [32, 38.5] };
  function flightShape(club, distFt, fullCarryYd) {
    const [apexYd, landDeg] = FLIGHT[club] || [30, 48];
    const A = apexYd * 3 * Math.min(1.1, Math.max(0.45, distFt / 3 / (fullCarryYd || distFt / 3)));
    let xa = distFt - (2 * A) / Math.tan((landDeg * Math.PI) / 180);
    xa = Math.min(0.75 * distFt, Math.max(0.5 * distFt, xa));
    return (s) => (s <= xa ? A - A * ((s - xa) / xa) ** 2 : A - A * ((s - xa) / (distFt - xa)) ** 2);
  }

  Engine.flightShape = flightShape;
  Engine.FLIGHT = FLIGHT;
  Engine.playsLike = playsLike;
  Engine.strokes = strokes;
  Engine.bearingOf = bearingOf;
  root.GCEngine = Engine;
  if (typeof module !== "undefined") module.exports = Engine;
})(typeof window !== "undefined" ? window : globalThis);
