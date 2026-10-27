/* Course data on the phone: ground, tree tops and water grids, GPS to course coordinates.
   © 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential. */
(function (root) {
  "use strict";

  async function pixels(url, w, h) {
    const blob = await (await fetch(url)).blob();
    let src;
    try { src = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
    catch (e) {
      src = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = URL.createObjectURL(blob); });
    }
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(src, 0, 0);
    return cx.getImageData(0, 0, w, h).data;
  }
  const decode16 = (px, n) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = ((px[i * 4] << 8) | px[i * 4 + 1]) / 10; return a; };

  async function loadCourse(dir) {
    const C = await (await fetch(`${dir}/course.json`)).json();
    const g = C.grid, cg = C.canopy;
    const [hp, cp, wp] = await Promise.all([pixels(`${dir}/height.png`, g.nx, g.ny), pixels(`${dir}/canopy.png`, cg.nx, cg.ny),
      pixels(`${dir}/water.png`, cg.nx, cg.ny)]);
    const H = decode16(hp, g.nx * g.ny), CT = decode16(cp, cg.nx * cg.ny);
    const WT = new Uint8Array(cg.nx * cg.ny); for (let i = 0; i < WT.length; i++) WT[i] = wp[i * 4] > 127 ? 1 : 0;
    const cell = (x, z) => { const i = Math.floor(x / cg.g), j = Math.floor(z / cg.g); return i < 0 || j < 0 || i >= cg.nx || j >= cg.ny ? -1 : j * cg.nx + i; };
    const grids = {
      ground(x, z) {
        const fx = Math.min(Math.max(x / g.g, 0), g.nx - 1.001), fz = Math.min(Math.max(z / g.g, 0), g.ny - 1.001);
        const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = j * g.nx + i;
        return H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + g.nx] * (1 - a) * b + H[k + g.nx + 1] * a * b;
      },
      canopy(x, z) { const k = cell(x, z); return k < 0 ? 0 : CT[k]; },
      water(x, z) { const k = cell(x, z); return k >= 0 && WT[k] > 0; },
      H, CT, g, cg,
    };
    const P = C.proj;
    const q = (a, b, f) => f[0] + f[1] * a + f[2] * b + f[3] * a * a + f[4] * a * b + f[5] * b * b;
    const toLocal = (lat, lon) => { const u = (lon - P.lon0) * 1e3, v = (lat - P.lat0) * 1e3; return [q(u, v, P.fx), q(u, v, P.fz)]; };
    const toLatLon = (x, z) => { const a = x / 1e3, b = z / 1e3; return [P.lat0 + q(a, b, P.gv) / 1e3, P.lon0 + q(a, b, P.gu) / 1e3]; };
    return { C, grids, toLocal, toLatLon };
  }

  root.GCGeo = { loadCourse };
})(window);
