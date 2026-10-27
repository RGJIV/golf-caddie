/* Aim view: the hole in 3D from where you stand, with the planned flight, aim point and landing.
   © 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential. */
(function (root) {
  "use strict";
  let renderer = null, tex = null, raf = 0;
  const APEX = { "58 deg": 80, "54 deg": 85, "48 deg": 88, PW: 90, "9i": 92, "8i": 94, "7i": 96, "6i": 97, "5i": 98, "4i": 100,
    "5 hybrid": 104, "3 wood": 108, Driver: 112 };

  function open(last, grids, C, E) {
    const wrap = document.getElementById("aim"), host = document.getElementById("aimView");
    wrap.hidden = false;
    const { plan, p, pin, h } = last, b = plan.best;
    const g = grids.g;
    const target = b ? (b.kind === "approach" ? pin : b.land.p) : pin;
    const drift = b && b.drift ? b.drift * 3 : 0;   // ft, + = aim right
    const dx = target[0] - p[0], dz = target[1] - p[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
    // aim point: the target moved into the wind; right of the shot line (facing ux, uz with x east, z south) is (-uz, ux)
    const aimPt = [target[0] - uz * drift, target[1] + ux * drift];

    // window around you, the target and the green
    const pts = [p, target, pin, ...h.line.slice(1)];
    const M = 450;
    const x0 = Math.max(0, Math.min(...pts.map((q) => q[0])) - M), x1 = Math.min(C.w, Math.max(...pts.map((q) => q[0])) + M);
    const z0 = Math.max(0, Math.min(...pts.map((q) => q[1])) - M), z1 = Math.min(C.h, Math.max(...pts.map((q) => q[1])) + M);
    const step = 6, nx = Math.floor((x1 - x0) / step) + 1, nz = Math.floor((z1 - z0) / step) + 1;

    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.outputEncoding = THREE.sRGBEncoding;
    }
    host.innerHTML = ""; host.appendChild(renderer.domElement);
    const W = host.clientWidth, Hh = host.clientHeight; renderer.setSize(W, Hh);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xbcd3de); scene.fog = new THREE.Fog(0xbcd3de, 1500, 4500);
    scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x4a5a3c, 0.8));
    const sun = new THREE.DirectionalLight(0xfff3dc, 0.7); sun.position.set(-0.6, 0.9, -0.35); scene.add(sun);

    // ground with the aerial
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + i * step, z = z0 + j * step;
      pos[k * 3] = x; pos[k * 3 + 1] = grids.ground(x, z); pos[k * 3 + 2] = z;
      uv[k * 2] = x / C.w; uv[k * 2 + 1] = 1 - z / C.h;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6); let n = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b2 = a + 1, c = a + nx, d = c + 1; idx[n++] = a; idx[n++] = c; idx[n++] = b2; idx[n++] = b2; idx[n++] = c; idx[n++] = d;
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(pos, 3)); gg.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    gg.setIndex(new THREE.BufferAttribute(idx, 1)); gg.computeVertexNormals();
    const gm = new THREE.MeshLambertMaterial({ color: 0x8aa070 });
    if (!tex) { tex = new THREE.TextureLoader().load("data/aerial.jpg", () => { gm.needsUpdate = true; }); tex.encoding = THREE.sRGBEncoding; }
    gm.map = tex; gm.color.set(0xffffff);
    scene.add(new THREE.Mesh(gg, gm));

    // canopy: the translucent green blob, cut away near you so nothing blocks the view
    const cg = grids.cg, CT = grids.CT;
    const ci0 = Math.floor(x0 / cg.g), ci1 = Math.min(cg.nx - 1, Math.ceil(x1 / cg.g)), cj0 = Math.floor(z0 / cg.g), cj1 = Math.min(cg.ny - 1, Math.ceil(z1 / cg.g));
    const cw = ci1 - ci0 + 1, ch = cj1 - cj0 + 1, cpos = new Float32Array(cw * ch * 3), ccol = new Float32Array(cw * ch * 3), col = new THREE.Color();
    const top = (i, j) => CT[(cj0 + j) * cg.nx + ci0 + i];
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const k = j * cw + i, x = (ci0 + i + 0.5) * cg.g, z = (cj0 + j + 0.5) * cg.g, gy = grids.ground(x, z), t = top(i, j) > 0 ? top(i, j) : gy;
      cpos[k * 3] = x; cpos[k * 3 + 1] = t; cpos[k * 3 + 2] = z;
      col.setHSL(0.27, 0.28, 0.24 + Math.min(1, (t - gy) / 110) * 0.16); ccol[k * 3] = col.r; ccol[k * 3 + 1] = col.g; ccol[k * 3 + 2] = col.b;
    }
    const cidx = [];
    for (let j = 0; j < ch - 1; j++) for (let i = 0; i < cw - 1; i++) {
      if (top(i, j) > 0 && top(i + 1, j) > 0 && top(i, j + 1) > 0 && top(i + 1, j + 1) > 0) {
        const a = j * cw + i; cidx.push(a, a + cw, a + 1, a + 1, a + cw, a + cw + 1);
      }
    }
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute("position", new THREE.BufferAttribute(cpos, 3)); cgeo.setAttribute("color", new THREE.BufferAttribute(ccol, 3));
    cgeo.setIndex(new THREE.BufferAttribute(new Uint32Array(cidx), 1)); cgeo.computeVertexNormals();
    const cm = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
    const uCam = { value: new THREE.Vector3(p[0], 0, p[1]) };
    cm.onBeforeCompile = (sh) => {
      sh.uniforms.uCam = uCam;
      sh.vertexShader = "varying vec3 vW;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = "uniform vec3 uCam; varying vec3 vW;\n" + sh.fragmentShader.replace("void main() {", "void main() {\n if (distance(vW.xz, uCam.xz) < 120.0) discard;");
    };
    const canopy = new THREE.Mesh(cgeo, cm); canopy.renderOrder = 2; scene.add(canopy);

    // flight: a simple arc that peaks a little past halfway, from your ball to the landing
    const zp = grids.ground(p[0], p[1]), zt = grids.ground(target[0], target[1]);
    const apex = b ? APEX[b.club] || 95 : 90, arc = [];
    for (let t = Math.min(0.08, 45 / L); t <= 1.0001; t += 0.02) {
      const s = t < 0.55 ? t / 0.55 : (1 - t) / 0.45;
      const x = p[0] + (aimPt[0] - p[0]) * t + (target[0] - aimPt[0]) * t * t, z = p[1] + (aimPt[1] - p[1]) * t + (target[1] - aimPt[1]) * t * t;
      arc.push(new THREE.Vector3(x, zp + (zt - zp) * t + apex * (1 - (1 - s) * (1 - s)) + 3, z));
    }
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc), 80, 0.9, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85 })));
    const ring = (q, color, r) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, 2.2, 6, 30), new THREE.MeshBasicMaterial({ color }));
      m.rotation.x = Math.PI / 2; m.position.set(q[0], grids.ground(q[0], q[1]) + 2, q[1]); scene.add(m);
    };
    ring(target, 0xe45bd6, 15);
    if (Math.abs(drift) > 6) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 40, 6), new THREE.MeshBasicMaterial({ color: 0x1b8cff }));
      pole.position.set(aimPt[0], grids.ground(aimPt[0], aimPt[1]) + 20, aimPt[1]); scene.add(pole);
    }
    // the flag
    const gy = grids.ground(pin[0], pin[1]);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 24, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    stick.position.set(pin[0], gy + 12, pin[1]); scene.add(stick);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(9, 6), new THREE.MeshBasicMaterial({ color: 0xe8503f, side: THREE.DoubleSide }));
    flag.position.set(pin[0] + 4.5, gy + 21, pin[1]); scene.add(flag);

    // camera: standing 25 ft behind your ball at 14 ft, looking down the shot; drag to look around
    const cam = new THREE.PerspectiveCamera(55, W / Hh, 1, 9000);
    const ex = p[0] - ux * 25, ez = p[1] - uz * 25;
    const eye = new THREE.Vector3(ex, Math.max(zp, grids.ground(ex, ez)) + 14, ez);
    uCam.value.set(ex, 0, ez);
    let yaw = Math.atan2(aimPt[0] - p[0], aimPt[1] - p[1]), pitch = -0.07;
    const look = () => { cam.position.copy(eye); cam.lookAt(eye.x + Math.sin(yaw) * Math.cos(pitch) * 100, eye.y + Math.sin(pitch) * 100, eye.z + Math.cos(yaw) * Math.cos(pitch) * 100); };
    look();
    let drag = null;
    const el = renderer.domElement;
    el.onpointerdown = (e) => { drag = [e.clientX, e.clientY, yaw, pitch]; el.setPointerCapture(e.pointerId); };
    el.onpointermove = (e) => { if (!drag) return; yaw = drag[2] + (e.clientX - drag[0]) * 0.005; pitch = Math.max(-0.6, Math.min(0.5, drag[3] + (e.clientY - drag[1]) * 0.004)); look(); };
    el.onpointerup = () => (drag = null);

    const info = document.getElementById("aimInfo");
    info.textContent = b ? `${b.club} · ${b.kind === "approach" ? "plays " + Math.round(b.plays) : "lands " + Math.round(b.land.s) + " yd out"}${Math.abs(drift) > 6 ? ` · aim ${Math.abs(Math.round(drift / 3))} yd ${drift > 0 ? "right" : "left"} (blue pole)` : ""}` : "No clear shot found";
    cancelAnimationFrame(raf);
    const loop = () => { renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
    loop();
    document.getElementById("aimClose").onclick = () => { cancelAnimationFrame(raf); wrap.hidden = true; gg.dispose(); cgeo.dispose(); };
  }

  root.GCAim = { open };
})(window);
