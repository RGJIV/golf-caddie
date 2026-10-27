/* Golf caddie engine: what to hit from where you stand. Runs fully on the phone.
   © 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential.

   Local frame: x = ft east, z = ft south, heights in ft. Distances shown in yards.
   Plays-like (player's factor table): horizontal yd - factor x 0.925 x drop, or + factor x 1.075 x rise (height in yd);
   drops over 25 yd give back 1.5 yd. Plans are ranked by expected strokes: PGA Tour strokes-to-hole-out from the leave
   (fairway at the club's fairway rate, else rough + 0.10), plus 0.015 per yard the leave sits off a full carry.

   Trees (Oct 27, 2026; same model as golf-map club_plan.py): every shot is a cone (left/right spread per club). A tree only
   counts where it is taller than the ball would be at that point of a tour-shaped flight. The share of the cone that clips
   a tree costs 0.7 strokes (punch-out), landing among trees 0.5. A tree taller than the ball within the comfort zone
   (default 10 yd, beyond the first 60 yd so tee chutes do not count) makes the shot one the player will not take unless
   nothing else is clear. Tee shots try aims up to 30 yd either side of the line (landing on fairway); when going at the
   green is risky the engine looks for an open fairway layup spot that leaves a full wedge or short iron. */
(function (root) {
  "use strict";

  const FAIRWAY = [[20, 2.40], [40, 2.60], [60, 2.70], [80, 2.75], [100, 2.80], [120, 2.85], [140, 2.91], [160, 2.98], [180, 3.05],
    [200, 3.12], [220, 3.17], [240, 3.25], [260, 3.35], [280, 3.45], [300, 3.55], [350, 3.75], [400, 3.95], [450, 4.10], [500, 4.30], [600, 4.65]];
  const ROUGH_ADD = [[20, 0.10], [100, 0.12], [150, 0.17], [200, 0.25], [600, 0.25]];
  const TROUBLE = 0.10, GAP_COST = 0.015, WATER_COST = 1.0;
  const HIT_COST = 0.7, LAND_COST = 0.5, COMFORT_COST = 2.0;
  const LIE = { fairway: 1.0, rough: 0.95, bunker: 0.9 };
  const SPREAD = { Driver: 8, "3 wood": 6, "5 hybrid": 5, "4i": 4, "5i": 4, "6i": 4, "7i": 4, "8i": 4, "9i": 4, PW: 3, "48 deg": 3, "54 deg": 3, "58 deg": 3 };
  const FLIGHT = { "58 deg": [27, 56], "54 deg": [28, 55], "48 deg": [29, 53], PW: [29, 52], "9i": [30, 51], "8i": [31, 50],
    "7i": [32, 50], "6i": [30, 49], "5i": [31, 47], "4i": [28, 46], "5 hybrid": [29, 45], "3 wood": [30, 43], Driver: [32, 38.5] };
  const ANG = [-2, -1.33, -0.67, 0, 0.67, 1.33, 2];
  const WGT = (() => { const w = ANG.map((a) => Math.exp(-a * a / 2)), s = w.reduce((x, y) => x + y, 0); return w.map((x) => x / s); })();
  const LEAVES = [80, 100, 120, 140, 160];

  const interp = (tab, x) => {
    if (x <= tab[0][0]) return tab[0][1];
    for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return tab[tab.length - 1][1];
  };
  const strokes = (yd, fairway) => interp(FAIRWAY, yd) + (fairway ? 0 : interp(ROUGH_ADD, yd) + TROUBLE);
  const rough = (yd) => interp(ROUGH_ADD, yd) + TROUBLE;
  const hyp = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const r = Math.round;

  function playsLike(hYd, dzYd, f) {
    if (dzYd >= 0) return hYd + f * 1.075 * dzYd;
    const drop = -dzYd;
    return hYd - f * 0.925 * drop + (drop > 25 ? 1.5 : 0);
  }

  /* Ball flight shape: PGA Tour TrackMan peak heights (yd) and the landing angles from the player's elevation table.
     Two parabolas meet at the peak; short (partial) shots peak lower in proportion. Height above the start-landing line. */
  function flightShape(club, distFt, fullCarryYd) {
    const [apexYd, landDeg] = FLIGHT[club] || [30, 48];
    const A = apexYd * 3 * Math.min(1.1, Math.max(0.45, distFt / 3 / (fullCarryYd || distFt / 3)));
    let xa = distFt - (2 * A) / Math.tan((landDeg * Math.PI) / 180);
    xa = Math.min(0.75 * distFt, Math.max(0.5 * distFt, xa));
    return (s) => (s <= xa ? A - A * ((s - xa) / xa) ** 2 : A - A * ((s - xa) / (distFt - xa)) ** 2);
  }
  const bearingOf = (a, b) => ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360;

  function Engine(grids) {
    // grids: { ground(x, z), canopy(x, z) -> tree-top height or 0, water(x, z), fairway(x, z) }
    this.g = grids;
  }

  Engine.prototype.setup = function (ctx) {
    // ctx: { clubs: [{club, carry, factor, fairway}], tempF, wind: {mph, fromDeg} | null, teeClubs, layupClubs,
    //        comfortYd (default 10), spread: {club: degrees} (learned from the shot log) }
    this.ctx = ctx;
    const t = 1 + 0.0013 * ((ctx.tempF == null ? 75 : ctx.tempF) - 75);
    this.clubs = ctx.clubs.map((c) => ({ ...c, eff: c.carry * t }));
    this.byName = Object.fromEntries(this.clubs.map((c) => [c.club, c]));
    this.approach = this.clubs.filter((c) => c.club !== "Driver");
    this.maxCarry = Math.max(...this.approach.map((c) => c.eff));
    this.comfort = ctx.comfortYd == null ? 10 : ctx.comfortYd;
    this.spreadOf = (club) => ((ctx.spread && ctx.spread[club]) || SPREAD[club] || 4);
  };

  // wind: extra plays-like yards and sideways drift for a shot of hYd on bearing (deg from north)
  Engine.prototype.wind = function (hYd, bearing) {
    const w = this.ctx.wind;
    if (!w || !w.mph) return { add: 0, drift: 0 };
    const rel = ((w.fromDeg - bearing) * Math.PI) / 180;
    const head = w.mph * Math.cos(rel), cross = w.mph * Math.sin(rel);
    return { add: head > 0 ? hYd * 0.01 * head : hYd * 0.005 * head, drift: 0.8 * cross * hYd / 150 };
  };

  Engine.prototype.need = function (a, za, b, zb, club, lie) {
    const h = hyp(a, b) / 3, w = this.wind(h, bearingOf(a, b));
    const pl = playsLike(h, (zb - za) / 3, club.factor) + w.add;
    return { h, pl, carry: club.eff * (LIE[lie || "fairway"] || 1), drift: w.drift };
  };

  // ---- trees ----
  Engine.prototype.treeRisk = function (a, za, b, zb, clubName) {
    const D = hyp(a, b);
    if (D < 90) return { hit: 0, comfort: false };
    const c = this.byName[clubName], lift = flightShape(clubName, D, c ? c.carry : null);
    const ux = (b[0] - a[0]) / D, uz = (b[1] - a[1]) / D, nx = -uz, nz = ux;     // n: RIGHT of the shot (x east, z south)
    const sig = ((this.spreadOf(clubName) / 2) * Math.PI) / 180;
    const S = []; for (let s = 45; s < D; s += 12)   // first 15 yd: open in front of the ball
    S.push([s, za + ((zb - za) * s) / D + lift(s)]);
    let hit = 0;
    ANG.forEach((k, i) => {
      const t = k * sig, dx = ux * Math.cos(t) + nx * Math.sin(t), dz = uz * Math.cos(t) + nz * Math.sin(t);
      for (const [s, ball] of S) { const top = this.g.canopy(a[0] + dx * s, a[1] + dz * s); if (top > 0 && top > ball) { hit += WGT[i]; break; } }
    });
    const out = { hit: Math.round(hit * 1000) / 1000, comfort: false };
    const B = this.comfort * 3;
    for (const o of [-B, -B / 2, 0, B / 2, B]) {
      for (const [s, ball] of S) {
        if (s < 180) continue;
        const top = this.g.canopy(a[0] + ux * s + nx * o, a[1] + uz * s + nz * o);
        if (top > 0 && top > ball) {
          if (!out.comfort || s / 3 < out.atYd) Object.assign(out, { comfort: true, atYd: r(s / 3), side: o > 0 ? "right" : o < 0 ? "left" : "on the line" });
          break;
        }
      }
    }
    return out;
  };
  Engine.prototype.landRisk = function (p, a, clubName) {
    const D = hyp(a, p); if (D < 1) return 0;
    const ux = (p[0] - a[0]) / D, uz = (p[1] - a[1]) / D, nx = -uz, nz = ux;
    const sl = D * Math.tan(((this.spreadOf(clubName) / 2) * Math.PI) / 180), sd = 0.06 * D;
    let tot = 0, bad = 0;
    for (const i of [-2, -1, 0, 1, 2]) for (const j of [-2, -1, 0, 1, 2]) {
      const w = Math.exp(-(i * i + j * j) / 2), x = p[0] + i * sd * ux + j * sl * nx, z = p[1] + i * sd * uz + j * sl * nz;
      const top = this.g.canopy(x, z); tot += w; if (top > 0 && top - this.g.ground(x, z) >= 15) bad += w;
    }
    return bad / tot;
  };
  Engine.prototype.onFairway = function (q) {
    let n = 0, f = 0;
    for (let dx = -15; dx <= 15; dx += 7.5) for (let dz = -15; dz <= 15; dz += 7.5) { if (dx * dx + dz * dz > 225) continue; n++; if (this.g.fairway(q[0] + dx, q[1] + dz)) f++; }
    return f / n;
  };
  Engine.prototype.openGround = function (q) {
    const top = this.g.canopy(q[0], q[1]);
    return !(top > 0 && top - this.g.ground(q[0], q[1]) >= 5) && !this.waterNear(q, 30);
  };

  Engine.prototype.waterNear = function (p, rad) {
    for (let dx = -rad; dx <= rad; dx += 9) for (let dz = -rad; dz <= rad; dz += 9)
      if (dx * dx + dz * dz <= rad * rad && this.g.water(p[0] + dx, p[1] + dz)) return true;
    return false;
  };
  Engine.prototype.lineWater = function (a, b) {
    const L = hyp(a, b);
    for (let s = 30; s < L; s += 9) if (this.g.water(a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L)) return true;
    return false;
  };

  // ranked approach clubs to a target by how close the full carry fits
  Engine.prototype.approachFit = function (p, zp, tgt, zt, lie) {
    return this.approach.map((c) => {
      const n = this.need(p, zp, tgt, zt, c, lie);
      return { club: c.club, plays: n.pl, dist: n.h, gap: n.pl - n.carry, drift: n.drift, c };
    }).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
  };

  // landing spot of a full shot along a path (first point whose plays-like from the start equals the carry)
  Engine.prototype.land = function (path, z0, club, lie) {
    const a = path[0]; let s = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i], q = path[i + 1], L = hyp(p, q), n = Math.max(1, Math.round(L / 3));
      for (let k = 1; k <= n; k++) {
        const pt = [p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n];
        const zz = this.g.ground(pt[0], pt[1]), nd = this.need(a, z0, pt, zz, club, lie);
        if (nd.pl >= nd.carry) return { p: pt, z: zz, s: (s + (L * k) / n) / 3 };
      }
      s += L;
    }
    return null;
  };

  Engine.prototype.pathFrom = function (p, hole, pin) {
    const dP = hyp(p, pin);
    const bends = hole.line.slice(1, -1).filter((b) => hyp(b, pin) < dP - 30 && hyp(p, b) < dP);
    return [p, ...bends, pin];
  };

  // straight at the green: the best of the three clubs that fit, after tree risk
  Engine.prototype.go = function (p, zp, pin, zg, lie) {
    const fits = this.approachFit(p, zp, pin, zg, lie);
    if (fits[0].plays > this.maxCarry * (LIE[lie] || 1) + 10) return null;
    let best = null;
    for (const f of fits.slice(0, 3)) {
      if (Math.abs(f.gap) > 25) continue;
      const tr = this.treeRisk(p, zp, pin, zg, f.club);
      const v = strokes(f.plays, true) + GAP_COST * Math.abs(f.gap) + HIT_COST * tr.hit;
      const rank = v + (tr.comfort ? COMFORT_COST : 0);
      if (!best || rank < best.rank) best = { kind: "approach", club: f.club, plays: f.plays, dist: f.dist, gap: f.gap, drift: f.drift, tree: tr, target: pin, value: v, rank };
    }
    return best;
  };

  // open fairway spots that leave a full wedge or short iron: along the remaining line and up to 20 yd either side
  Engine.prototype.layupTargets = function (p, path, pin) {
    const pts = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], L = hyp(a, b), n = Math.max(1, Math.round(L / 6));
      for (let k = 0; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    const dP = hyp(p, pin), out = [];
    for (const c of LEAVES) {
      let i = -1; pts.forEach((q, k) => { if (hyp(q, pin) >= c * 3) i = k; });
      if (i < 0) continue;
      const q0 = pts[i], a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      const L = hyp(a, b) || 1, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
      for (const off of [-20, -10, 0, 10, 20]) {
        const q = [q0[0] + nx * off * 3, q0[1] + nz * off * 3];
        if (hyp(q, p) < 180 || hyp(q, pin) >= dP) continue;
        if (!this.openGround(q) || this.onFairway(q) < 0.6) continue;
        out.push(q);
      }
    }
    return out;
  };

  Engine.prototype.layup = function (p, zp, pin, zg, path, lie) {
    let best = null;
    for (const q of this.layupTargets(p, path, pin)) {
      const zq = this.g.ground(q[0], q[1]);
      const f = this.approachFit(p, zp, q, zq, lie)[0];
      if (Math.abs(f.gap) > 12) continue;
      const tr = this.treeRisk(p, zp, q, zq, f.club), lr = this.landRisk(q, p, f.club);
      const g2 = this.go(q, zq, pin, zg, "fairway"); if (!g2) continue;
      // never long, short, long: the layup is at least as long as the shot it leaves (two irons then a wedge is fine)
      if (f.plays < g2.plays) continue;
      const fq = this.byName[f.club].fairway != null ? this.byName[f.club].fairway : 0.85;
      const v = 1 + HIT_COST * tr.hit + LAND_COST * lr + GAP_COST * Math.abs(f.gap) + g2.value + (1 - fq) * rough(g2.plays);
      const rank = v + (g2.rank - g2.value) + (tr.comfort ? COMFORT_COST : 0);
      if (!best || rank < best.rank) best = { kind: "layup", club: f.club, plays: f.plays, dist: f.dist, gap: f.gap, drift: f.drift,
        target: q, tree: tr, landTrees: lr, leave: g2, value: v, rank };
    }
    return best;
  };

  /* The call from where you stand. Returns {mode, best, next, all, dist, plays, pin} with short reasons. */
  Engine.prototype.plan = function (p, hole, pin, opts) {
    const lie = opts.onTee ? "fairway" : opts.lie || "fairway";
    const zp = this.g.ground(p[0], p[1]), zg = this.g.ground(pin[0], pin[1]);
    const direct = this.approachFit(p, zp, pin, zg, lie)[0];
    const out = { dist: direct.dist, dz: zg - zp, pin, plays: direct.plays };
    const teeShot = opts.onTee && hole.par > 3;
    const reachable = direct.plays <= this.maxCarry * (LIE[lie] || 1) + 10;

    if (reachable && !(teeShot && direct.plays > 230)) {
      // approach: the clubs that fit, or a layup to open fairway when the trees make going at it a bad bet
      const fits = this.approachFit(p, zp, pin, zg, lie).slice(0, 3).filter((f) => Math.abs(f.gap) <= 25);
      const cands = fits.map((f) => {
        const tr = this.treeRisk(p, zp, pin, zg, f.club);
        const v = strokes(f.plays, true) + GAP_COST * Math.abs(f.gap) + HIT_COST * tr.hit;
        return { kind: "approach", club: f.club, plays: f.plays, dist: f.dist, gap: f.gap, drift: f.drift, tree: tr, target: pin,
          wet: this.waterNear(pin, 30) || this.lineWater(p, pin), value: v, rank: v + (tr.comfort ? COMFORT_COST : 0) };
      });
      const lay = hole.par > 3 || !opts.onTee ? this.layup(p, zp, pin, zg, this.pathFrom(p, hole, pin), lie) : null;
      if (lay) cands.push(lay);
      cands.sort((a, b) => a.rank - b.rank);
      cands.forEach((c) => (c.why = this.why(c, zg - zp)));
      return { ...out, mode: "approach", best: cands[0], next: cands[1], all: cands };
    }

    // full shot: tee club or long shot, each tried at aims up to 30 yd either side of the line
    const names = opts.onTee ? this.ctx.teeClubs : this.ctx.layupClubs;
    const opts2 = [];
    for (const name of names) {
      const c = this.byName[name]; if (!c) continue;
      const path = this.pathFrom(p, hole, pin);
      const l0 = this.land(path, zp, c, lie); if (!l0) continue;
      const D0 = hyp(p, l0.p);
      let best = null;
      for (const aim of [0, -10, 10, -20, 20, -30, 30]) {
        let l = l0;
        if (aim) {
          const ang = Math.atan2(aim * 3, D0), ux = (l0.p[0] - p[0]) / D0, uz = (l0.p[1] - p[1]) / D0;
          const dx = ux * Math.cos(ang) - uz * Math.sin(ang), dz = ux * Math.sin(ang) + uz * Math.cos(ang);
          l = this.land([p, [p[0] + dx * D0 * 1.6, p[1] + dz * D0 * 1.6]], zp, c, lie);
          if (!l || !this.openGround(l.p) || this.onFairway(l.p) < 0.6) continue;
        }
        const tr = this.treeRisk(p, zp, l.p, l.z, name), lr = this.landRisk(l.p, p, name);
        const fp = c.fairway != null ? c.fairway : 0.85;
        const g = this.go(l.p, l.z, pin, zg, "fairway"), ly = this.layup(l.p, l.z, pin, zg, this.pathFrom(l.p, hole, pin), "fairway");
        const nxt = !g ? ly : !ly ? g : (ly.rank < g.rank ? ly : g);
        if (!nxt) continue;
        const leavePlays = nxt.kind === "layup" ? nxt.leave.plays : nxt.plays;
        const v = 1 + HIT_COST * tr.hit + LAND_COST * lr + nxt.value + (1 - fp) * rough(leavePlays) + (this.waterNear(l.p, 30) ? WATER_COST * 0.3 : 0);
        const rank = v + (nxt.rank - nxt.value) + (tr.comfort ? COMFORT_COST : 0) + 0.002 * Math.abs(aim);
        const o = { kind: "full", club: name, land: l, aim, tree: tr, landTrees: lr, fp, next: nxt, value: v, rank, expected: v };
        if (!best || rank < best.rank) best = o;
      }
      if (best) opts2.push(best);
    }
    opts2.sort((a, b) => a.rank - b.rank);
    opts2.forEach((o) => (o.why = this.why(o, zg - zp, opts2[0])));
    return { ...out, mode: "full", best: opts2[0], next: opts2[1], all: opts2 };
  };

  // ---- reasons ----
  const treeWords = (tr) => tr && tr.comfort ? `trees ${tr.side === "on the line" ? "on the line" : tr.atYd + " yd out on the " + tr.side}`
    : tr && tr.hit >= 0.1 ? `${r(tr.hit * 100)}% of shots clip trees` : "";
  Engine.prototype.why = function (o, dzFt, best) {
    const parts = [];
    if (o.kind === "approach") {
      if (Math.abs(o.gap) < 2) parts.push(`a full ${o.club}`);
      else parts.push(`${o.club} ${o.gap > 0 ? "hit firm" : "a touch soft"} (${Math.abs(r(o.gap))} yd ${o.gap > 0 ? "more" : "less"} than full)`);
      if (Math.abs(dzFt) >= 6) parts.push(`green ${Math.abs(r(dzFt))} ft ${dzFt > 0 ? "up" : "down"}`);
      if (o.wet) parts.push("water near the line");
      if (Math.abs(o.drift) >= 3) parts.push(`aim ${Math.abs(r(o.drift))} yd ${o.drift > 0 ? "right" : "left"} for wind`);
    } else if (o.kind === "layup") {
      parts.push(`lay up ${r(o.dist)} yd to open fairway, leaves ${r(o.leave.plays)} for ${Math.abs(o.leave.gap) < 3 ? "a full " : ""}${o.leave.club}`);
      const lw = treeWords(o.leave.tree); if (lw) parts.push(`then ${lw}`);
    } else {
      const n = o.next;
      if (o.aim) parts.push(`aim ${Math.abs(o.aim)} yd ${o.aim > 0 ? "right" : "left"} of the line`);   // + turns right (z south)
      if (n.kind === "layup") parts.push(`then ${n.club} to open fairway, leaving ${r(n.leave.plays)} (${n.leave.club})`);
      else parts.push(`leaves ${r(n.plays)}, ${Math.abs(n.gap) < 3 ? "a full " + n.club : n.club + (n.gap > 0 ? " hit firm" : " soft")}`);
      if (o.fp != null && o.fp < 0.6) parts.push(`fairway ${r(o.fp * 100)}% of the time`);
      if (o.landTrees >= 0.1) parts.push(`${r(o.landTrees * 100)}% land among trees`);
      if (best && o !== best) parts.push(`${(o.value - best.value).toFixed(2)} strokes behind`);
    }
    const tw = treeWords(o.tree); if (tw) parts.push(tw);
    return parts.join(", ");
  };

  Engine.flightShape = flightShape;
  Engine.FLIGHT = FLIGHT;
  Engine.SPREAD = SPREAD;
  Engine.playsLike = playsLike;
  Engine.strokes = strokes;
  Engine.bearingOf = bearingOf;
  root.GCEngine = Engine;
  if (typeof module !== "undefined") module.exports = Engine;
})(typeof window !== "undefined" ? window : globalThis);
