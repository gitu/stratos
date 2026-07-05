// Balloon mission planning — atmosphere, wind field, trajectory & lift models.
// All units metric. Altitudes in km unless noted.

const D2R = Math.PI / 180;

// ---------- ISA atmosphere ----------
export function isa(hKm) {
  const h = Math.max(0, Math.min(45, hKm)) * 1000;
  let T, p;
  if (h < 11000) {
    T = 288.15 - 0.0065 * h;
    p = 101325 * Math.pow(T / 288.15, 5.2561);
  } else if (h < 20000) {
    T = 216.65;
    p = 22632 * Math.exp(-9.80665 * (h - 11000) / (287.053 * T));
  } else {
    T = 216.65 + 0.001 * (h - 20000);
    p = 5474.9 * Math.pow(T / 216.65, -34.163);
  }
  const rho = p / (287.053 * T);
  return { T, p, rho };
}

export const GASES = {
  helium:   { R: 2077.1, name: 'He' },
  hydrogen: { R: 4124.2, name: 'H2' },
};

export function gasRho(hKm, gas) {
  const a = isa(hKm);
  return a.p / (GASES[gas].R * a.T);
}

// ---------- Lift / payload ----------
// cfg: { volume (m3, fully inflated), payloadKg, ballastKg, gas, type }
export function computePayload(cfg) {
  const V = cfg.volume;
  let envelopeKg = 0.045 * Math.pow(V, 0.8);
  if (cfg.type === 'roziere') envelopeKg *= 1.18; // hot-air cone + burner rig
  const mSys = cfg.payloadKg + envelopeKg + cfg.ballastKg;
  // float: V * (rhoAir(h) - rhoGas(h)) = mSys  -> bisect
  const netAt = (h) => V * (isa(h).rho - gasRho(h, cfg.gas)) - mSys;
  let ceiling = null;
  if (netAt(0) > 0) {
    let lo = 0, hi = 40;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (netAt(mid) > 0) lo = mid; else hi = mid;
    }
    ceiling = lo;
  }
  const gasMassKg = ceiling != null ? gasRho(ceiling, cfg.gas) * V : gasRho(0, cfg.gas) * V;
  const launchGasM3 = gasMassKg / gasRho(0, cfg.gas);
  const grossKg = mSys + gasMassKg;
  const freeLiftKg = 0.10 * mSys;
  // control band + endurance by type
  let bandLo, bandHi, budgetKm, capDays;
  const c = ceiling ?? 0;
  const dailyBallast = 0.025 * mSys;                 // kg/day (diurnal compensation, ZP)
  const kmCost = 0.010 * mSys;                       // kg per km of altitude maneuvering
  if (cfg.type === 'superpressure') {
    bandLo = c; bandHi = c; budgetKm = 0;
    capDays = 100;
  } else if (cfg.type === 'zeropressure') {
    bandHi = c; bandLo = Math.max(3, c - 4);
    budgetKm = cfg.ballastKg > 0 ? (0.5 * cfg.ballastKg) / kmCost : 0;
    capDays = Math.min(45, Math.max(2, (0.5 * cfg.ballastKg) / dailyBallast));
  } else if (cfg.type === 'roziere') {
    // hybrid gas cell + heated air cone: the burner replaces ballast drops for
    // diurnal compensation, so the consumable is fuel — modest control band,
    // cheap per-km trim, endurance well beyond zero-pressure
    bandHi = c; bandLo = Math.max(4, c - 6);
    budgetKm = cfg.ballastKg > 0 ? (0.9 * cfg.ballastKg) / (0.5 * kmCost) : 0;
    capDays = Math.min(70, Math.max(3, (0.9 * cfg.ballastKg) / (0.35 * dailyBallast)));
  } else { // adjustable — vented descent reaches down into tropospheric jet layers
    bandHi = c; bandLo = Math.min(Math.max(5, c - 15), Math.max(5, c));
    budgetKm = cfg.ballastKg > 0 ? (0.8 * cfg.ballastKg) / (0.3 * kmCost) : 0;
    capDays = Math.min(60, Math.max(3, (0.8 * cfg.ballastKg) / (0.6 * dailyBallast)));
  }
  return {
    envelopeKg, mSys, ceiling, gasMassKg, launchGasM3, grossKg, freeLiftKg,
    bandLo, bandHi, budgetKm, capDays,
    canLift: ceiling != null && ceiling > 3,
  };
}

// ---------- Ensemble perturbations (Monte Carlo wind uncertainty) ----------
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ZERO_ENS = { p1: 0, p2: 0, p3: 0, amp: 1, vamp: 1, dlat: 0 };
export function ensembleWind(seed) {
  const r = mulberry(seed);
  return {
    p1: (r() - 0.5) * 1.6, p2: (r() - 0.5) * 2.2, p3: (r() - 0.5) * 1.8,
    amp: 0.82 + 0.36 * r(), vamp: 0.80 + 0.40 * r(), dlat: (r() - 0.5) * 5,
  };
}

// ---------- Live wind field (Open-Meteo pressure-level data) ----------
// field: { lats[], lons[], alts[], hours, u: Float32Array, v: Float32Array }
// index order: ((t * nAlt + a) * nLat + y) * nLon + x
let LIVE = null;
export function setLiveField(f) { LIVE = f; }
export function hasLive() { return !!LIVE; }

function liveWind(lat, lon, alt, tH) {
  const f = LIVE;
  if (!f || tH < 0 || tH > f.hours - 1.001) return null;
  const la = f.lats, lo = f.lons, al = f.alts;
  if (lat < la[0] || lat > la[la.length - 1]) return null;
  if (alt > al[al.length - 1] + 3) return null; // above data ceiling -> synthetic
  const nLat = la.length, nLon = lo.length, nAlt = al.length;
  // fractional indices
  const fi = (arr, x) => {
    if (x <= arr[0]) return 0;
    if (x >= arr[arr.length - 1]) return arr.length - 1.0001;
    let i = 0;
    while (i < arr.length - 2 && arr[i + 1] < x) i++;
    return i + (x - arr[i]) / (arr[i + 1] - arr[i]);
  };
  const dLon = lo[1] - lo[0];
  let xF = (wrapLon(lon - lo[0]) + 360) % 360 / dLon; // wraps
  const yF = fi(la, lat), aF = fi(al, Math.max(al[0], Math.min(al[nAlt - 1], alt))), tF = Math.min(f.hours - 1.0001, tH);
  const x0 = Math.floor(xF) % nLon, x1 = (x0 + 1) % nLon, xr = xF - Math.floor(xF);
  const y0 = Math.floor(yF), y1 = Math.min(nLat - 1, y0 + 1), yr = yF - y0;
  const a0 = Math.floor(aF), a1 = Math.min(nAlt - 1, a0 + 1), ar = aF - a0;
  const t0 = Math.floor(tF), t1 = Math.min(f.hours - 1, t0 + 1), tr = tF - t0;
  const at = (arr, t, a, y, x) => arr[((t * nAlt + a) * nLat + y) * nLon + x];
  const tri = (arr, t) => {
    const c00 = at(arr, t, a0, y0, x0) * (1 - xr) + at(arr, t, a0, y0, x1) * xr;
    const c01 = at(arr, t, a0, y1, x0) * (1 - xr) + at(arr, t, a0, y1, x1) * xr;
    const c10 = at(arr, t, a1, y0, x0) * (1 - xr) + at(arr, t, a1, y0, x1) * xr;
    const c11 = at(arr, t, a1, y1, x0) * (1 - xr) + at(arr, t, a1, y1, x1) * xr;
    return (c00 * (1 - yr) + c01 * yr) * (1 - ar) + (c10 * (1 - yr) + c11 * yr) * ar;
  };
  const u = tri(f.u, t0) * (1 - tr) + tri(f.u, t1) * tr;
  const v = tri(f.v, t0) * (1 - tr) + tri(f.v, t1) * tr;
  if (!isFinite(u) || !isFinite(v)) return null;
  return { u, v };
}

// ---------- Wind field (simulated climatological + synoptic waves) ----------
// Returns {u, v} m/s (u east+, v north+) at lat, lon (deg), alt (km), t (hours from T0)
// ens: optional ensemble perturbation from ensembleWind()
export function windAt(lat, lon, alt, tH, ens) {
  const E = ens || ZERO_ENS;
  if (LIVE) {
    const lw = liveWind(lat, lon, alt, tH);
    if (lw) return { u: lw.u * E.amp, v: lw.v * E.vamp };
  }
  const Td = tH / 24;
  const lam = lon * D2R;
  // Rossby-wave meander of jet axis (deg lat), drifting east
  const m1 = Math.sin(4 * lam + 0.55 * Td + E.p1);
  const m2 = Math.sin(6 * lam - 0.9 * Td + 1.7 + E.p2);
  const m3 = Math.sin(3 * lam + 0.32 * Td + 0.6 + E.p3);
  const meander = 6.5 * m1 + 3.5 * m2 + 4.0 * m3;
  const dMeander = 6.5 * 4 * Math.cos(4 * lam + 0.55 * Td + E.p1)
                 + 3.5 * 6 * Math.cos(6 * lam - 0.9 * Td + 1.7 + E.p2)
                 + 4.0 * 3 * Math.cos(3 * lam + 0.32 * Td + 0.6 + E.p3);
  let u = 0, v = 0;
  const jet = (cLat0, cAlt, wLat, wAlt, peak, meanderScale) => {
    const cLat = cLat0 + E.dlat * Math.sign(cLat0);
    const cl = cLat + meander * meanderScale;
    const g = Math.exp(-Math.pow((lat - cl) / wLat, 2)) * Math.exp(-Math.pow((alt - cAlt) / wAlt, 2));
    u += peak * g;
    v += peak * g * 0.055 * dMeander * meanderScale * Math.sign(cLat === 0 ? 1 : 1);
  };
  // NH (northern-summer config: jets weaker, shifted poleward) & SH (winter: strong)
  jet( 42, 11.5, 7.5, 3.5, 30, 0.9);   // NH subtropical/eddy-driven merged
  jet( 62,  9.5, 8.0, 3.0, 20, 1.1);   // NH polar jet
  jet(-30, 12.0, 7.0, 3.5, 46, 0.8);   // SH subtropical jet (austral winter, strong)
  jet(-55,  9.5, 9.0, 3.0, 38, 1.0);   // SH polar jet
  // Tropical low-level easterlies (trades)
  u -= 7 * Math.exp(-Math.pow(lat / 13, 2)) * Math.exp(-Math.pow((alt - 2.5) / 3, 2));
  // Tropical easterly jet aloft (monsoon, NH summer)
  u -= 20 * Math.exp(-Math.pow((lat - 9) / 7, 2)) * Math.exp(-Math.pow((alt - 14.5) / 2.5, 2));
  // Stratospheric QBO easterlies (tropics, ~20-28 km)
  u -= 16 * Math.exp(-Math.pow(lat / 14, 2)) * Math.exp(-Math.pow((alt - 24) / 5, 2));
  // SH stratospheric polar-night vortex westerlies
  u += 34 * Math.exp(-Math.pow((lat + 60) / 11, 2)) * Math.exp(-Math.pow((alt - 26) / 8, 2));
  // NH summer stratospheric easterlies
  u -= 10 * Math.exp(-Math.pow((lat - 45) / 25, 2)) * Math.exp(-Math.pow((alt - 25) / 7, 2));
  // Synoptic texture
  const tex = Math.sin(lat * 0.35 + 2 * lam + 0.8 * Td) * Math.cos(lat * 0.21 - 3 * lam + 0.5 * Td);
  u += 2.5 * tex;
  v += 3.0 * Math.sin(lat * 0.3 - 2.5 * lam + 0.7 * Td + 2.1) * Math.exp(-Math.pow((alt - 9) / 6, 2))
     + 1.5 * Math.cos(lat * 0.5 + 1.5 * lam - 0.4 * Td);
  return { u: u * E.amp, v: v * E.vamp };
}

// ---------- Geo helpers ----------
export function gcKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R, dl = wrapLon(lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function wrapLon(d) {
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------- Trajectory simulation with altitude steering ----------
// opts: { bandLo, bandHi, budgetKm, capDays, captureKm, decideEveryH, altPenalty, stayBias, t0H, ens }
export function simulate(start, target, opts) {
  const o = Object.assign({ captureKm: 200, decideEveryH: 1, altPenalty: 0.9, stayBias: 1.5, t0H: 0, ens: null }, opts);
  let lat = start.lat, lon = start.lon;
  let alt = o.bandHi;
  let budget = o.budgetKm;
  const dt = 3600; // 1 h
  const maxSteps = Math.round(o.capDays * 24);
  const path = [{ lat, lon, alt, t: 0 }];
  let closest = gcKm(lat, lon, target.lat, target.lon);
  let arrived = false, tArr = null, flown = 0, altUsedKm = 0;
  for (let s = 1; s <= maxSteps; s++) {
    const tH = s - 1;
    // decision: pick altitude within band maximizing progress toward target
    if ((tH % o.decideEveryH) === 0 && o.bandHi > o.bandLo) {
      const dLat = target.lat - lat;
      const dLon = wrapLon(target.lon - lon);
      const ex0 = dLon * Math.cos(lat * D2R), ey0 = dLat;
      const n = Math.hypot(ex0, ey0) || 1;
      const ex = ex0 / n, ey = ey0 / n;
      // staying put is the baseline, with a bias: a move must beat the current
      // layer by stayBias m/s of progress (after the per-km penalty) to happen
      const wStay = windAt(lat, lon, alt, o.t0H + tH, o.ens);
      let best = alt, bestScore = wStay.u * ex + wStay.v * ey + o.stayBias;
      for (let a = o.bandLo; a <= o.bandHi + 1e-6; a += 1) {
        const cost = Math.abs(a - alt);
        if (cost < 1e-9 || cost > budget) continue;
        const w = windAt(lat, lon, a, o.t0H + tH, o.ens);
        const score = w.u * ex + w.v * ey - o.altPenalty * cost;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      if (best !== alt) {
        budget -= Math.abs(best - alt);
        altUsedKm += Math.abs(best - alt);
        alt = best;
      }
    }
    const w = windAt(lat, lon, alt, o.t0H + tH, o.ens);
    const spd = Math.hypot(w.u, w.v);
    flown += spd * dt / 1000;
    lat += (w.v * dt) / 111320;
    lon = wrapLon(lon + (w.u * dt) / (111320 * Math.max(0.12, Math.cos(lat * D2R))));
    lat = Math.max(-88, Math.min(88, lat));
    path.push({ lat, lon, alt, t: s });
    const d = gcKm(lat, lon, target.lat, target.lon);
    if (d < closest) closest = d;
    if (d <= o.captureKm) { arrived = true; tArr = s; break; }
  }
  return { path, arrived, tArrH: tArr, closestKm: closest, flownKm: flown, altUsedKm, budgetLeftKm: budget };
}

// ---------- Candidate launch countries (coarse polygons, lon/lat) ----------
export const COUNTRIES = [
  { id: 'usa', name: 'United States', poly: [[-124,48],[-124,40],[-120,34],[-114,32],[-106,31],[-97,26],[-90,29],[-84,30],[-81,25],[-80,32],[-75,38],[-70,43],[-67,45],[-83,46],[-95,49],[-110,49]] },
  { id: 'canada', name: 'Canada', poly: [[-130,54],[-125,49],[-95,49],[-83,46],[-79,43],[-74,45],[-67,45],[-60,47],[-56,52],[-60,55],[-70,60],[-78,58],[-85,55],[-92,57],[-95,62],[-110,68],[-125,69],[-135,60]] },
  { id: 'brazil', name: 'Brazil', poly: [[-70,-4],[-60,2],[-52,4],[-44,-3],[-35,-5],[-35,-9],[-39,-15],[-40,-22],[-48,-28],[-53,-30],[-57,-30],[-58,-20],[-65,-10]] },
  { id: 'argentina', name: 'Argentina', poly: [[-70,-22],[-62,-22],[-58,-27],[-58,-34],[-62,-40],[-65,-45],[-68,-52],[-71,-52],[-70,-40],[-70,-30]] },
  { id: 'sweden', name: 'Sweden', poly: [[12,58],[14,56],[16,57],[19,60],[21,63],[24,66],[21,69],[17,68],[14,64],[12,61]] },
  { id: 'france', name: 'France', poly: [[-4,48],[-2,44],[3,42],[7,44],[8,49],[4,51],[0,49]] },
  { id: 'italy', name: 'Italy', poly: [[7,45],[13,46],[14,42],[18,40],[16,39],[12,42],[9,44]] },
  { id: 'uk', name: 'United Kingdom', poly: [[-5,50],[-3,53],[-5,57],[-2,58],[0,53],[1,51]] },
  { id: 'russia', name: 'Russia', poly: [[30,60],[40,66],[60,69],[80,72],[110,74],[130,72],[150,72],[170,70],[178,66],[160,60],[140,55],[135,50],[120,52],[100,52],[85,54],[70,55],[55,52],[40,55]] },
  { id: 'india', name: 'India', poly: [[69,23],[72,20],[75,15],[77,8],[80,13],[84,19],[88,22],[89,26],[80,29],[73,30]] },
  { id: 'china', name: 'China', poly: [[80,45],[75,39],[80,32],[90,28],[97,25],[105,23],[110,21],[114,22],[118,25],[121,30],[121,38],[126,42],[122,45],[115,45],[105,42],[95,45],[87,48]] },
  { id: 'japan', name: 'Japan', poly: [[130,31],[135,34],[140,35],[141,41],[144,44],[140,43],[136,36],[131,32]] },
  { id: 'australia', name: 'Australia', poly: [[114,-22],[114,-34],[118,-35],[124,-33],[132,-32],[138,-35],[141,-38],[147,-38],[150,-37],[153,-30],[153,-25],[149,-20],[146,-19],[142,-11],[137,-16],[132,-12],[126,-14],[122,-18]] },
  { id: 'nz', name: 'New Zealand', poly: [[173,-34],[178,-38],[174,-42],[168,-46],[166,-45],[172,-40]] },
  { id: 'southafrica', name: 'South Africa', poly: [[17,-29],[19,-34],[26,-34],[32,-29],[31,-24],[25,-24],[20,-25]] },
  { id: 'mexico', name: 'Mexico', poly: [[-115,32],[-114,30],[-110,23],[-105,19],[-96,16],[-92,15],[-90,19],[-97,26],[-100,29],[-106,31]] },
  { id: 'chile', name: 'Chile', poly: [[-70,-18],[-68,-24],[-69,-32],[-70,-40],[-72,-48],[-74,-52],[-75,-48],[-73,-40],[-71,-32],[-70,-25],[-71,-19]] },
  { id: 'peru', name: 'Peru', poly: [[-81,-5],[-76,-14],[-70,-17],[-69,-13],[-72,-9],[-75,-4],[-78,-3]] },
  { id: 'colombia', name: 'Colombia', poly: [[-77,7],[-75,2],[-70,0],[-67,3],[-70,7],[-72,11],[-76,9]] },
  { id: 'germany', name: 'Germany', poly: [[7,49],[10,47.5],[13,48],[15,51],[14,54],[10,54.5],[7,53],[6,51]] },
  { id: 'spain', name: 'Spain', poly: [[-9,43],[-9,37],[-6,36],[-2,37],[0,39],[3,42],[-2,43]] },
  { id: 'norway', name: 'Norway', poly: [[5,58],[7,62],[12,65],[15,68],[20,70],[25,71],[22,69],[16,67],[12,64],[8,61],[6,59]] },
  { id: 'finland', name: 'Finland', poly: [[21,60],[28,61],[30,63],[29,67],[26,70],[22,68],[22,64],[21,61]] },
  { id: 'poland', name: 'Poland', poly: [[15,51],[14,54],[18,55],[23,54],[24,51],[19,50]] },
  { id: 'ukraine', name: 'Ukraine', poly: [[24,51],[22,48],[29,46],[33,46],[38,47],[40,49],[34,52],[28,51]] },
  { id: 'turkey', name: 'Turkey', poly: [[27,40],[27,37],[36,36],[44,37],[43,40],[35,42],[29,41]] },
  { id: 'egypt', name: 'Egypt', poly: [[25,31],[25,22],[34,22],[34,27],[32,31]] },
  { id: 'nigeria', name: 'Nigeria', poly: [[3,6],[6,4],[9,4],[13,9],[13,13],[5,13],[3,9]] },
  { id: 'kenya', name: 'Kenya', poly: [[34,4],[34,-1],[38,-3],[41,-2],[41,4],[36,5]] },
  { id: 'namibia', name: 'Namibia', poly: [[12,-18],[15,-28],[19,-28],[20,-22],[20,-18],[14,-17]] },
  { id: 'saudi', name: 'Saudi Arabia', poly: [[37,30],[39,21],[43,17],[48,17],[55,22],[52,28],[45,29]] },
  { id: 'iran', name: 'Iran', poly: [[45,39],[48,30],[56,26],[61,25],[61,34],[57,38],[48,39]] },
  { id: 'kazakhstan', name: 'Kazakhstan', poly: [[47,49],[52,45],[58,45],[68,47],[80,45],[85,47],[85,50],[75,54],[65,54],[55,52],[47,51]] },
  { id: 'mongolia', name: 'Mongolia', poly: [[88,49],[95,50],[105,52],[115,50],[119,48],[112,45],[105,42],[95,45],[90,47]] },
  { id: 'pakistan', name: 'Pakistan', poly: [[62,25],[67,24],[71,28],[75,32],[73,36],[71,34],[66,29],[62,26]] },
  { id: 'thailand', name: 'Thailand', poly: [[98,19],[101,20],[105,17],[102,13],[100,8],[99,12],[98,16]] },
  { id: 'indonesia', name: 'Indonesia', poly: [[95,5],[103,-5],[106,-3],[98,3]] },
  { id: 'iceland', name: 'Iceland', poly: [[-22,64],[-15,64],[-14,66],[-20,66]] },
];

export function pointInPoly(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function samplePoints(poly, want = 8) {
  let lo0 = 1e9, lo1 = -1e9, la0 = 1e9, la1 = -1e9;
  for (const [lo, la] of poly) { lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); la0 = Math.min(la0, la); la1 = Math.max(la1, la); }
  const step = Math.max(1.2, Math.sqrt(((lo1 - lo0) * (la1 - la0)) / want));
  const pts = [];
  for (let la = la0 + step / 2; la < la1; la += step) {
    for (let lo = lo0 + step / 2; lo < lo1; lo += step) {
      if (pointInPoly(lo, la, poly)) pts.push({ lon: Math.round(lo * 10) / 10, lat: Math.round(la * 10) / 10 });
    }
  }
  if (!pts.length) {
    let cx = 0, cy = 0;
    for (const [lo, la] of poly) { cx += lo; cy += la; }
    pts.push({ lon: cx / poly.length, lat: cy / poly.length });
  }
  return pts.slice(0, 14);
}

export function samplePointsInCircle(center, radiusKm, want = 14) {
  const dLat = radiusKm / 111;
  const step = (2 * dLat) / Math.max(2, Math.sqrt(want) + 1);
  const pts = [];
  const cosC = Math.max(0.15, Math.cos(center.lat * D2R));
  for (let la = center.lat - dLat; la <= center.lat + dLat; la += step) {
    for (let lo = center.lon - dLat / cosC; lo <= center.lon + dLat / cosC; lo += step / cosC) {
      if (gcKm(la, wrapLon(lo), center.lat, center.lon) <= radiusKm) {
        pts.push({ lat: Math.round(la * 10) / 10, lon: Math.round(wrapLon(lo) * 10) / 10 });
      }
    }
  }
  if (!pts.length) pts.push({ lat: center.lat, lon: center.lon });
  return pts.slice(0, 18);
}

// Rank individual launch points within a chosen area.
// Nominal simulation for every point; Monte Carlo for the top `mcTop`.
export function rankPoints(pts, target, perf, captureKm = 200, t0H = 0, members = 6, mcTop = 5) {
  const opts = {
    bandLo: perf.bandLo, bandHi: perf.bandHi,
    budgetKm: perf.budgetKm, capDays: perf.capDays, captureKm, t0H,
  };
  const out = pts.map((pt) => ({
    site: { name: '', lat: pt.lat, lon: pt.lon },
    ...simulate(pt, target, opts),
    mc: null,
    directKm: gcKm(pt.lat, pt.lon, target.lat, target.lon),
  }));
  out.sort((a, b) => {
    if (a.arrived !== b.arrived) return a.arrived ? -1 : 1;
    if (a.arrived) return a.tArrH - b.tArrH;
    return a.closestKm - b.closestKm;
  });
  out.forEach((r, i) => { r.site.name = 'PT ' + String(i + 1).padStart(2, '0'); });
  for (let i = 0; i < Math.min(mcTop, out.length); i++) {
    out[i].mc = monteCarloDay(out[i].site, target, perf, t0H, members, captureKm);
  }
  return out;
}

// For each country: scan candidate points inside it, pick the optimal launch point,
// then Monte Carlo the winner.
export function rankCountries(target, perf, captureKm = 200, t0H = 0, members = 6) {
  const opts = {
    bandLo: perf.bandLo, bandHi: perf.bandHi,
    budgetKm: perf.budgetKm, capDays: perf.capDays, captureKm, t0H,
  };
  const out = COUNTRIES.map((c) => {
    const cands = samplePoints(c.poly, 8);
    let bestR = null, bestPt = null;
    const scored = [];
    for (const pt of cands) {
      const r = simulate(pt, target, opts);
      scored.push({ lon: pt.lon, lat: pt.lat, arrived: r.arrived });
      if (!bestR || better(r, bestR)) { bestR = r; bestPt = pt; }
    }
    const mc = monteCarloDay(bestPt, target, perf, t0H, members, captureKm);
    return {
      site: { name: c.name, lat: bestPt.lat, lon: bestPt.lon },
      country: c, candidates: scored,
      ...bestR, mc,
      directKm: gcKm(bestPt.lat, bestPt.lon, target.lat, target.lon),
    };
  });
  out.sort((a, b) => {
    if (a.mc.p !== b.mc.p) return b.mc.p - a.mc.p;
    if (a.mc.p > 0 && a.mc.medT != null && b.mc.medT != null) return a.mc.medT - b.mc.medT;
    return a.mc.medClosest - b.mc.medClosest;
  });
  return out;
}

// ---------- Launch sites (established balloon facilities) ----------
export const SITES = [
  { id: 'esrange',  name: 'Esrange, Sweden',        lat: 67.9,  lon: 21.1 },
  { id: 'ftsumner', name: 'Fort Sumner, USA',        lat: 34.5,  lon: -104.2 },
  { id: 'palestine',name: 'Palestine, USA',          lat: 31.8,  lon: -95.7 },
  { id: 'timmins',  name: 'Timmins, Canada',         lat: 48.6,  lon: -81.4 },
  { id: 'wanaka',   name: 'Wanaka, New Zealand',     lat: -44.7, lon: 169.2 },
  { id: 'alice',    name: 'Alice Springs, Australia',lat: -23.8, lon: 133.9 },
  { id: 'hyderabad',name: 'Hyderabad, India',        lat: 17.5,  lon: 78.6 },
  { id: 'taiki',    name: 'Taiki, Japan',            lat: 42.5,  lon: 143.4 },
  { id: 'trapani',  name: 'Trapani, Italy',          lat: 38.0,  lon: 12.5 },
  { id: 'mcmurdo',  name: 'McMurdo, Antarctica',     lat: -77.8, lon: 166.7 },
];

export function rankSites(target, perf, captureKm = 200, t0H = 0, members = 6) {
  const opts = {
    bandLo: perf.bandLo, bandHi: perf.bandHi,
    budgetKm: perf.budgetKm, capDays: perf.capDays, captureKm, t0H,
  };
  const out = SITES.map((s) => {
    const r = simulate(s, target, opts); // nominal member (drawn on map)
    const mc = monteCarloDay(s, target, perf, t0H, members, captureKm);
    return { site: s, ...r, mc, directKm: gcKm(s.lat, s.lon, target.lat, target.lon) };
  });
  out.sort((a, b) => {
    if (a.mc.p !== b.mc.p) return b.mc.p - a.mc.p;
    if (a.mc.p > 0 && a.mc.medT != null && b.mc.medT != null) return a.mc.medT - b.mc.medT;
    return a.mc.medClosest - b.mc.medClosest;
  });
  return out;
}

// One Monte Carlo member for a site + launch time (m = 0 is the nominal run).
// Callers can accumulate members incrementally and fold them with mcAggregate.
export function mcMember(site, target, perf, t0H, m, captureKm = 200) {
  const ens = m === 0 ? null : ensembleWind(m * 7919 + Math.round(t0H) * 131 + 17);
  return simulate(site, target, {
    bandLo: perf.bandLo, bandHi: perf.bandHi, budgetKm: perf.budgetKm,
    capDays: perf.capDays, captureKm, t0H, ens,
  });
}

export function mcAggregate(runs) {
  const times = [], closests = [];
  let arrivals = 0;
  for (const r of runs) {
    if (r.arrived) { arrivals++; times.push(r.tArrH); }
    closests.push(r.closestKm);
  }
  times.sort((a, b) => a - b); closests.sort((a, b) => a - b);
  return {
    p: arrivals / runs.length,
    medT: times.length ? times[Math.floor(times.length / 2)] : null,
    medClosest: closests[Math.floor(closests.length / 2)],
    members: runs.length,
  };
}

// Monte Carlo over wind uncertainty for one site + launch time
export function monteCarloDay(site, target, perf, t0H, members = 6, captureKm = 200) {
  const runs = [];
  for (let m = 0; m < members; m++) runs.push(mcMember(site, target, perf, t0H, m, captureKm));
  return mcAggregate(runs);
}

// Compare launch candidates that may start on different days: prefer arrival,
// then earliest absolute arrival (launch delay + flight time), then closest approach.
export function betterLaunch(a, b) {
  if (a.arrived !== b.arrived) return a.arrived;
  const offA = (a.startDay || 0) * 24, offB = (b.startDay || 0) * 24;
  if (a.arrived) return offA + a.tArrH < offB + b.tArrH;
  return a.closestKm < b.closestKm;
}

// Scan launch dates for one site: P(arrival) vs start day
export function launchWindow(site, target, perf, { days = 21, stepDays = 2, members = 6, captureKm = 200 } = {}) {
  const out = [];
  for (let d = 0; d <= days; d += stepDays) {
    const mc = monteCarloDay(site, target, perf, d * 24, members, captureKm);
    out.push({ day: d, ...mc });
  }
  return out;
}

// Compare altitude strategies for one launch site with the same envelope
export function compareStrategies(site, target, cfg, captureKm = 200, t0H = 0) {
  const rows = [];
  // 1. superpressure: best fixed altitude
  const sp = computePayload({ ...cfg, type: 'superpressure' });
  let bestSP = null;
  if (sp.canLift) {
    for (let a = Math.max(8, sp.ceiling - 14); a <= sp.ceiling + 0.01; a += 2) {
      const r = simulate(site, target, { bandLo: a, bandHi: a, budgetKm: 0, capDays: sp.capDays, captureKm, t0H });
      if (!bestSP || better(r, bestSP.r)) bestSP = { r, alt: a };
    }
  }
  rows.push({ key: 'superpressure', label: 'Superpressure — constant altitude',
    detail: bestSP ? `hold ${bestSP.alt.toFixed(0)} km` : 'cannot float', r: bestSP?.r ?? null });
  // 2. zero-pressure, ballast-limited
  const zp = computePayload({ ...cfg, type: 'zeropressure' });
  rows.push({ key: 'zeropressure', label: 'Zero-pressure — ballast steering',
    detail: zp.canLift ? `${zp.bandLo.toFixed(0)}–${zp.bandHi.toFixed(0)} km band` : 'cannot float',
    r: zp.canLift ? simulate(site, target, { bandLo: zp.bandLo, bandHi: zp.bandHi, budgetKm: zp.budgetKm, capDays: zp.capDays, captureKm, t0H }) : null });
  // 3. Rozière hybrid, fuel-limited
  const rz = computePayload({ ...cfg, type: 'roziere' });
  rows.push({ key: 'roziere', label: 'Rozière — hybrid gas/hot-air, burner trim',
    detail: rz.canLift ? `${rz.bandLo.toFixed(0)}–${rz.bandHi.toFixed(0)} km band` : 'cannot float',
    r: rz.canLift ? simulate(site, target, { bandLo: rz.bandLo, bandHi: rz.bandHi, budgetKm: rz.budgetKm, capDays: rz.capDays, captureKm, t0H }) : null });
  // 4. altitude-adjustable
  const aj = computePayload({ ...cfg, type: 'adjustable' });
  rows.push({ key: 'adjustable', label: 'Adjustable — vent/ballast wind-layer steering',
    detail: aj.canLift ? `${aj.bandLo.toFixed(0)}–${aj.bandHi.toFixed(0)} km band` : 'cannot float',
    r: aj.canLift ? simulate(site, target, { bandLo: aj.bandLo, bandHi: aj.bandHi, budgetKm: aj.budgetKm, capDays: aj.capDays, captureKm, t0H }) : null });
  return rows;
}
function better(a, b) {
  if (a.arrived !== b.arrived) return a.arrived;
  if (a.arrived) return a.tArrH < b.tArrH;
  return a.closestKm < b.closestKm;
}

// ---------- Major cities (t = display tier, 1 = always) ----------
export const CITIES = [
  { n: 'New York', lon: -74.0, lat: 40.7, t: 1 }, { n: 'Los Angeles', lon: -118.2, lat: 34.1, t: 1 },
  { n: 'Mexico City', lon: -99.1, lat: 19.4, t: 1 }, { n: 'São Paulo', lon: -46.6, lat: -23.6, t: 1 },
  { n: 'Buenos Aires', lon: -58.4, lat: -34.6, t: 1 }, { n: 'London', lon: -0.1, lat: 51.5, t: 1 },
  { n: 'Paris', lon: 2.35, lat: 48.9, t: 1 }, { n: 'Moscow', lon: 37.6, lat: 55.8, t: 1 },
  { n: 'Cairo', lon: 31.2, lat: 30.0, t: 1 }, { n: 'Lagos', lon: 3.4, lat: 6.5, t: 1 },
  { n: 'Dubai', lon: 55.3, lat: 25.3, t: 1 }, { n: 'Mumbai', lon: 72.9, lat: 19.1, t: 1 },
  { n: 'Delhi', lon: 77.2, lat: 28.6, t: 1 }, { n: 'Beijing', lon: 116.4, lat: 39.9, t: 1 },
  { n: 'Shanghai', lon: 121.5, lat: 31.2, t: 1 }, { n: 'Tokyo', lon: 139.7, lat: 35.7, t: 1 },
  { n: 'Singapore', lon: 103.8, lat: 1.35, t: 1 }, { n: 'Jakarta', lon: 106.8, lat: -6.2, t: 1 },
  { n: 'Sydney', lon: 151.2, lat: -33.9, t: 1 }, { n: 'Johannesburg', lon: 28.0, lat: -26.2, t: 1 },
  { n: 'Chicago', lon: -87.6, lat: 41.9, t: 2 }, { n: 'Toronto', lon: -79.4, lat: 43.7, t: 2 },
  { n: 'Vancouver', lon: -123.1, lat: 49.3, t: 2 }, { n: 'Houston', lon: -95.4, lat: 29.8, t: 2 },
  { n: 'Miami', lon: -80.2, lat: 25.8, t: 2 }, { n: 'Lima', lon: -77.0, lat: -12.0, t: 2 },
  { n: 'Bogotá', lon: -74.1, lat: 4.7, t: 2 }, { n: 'Santiago', lon: -70.7, lat: -33.5, t: 2 },
  { n: 'Rio de Janeiro', lon: -43.2, lat: -22.9, t: 2 }, { n: 'Istanbul', lon: 29.0, lat: 41.0, t: 2 },
  { n: 'Berlin', lon: 13.4, lat: 52.5, t: 2 }, { n: 'Madrid', lon: -3.7, lat: 40.4, t: 2 },
  { n: 'Rome', lon: 12.5, lat: 41.9, t: 2 }, { n: 'Stockholm', lon: 18.1, lat: 59.3, t: 2 },
  { n: 'Warsaw', lon: 21.0, lat: 52.2, t: 2 }, { n: 'Kyiv', lon: 30.5, lat: 50.5, t: 2 },
  { n: 'Athens', lon: 23.7, lat: 38.0, t: 2 }, { n: 'Nairobi', lon: 36.8, lat: -1.3, t: 2 },
  { n: 'Riyadh', lon: 46.7, lat: 24.7, t: 2 }, { n: 'Tehran', lon: 51.4, lat: 35.7, t: 2 },
  { n: 'Karachi', lon: 67.0, lat: 24.9, t: 2 }, { n: 'Dhaka', lon: 90.4, lat: 23.8, t: 2 },
  { n: 'Bangkok', lon: 100.5, lat: 13.8, t: 2 }, { n: 'Manila', lon: 121.0, lat: 14.6, t: 2 },
  { n: 'Hong Kong', lon: 114.2, lat: 22.3, t: 2 }, { n: 'Seoul', lon: 127.0, lat: 37.6, t: 2 },
  { n: 'Osaka', lon: 135.5, lat: 34.7, t: 2 }, { n: 'Melbourne', lon: 145.0, lat: -37.8, t: 2 },
  { n: 'Auckland', lon: 174.8, lat: -36.8, t: 2 }, { n: 'Anchorage', lon: -149.9, lat: 61.2, t: 2 },
  { n: 'Reykjavik', lon: -21.9, lat: 64.1, t: 2 }, { n: 'Casablanca', lon: -7.6, lat: 33.6, t: 2 },
  { n: 'San Francisco', lon: -122.4, lat: 37.8, t: 3 }, { n: 'Seattle', lon: -122.3, lat: 47.6, t: 3 },
  { n: 'Denver', lon: -105.0, lat: 39.7, t: 3 }, { n: 'Montreal', lon: -73.6, lat: 45.5, t: 3 },
  { n: 'Havana', lon: -82.4, lat: 23.1, t: 3 }, { n: 'Caracas', lon: -66.9, lat: 10.5, t: 3 },
  { n: 'Quito', lon: -78.5, lat: -0.2, t: 3 }, { n: 'Montevideo', lon: -56.2, lat: -34.9, t: 3 },
  { n: 'Cape Town', lon: 18.4, lat: -33.9, t: 3 }, { n: 'Dakar', lon: -17.5, lat: 14.7, t: 3 },
  { n: 'Addis Ababa', lon: 38.7, lat: 9.0, t: 3 }, { n: 'Baghdad', lon: 44.4, lat: 33.3, t: 3 },
  { n: 'Tashkent', lon: 69.2, lat: 41.3, t: 3 }, { n: 'Almaty', lon: 76.9, lat: 43.2, t: 3 },
  { n: 'Ulaanbaatar', lon: 106.9, lat: 47.9, t: 3 }, { n: 'Chengdu', lon: 104.1, lat: 30.7, t: 3 },
  { n: 'Kolkata', lon: 88.4, lat: 22.6, t: 3 }, { n: 'Ho Chi Minh City', lon: 106.7, lat: 10.8, t: 3 },
  { n: 'Taipei', lon: 121.6, lat: 25.0, t: 3 }, { n: 'Brisbane', lon: 153.0, lat: -27.5, t: 3 },
  { n: 'Perth', lon: 115.9, lat: -32.0, t: 3 }, { n: 'Darwin', lon: 130.8, lat: -12.5, t: 3 },
  { n: 'Novosibirsk', lon: 82.9, lat: 55.0, t: 3 }, { n: 'Vladivostok', lon: 131.9, lat: 43.1, t: 3 },
  { n: 'Honolulu', lon: -157.9, lat: 21.3, t: 3 },
];

// ---------- Coarse coastlines (lon,lat) for ops map ----------
export const CONTINENTS = [
  // North America
  [[-168,66],[-165,60],[-153,57],[-145,60],[-135,57],[-130,52],[-125,48],[-122,37],[-117,32],[-110,23],[-105,20],[-96,16],[-92,14],[-85,11],[-79,9],[-83,12],[-87,14],[-95,18],[-97,26],[-91,29],[-84,30],[-81,25],[-80,28],[-75,35],[-70,42],[-66,45],[-60,46],[-65,49],[-56,52],[-60,55],[-70,60],[-78,58],[-85,55],[-92,57],[-95,62],[-90,66],[-95,68],[-110,68],[-125,70],[-140,70],[-155,71],[-165,68]],
  // Greenland
  [[-45,60],[-53,66],[-55,70],[-58,76],[-68,78],[-60,81],[-45,83],[-32,83],[-22,80],[-20,75],[-25,70],[-40,65]],
  // South America
  [[-77,7],[-79,2],[-81,-5],[-76,-14],[-70,-18],[-71,-30],[-73,-40],[-74,-50],[-71,-54],[-65,-55],[-65,-45],[-62,-40],[-57,-38],[-53,-34],[-48,-28],[-40,-22],[-39,-15],[-35,-9],[-35,-5],[-44,-3],[-50,0],[-52,4],[-60,8],[-64,10],[-71,12],[-75,10]],
  // Africa
  [[-6,35],[-10,31],[-15,24],[-17,21],[-17,15],[-12,8],[-8,5],[-1,5],[4,6],[9,4],[9,-1],[12,-6],[12,-18],[14,-23],[17,-30],[19,-34],[26,-34],[32,-29],[35,-24],[40,-16],[39,-10],[40,-3],[43,4],[47,8],[51,11],[44,11],[43,12],[39,16],[37,21],[34,28],[32,31],[25,32],[18,30],[10,34],[10,37],[0,36]],
  // Eurasia
  [[-9,43],[-9,37],[-5,36],[0,39],[3,42],[6,43],[10,44],[14,41],[16,38],[19,40],[22,37],[24,38],[27,37],[30,36],[36,36],[35,33],[34,29],[35,28],[39,21],[43,12],[48,14],[55,17],[60,25],[66,25],[70,21],[72,19],[75,15],[77,8],[80,13],[84,19],[88,22],[92,20],[94,16],[98,10],[100,3],[103,1],[101,7],[100,13],[105,10],[109,13],[108,18],[106,20],[110,21],[114,22],[118,25],[121,29],[121,32],[119,35],[122,37],[126,35],[128,39],[130,42],[135,44],[137,50],[141,53],[147,59],[162,56],[158,52],[163,60],[170,64],[179,66],[178,69],[170,70],[150,72],[130,72],[110,74],[100,78],[80,72],[70,68],[60,69],[45,68],[40,66],[33,69],[28,71],[18,69],[12,65],[5,61],[6,58],[10,56],[12,54],[7,54],[5,53],[4,51],[0,49],[-2,48],[-4,48],[-1,46],[-2,44]],
  // Britain
  [[-5,50],[-3,53],[-5,57],[-2,58],[0,53],[1,51]],
  // Iceland
  [[-22,64],[-15,64],[-14,66],[-20,66]],
  // Japan
  [[130,31],[135,34],[140,35],[141,41],[144,44],[140,43],[136,36],[131,32]],
  // Sumatra
  [[95,5],[103,-5],[106,-3],[98,3]],
  // Borneo
  [[109,0],[113,-4],[118,-1],[117,4],[110,4]],
  // Java
  [[105,-6],[114,-8],[108,-7]],
  // New Guinea
  [[131,-1],[138,-4],[146,-8],[141,-9],[134,-4]],
  // Philippines
  [[120,16],[123,13],[122,18]],
  // Madagascar
  [[44,-12],[50,-16],[47,-25],[44,-20]],
  // Australia
  [[114,-22],[114,-34],[118,-35],[124,-33],[132,-32],[138,-35],[141,-38],[147,-38],[150,-37],[153,-30],[153,-25],[149,-20],[146,-19],[142,-11],[137,-16],[132,-12],[126,-14],[122,-18]],
  // New Zealand
  [[173,-34],[178,-38],[174,-42],[168,-46],[166,-45],[172,-40]],
  // Antarctica
  [[-180,-71],[-160,-74],[-120,-73],[-90,-72],[-62,-65],[-57,-63],[-61,-70],[-40,-73],[0,-70],[40,-68],[80,-67],[120,-66],[160,-70],[180,-71],[180,-89],[-180,-89]],
];
