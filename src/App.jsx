import React from 'react';
import * as sim from './sim.js';

const MONO = "'IBM Plex Mono', monospace";
const PANEL_BORDER = '1px solid #1b2530';

export default class App extends React.Component {
  sim = sim;

  state = {
    target: { lat: 48.1, lon: 11.5 },
    cfg: { volume: 25000, payloadKg: 900, ballastKg: 300, gas: 'helium', type: 'adjustable' },
    selected: 0, scrubH: 0, playing: false, showWinds: true, rev: 0, launchDay: 0,
    globe: true, windSource: 'synthetic', fetching: false, liveError: false,
    clickMode: 'target', areaMode: 'country', areaCountryId: 'usa', customArea: null,
  };

  async fetchLive() {
    this.setState({ fetching: true, liveError: false });
    try {
      const lats = []; for (let la = -70; la <= 74; la += 16) lats.push(la);
      const lons = []; for (let lo = -180; lo < 180; lo += 24) lons.push(lo);
      const levels = [850, 500, 300, 250, 200, 100, 50];
      const alts = [1.5, 5.6, 9.2, 10.4, 11.8, 16.2, 20.6];
      const vars = levels.map((p) => 'wind_speed_' + p + 'hPa,wind_direction_' + p + 'hPa').join(',');
      const fetchRow = async (la) => {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lons.map(() => la).join(',')
          + '&longitude=' + lons.join(',') + '&hourly=' + vars
          + '&forecast_days=14&timezone=GMT&wind_speed_unit=ms';
        // Open-Meteo rate-limits bursts (429) — retry with backoff
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(url);
          if (r.ok) {
            const j = await r.json();
            return Array.isArray(j) ? j : [j];
          }
          if (r.status !== 429 || attempt >= 4) throw new Error('http ' + r.status);
          await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt) + Math.random() * 400));
        }
      };
      // limited concurrency to stay under the burst limit
      const rows = new Array(lats.length);
      let next = 0;
      await Promise.all([0, 1].map(async () => {
        while (next < lats.length) {
          const i = next++;
          rows[i] = await fetchRow(lats[i]);
        }
      }));
      const nLat = lats.length, nLon = lons.length, nAlt = levels.length;
      const times = rows[0][0].hourly.time;
      const hours = times.length;
      const D2R = Math.PI / 180;
      const u = new Float32Array(hours * nAlt * nLat * nLon);
      const v = new Float32Array(hours * nAlt * nLat * nLon);
      for (let y = 0; y < nLat; y++) {
        for (let xI = 0; xI < nLon; xI++) {
          const h = rows[y][xI].hourly;
          for (let a = 0; a < nAlt; a++) {
            const sp = h['wind_speed_' + levels[a] + 'hPa'];
            const di = h['wind_direction_' + levels[a] + 'hPa'];
            for (let t = 0; t < hours; t++) {
              const idx = ((t * nAlt + a) * nLat + y) * nLon + xI;
              const s = sp && sp[t] != null ? sp[t] : NaN;
              const d = di && di[t] != null ? di[t] * D2R : NaN;
              u[idx] = -s * Math.sin(d);
              v[idx] = -s * Math.cos(d);
            }
          }
        }
      }
      this._liveField = { lats, lons, alts, hours, u, v };
      const t0s = times[0];
      this._liveStart = Date.parse(t0s.includes('Z') ? t0s : t0s + ':00Z');
      this.sim.setLiveField(this._liveField);
      this.setState({ fetching: false, windSource: 'live', scrubH: 0 });
      this.recompute();
    } catch (err) {
      console.warn('open-meteo fetch failed', err);
      this.setState({ fetching: false, liveError: true });
    }
  }

  componentDidMount() {
    this.results = []; this.strategies = []; this.windowData = []; this.perf = null;
    this.view = { lon: 0, lat: 25, zoom: 1 };
    this._tiles = new Map();
    this.buildMask();
    this.loadTexture();
    this.loadBorders();
    this.recompute();
    // actual forecast data is the default wind model — fetch on startup
    this.fetchLive();
    this._onResize = () => this.drawAll();
    window.addEventListener('resize', this._onResize);
  }
  componentWillUnmount() {
    window.removeEventListener('resize', this._onResize);
    cancelAnimationFrame(this._raf);
    clearTimeout(this._deb);
    clearTimeout(this._planTimer);
    this._planGen = (this._planGen || 0) + 1;
    if (this._ro) this._ro.disconnect();
  }
  componentDidUpdate() {
    this.drawAll();
  }

  // ---------- data ----------
  captureKm() { return this.state.captureKmUI ?? 200; }

  t0H() { return this.state.launchDay * 24; }

  // ---------- Web-Mercator + OSM tiles ----------
  mercY(lat) {
    const l = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + l / 2));
  }
  invMerc(m) { return (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI; }
  tileSet(z) {
    // close-up: switch to full street maps with labels (distortion negligible locally)
    if (z != null && z >= 6) return 'dark_all';
    return 'dark_nolabels';
  }
  tileFor(z, tx, ty) {
    const n = 1 << z;
    tx = ((tx % n) + n) % n;
    if (ty < 0 || ty >= n) return null;
    const set = this.tileSet(z);
    const key = set + '/' + z + '/' + tx + '/' + ty;
    let t = this._tiles.get(key);
    if (!t) {
      t = new Image();
      t.crossOrigin = 'anonymous';
      t.onload = () => { this._osmKey = null; this.queueDraw(); };
      t.src = 'https://' + 'abcd'[(tx + ty) % 4] + '.basemaps.cartocdn.com/' + set + '/' + z + '/' + tx + '/' + ty + '.png';
      this._tiles.set(key, t);
    }
    return (t.complete && t.naturalWidth) ? t : null;
  }
  queueDraw() {
    if (this._qd) return;
    this._qd = requestAnimationFrame(() => { this._qd = null; this.drawMap(); });
  }
  markInteracting() {
    this._lowRes = true;
    clearTimeout(this._lowT);
    this._lowT = setTimeout(() => { this._lowRes = false; this.queueDraw(); }, 180);
  }

  // ---------- 3D globe ----------
  buildMask() {
    const c = document.createElement('canvas'); c.width = 720; c.height = 360;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    for (const poly of this.sim.CONTINENTS) {
      ctx.beginPath();
      poly.forEach(([lo, la], i) => {
        const px = (lo + 180) * 2, py = (90 - la) * 2;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath(); ctx.fill();
    }
    this._maskData = ctx.getImageData(0, 0, 720, 360).data;
    this._sphereKey = null;
    this.queueDraw();
  }
  thinRing(r, max) {
    if (r.length <= max) return r;
    const step = Math.ceil(r.length / max);
    const o = [];
    for (let i = 0; i < r.length; i += step) o.push(r[i]);
    return o;
  }
  ringArea(r) {
    let a = 0;
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }
  loadBorders() {
    const iso = {
      usa: 'USA', canada: 'CAN', brazil: 'BRA', argentina: 'ARG', sweden: 'SWE', france: 'FRA',
      italy: 'ITA', uk: 'GBR', russia: 'RUS', india: 'IND', china: 'CHN', japan: 'JPN',
      australia: 'AUS', nz: 'NZL', southafrica: 'ZAF', mexico: 'MEX', chile: 'CHL', peru: 'PER',
      colombia: 'COL', germany: 'DEU', spain: 'ESP', norway: 'NOR', finland: 'FIN', poland: 'POL',
      ukraine: 'UKR', turkey: 'TUR', egypt: 'EGY', nigeria: 'NGA', kenya: 'KEN', namibia: 'NAM',
      saudi: 'SAU', iran: 'IRN', kazakhstan: 'KAZ', mongolia: 'MNG', pakistan: 'PAK',
      thailand: 'THA', indonesia: 'IDN', iceland: 'ISL',
    };
    fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
      .then((r) => r.json())
      .then((gj) => {
        const byIso = {};
        for (const f of gj.features || []) byIso[f.id] = f.geometry;
        for (const c of this.sim.COUNTRIES) {
          const g = byIso[iso[c.id]];
          if (!g || !g.coordinates) continue;
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          const rings = polys.map((p) => this.thinRing(p[0], 240)).filter((r) => r.length > 3);
          if (!rings.length) continue;
          let best = null, bestA = 0;
          for (const r of rings) { const a = this.ringArea(r); if (a > bestA) { bestA = a; best = r; } }
          c.rings = rings;
          if (best) c.poly = this.thinRing(best, 110);
        }
        this._sphereKey = null;
        this.recompute();
      })
      .catch((err) => console.warn('border fetch failed, using coarse polygons', err));
  }
  loadTexture() {
    const urls = [
      'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Blue_Marble_2002.png/2048px-Blue_Marble_2002.png',
      'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Whole_world_-_land_and_oceans.jpg/2048px-Whole_world_-_land_and_oceans.jpg',
    ];
    const tryOne = (i) => {
      if (i >= urls.length) return;
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const w = 2048, h = 1024;
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(im, 0, 0, w, h);
          const d = ctx.getImageData(0, 0, w, h);
          this._texData = { d: d.data, w, h };
          this._sphereKey = null;
          this.queueDraw();
        } catch (err) { tryOne(i + 1); }
      };
      im.onerror = () => tryOne(i + 1);
      im.src = urls[i];
    };
    tryOne(0);
  }
  prepOsm(R, W, H) {
    const v = this.view;
    let tz = Math.max(3, Math.min(12, Math.round(Math.log2(2 * Math.PI * R / 256))));
    const extent = Math.min(360, 2 * Math.asin(Math.min(1, (Math.min(W, H) / 2) / R)) * 57.3 * 1.25 + 8);
    const mercOf = (latDeg) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85.05, Math.min(85.05, latDeg)) * Math.PI / 360));
    let xt0, xt1, yt0, yt1, n;
    for (;;) {
      n = 1 << tz;
      if (extent >= 359) { xt0 = 0; xt1 = n - 1; } else {
        xt0 = Math.floor(((v.lon - extent / 2 + 180) / 360) * n);
        xt1 = Math.floor(((v.lon + extent / 2 + 180) / 360) * n);
      }
      const latTop = Math.min(85, v.lat + extent / 2), latBot = Math.max(-85, v.lat - extent / 2);
      yt0 = Math.max(0, Math.floor((1 - mercOf(latTop) / Math.PI) / 2 * n));
      yt1 = Math.min(n - 1, Math.floor((1 - mercOf(latBot) / Math.PI) / 2 * n));
      if ((xt1 - xt0 + 1) * (yt1 - yt0 + 1) <= 120 || tz <= 3) break;
      tz--;
    }
    let loaded = 0;
    for (let ty = yt0; ty <= yt1; ty++) for (let tx = xt0; tx <= xt1; tx++) if (this.tileFor(tz, tx, ty)) loaded++;
    const fullKey = [this.tileSet(), tz, xt0, xt1, yt0, yt1, loaded].join(',');
    if (this._osmKey === fullKey) return;
    this._osmKey = fullKey;
    if (!loaded) { this._osm = null; this._sphereKey = null; return; }
    const w = (xt1 - xt0 + 1) * 256, h = (yt1 - yt0 + 1) * 256;
    const c = this._osmCanvas || (this._osmCanvas = document.createElement('canvas'));
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = this.tileSet() === 'dark_nolabels' ? '#0b0f14' : '#d4dadc';
    ctx.fillRect(0, 0, w, h);
    for (let ty = yt0; ty <= yt1; ty++) for (let tx = xt0; tx <= xt1; tx++) {
      const img = this.tileFor(tz, tx, ty);
      if (img) ctx.drawImage(img, (tx - xt0) * 256, (ty - yt0) * 256);
    }
    try {
      const d = ctx.getImageData(0, 0, w, h);
      this._osm = { d: d.data, w, h, n, xt0, yt0 };
    } catch (err) { this._osm = null; }
    this._sphereKey = null;
  }

  renderSphere(R, lon0, lat0, dark, W, H) {
    const sf = this._lowRes ? 0.5 : 1;
    const rectW = Math.min(Math.ceil(2 * R) + 2, W), rectH = Math.min(Math.ceil(2 * R) + 2, H);
    const bw = Math.max(2, Math.ceil(rectW * sf)), bh = Math.max(2, Math.ceil(rectH * sf));
    const oc = this._globeCanvas || (this._globeCanvas = document.createElement('canvas'));
    oc.width = bw; oc.height = bh;
    this._sphereRect = { rectW, rectH };
    const octx = oc.getContext('2d');
    const img = octx.createImageData(bw, bh);
    const o = img.data;
    const D2R = Math.PI / 180;
    const sin0 = Math.sin(lat0 * D2R), cos0 = Math.cos(lat0 * D2R);
    const tex = this._texData, mask = this._maskData;
    const ccx = rectW / 2, ccy = rectH / 2;
    for (let j = 0; j < bh; j++) {
      const vy = (j + 0.5) / sf, yy = (ccy - vy) / R;
      for (let i = 0; i < bw; i++) {
        const vx = (i + 0.5) / sf, xx = (vx - ccx) / R;
        const r2 = xx * xx + yy * yy;
        const idx = (j * bw + i) * 4;
        if (r2 > 1) { o[idx + 3] = 0; continue; }
        const z = Math.sqrt(1 - r2);
        const sphi = Math.max(-1, Math.min(1, yy * cos0 + z * sin0));
        const latDeg = Math.asin(sphi) / D2R;
        let lonDeg = lon0 + Math.atan2(xx, z * cos0 - yy * sin0) / D2R;
        lonDeg = ((lonDeg + 540) % 360) - 180;
        let r = 12, g = 18, b = 26;
        const osm = this._osm;
        let done = false;
        if (osm) {
          let fx = (lonDeg + 180) / 360 * osm.n - osm.xt0;
          if (fx < 0) fx += osm.n;
          if (fx >= osm.n) fx -= osm.n;
          const px = fx * 256;
          const mm = Math.log(Math.tan(Math.PI / 4 + Math.max(-85.05, Math.min(85.05, latDeg)) * D2R / 2));
          const pyy = ((1 - mm / Math.PI) / 2 * osm.n - osm.yt0) * 256;
          if (px >= 0 && px < osm.w && pyy >= 0 && pyy < osm.h) {
            const ti = ((pyy | 0) * osm.w + (px | 0)) * 4;
            r = osm.d[ti]; g = osm.d[ti + 1]; b = osm.d[ti + 2];
            done = true;
          }
        }
        if (!done && tex) {
          const u = Math.min(tex.w - 1, ((lonDeg + 180) / 360 * tex.w) | 0);
          const vv = Math.max(0, Math.min(tex.h - 1, ((90 - latDeg) / 180 * tex.h) | 0));
          const ti = (vv * tex.w + u) * 4;
          r = tex.d[ti]; g = tex.d[ti + 1]; b = tex.d[ti + 2];
          if (dark) {
            const gray = (r * 77 + g * 151 + b * 28) >> 8;
            r = 10 + gray * 0.42; g = 16 + gray * 0.55; b = 24 + gray * 0.7;
          }
        } else if (!done && mask) {
          const u = Math.min(719, ((lonDeg + 180) * 2) | 0);
          const vv = Math.max(0, Math.min(359, ((90 - latDeg) * 2) | 0));
          const land = mask[(vv * 720 + u) * 4] > 100;
          if (dark) { r = land ? 30 : 12; g = land ? 42 : 18; b = land ? 56 : 26; }
          else { r = land ? 203 : 214; g = land ? 212 : 226; b = land ? 200 : 231; }
        }
        const shade = 0.55 + 0.45 * z;
        o[idx] = r * shade; o[idx + 1] = g * shade; o[idx + 2] = b * shade; o[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
  }

  recompute() {
    if (!this.sim) return;
    const { cfg, target } = this.state;
    this.perf = this.sim.computePayload(cfg);
    let pts = [], areaCountry = null;
    if (this.state.areaMode === 'custom') {
      if (this.state.customArea) {
        pts = this.sim.samplePointsInCircle(this.state.customArea, this.state.customArea.radiusKm, 14);
      }
    } else {
      areaCountry = this.sim.COUNTRIES.find((c) => c.id === this.state.areaCountryId) || this.sim.COUNTRIES[0];
      pts = this.sim.samplePoints(areaCountry.poly, 12);
    }
    if (this.perf.canLift && pts.length) {
      this.startPlanner(pts, target, areaCountry);
    } else {
      this._planGen = (this._planGen || 0) + 1;
      clearTimeout(this._planTimer);
      this.results = []; this.strategies = []; this.windowData = [];
      this.plannerStatus = null;
      this.setState((s) => ({ rev: s.rev + 1, selected: 0, scrubH: 0 }));
    }
  }

  // Incremental planner: every launch point is tried at several start days
  // ("launch over the next few days"), evaluated in small async batches so the
  // ranked list grows live, then the top points' arrival probability is refined
  // one Monte Carlo member at a time before strategies/window are computed.
  startPlanner(pts, target, areaCountry) {
    const gen = this._planGen = (this._planGen || 0) + 1;
    clearTimeout(this._planTimer);
    // routes are about to be replaced — don't keep flying along a stale one
    if (this.state.playing) { cancelAnimationFrame(this._raf); this.setState({ playing: false }); }
    const perf = this.perf, captureKm = this.captureKm(), baseT0 = this.t0H();
    const SCAN_DAYS = 4, MC_TOP = 5, MC_MEMBERS = 10, BATCH = 6;
    // day-major order: the whole field shows up at day 0 first, later days refine
    const cands = [];
    for (let d = 0; d <= SCAN_DAYS; d++) pts.forEach((pt, pi) => cands.push({ pt, pi, day: d }));
    const byPoint = pts.map(() => []);
    this.plannerStatus = { phase: 'sim', done: 0, total: cands.length, mcDone: 0, mcTotal: 0 };
    this.results = [];

    const rebuild = () => {
      const built = [];
      for (const vars of byPoint) {
        if (!vars.length) continue;
        vars.sort((a, b) => (this.sim.betterLaunch(a, b) ? -1 : 1));
        const best = vars[0];
        built.push({
          ...best,
          site: { name: '', lat: best.site.lat, lon: best.site.lon },
          variants: vars, _v: best, mc: best.mc || null,
          country: areaCountry || undefined,
          directKm: this.sim.gcKm(best.site.lat, best.site.lon, target.lat, target.lon),
        });
      }
      built.sort((a, b) => (this.sim.betterLaunch(a, b) ? -1 : 1));
      built.forEach((r, i) => { r.site.name = 'PT ' + String(i + 1).padStart(2, '0'); });
      this.results = built;
    };
    const bump = () => this.setState((s) => ({
      rev: s.rev + 1,
      selected: Math.min(s.selected, Math.max(0, this.results.length - 1)),
      scrubH: Math.min(s.scrubH, this.scrubMaxH()),
    }));

    let ci = 0, mcRound = 1, mcDone = 0;
    const simTick = () => {
      if (gen !== this._planGen) return;
      const end = Math.min(ci + BATCH, cands.length);
      for (; ci < end; ci++) {
        const c = cands[ci];
        const t0H = baseT0 + c.day * 24;
        const r = this.sim.simulate(c.pt, target, {
          bandLo: perf.bandLo, bandHi: perf.bandHi, budgetKm: perf.budgetKm,
          capDays: perf.capDays, captureKm, t0H,
        });
        byPoint[c.pi].push({ ...r, startDay: c.day, t0H, mc: null, site: { name: '', lat: c.pt.lat, lon: c.pt.lon } });
      }
      this.plannerStatus.done = ci;
      rebuild();
      bump();
      this._planTimer = setTimeout(ci < cands.length ? simTick : mcTick, 0);
    };
    const mcTick = () => {
      if (gen !== this._planGen) return;
      if (mcRound >= MC_MEMBERS || !this.results.length) { finish(); return; }
      const top = this.results.slice(0, MC_TOP);
      this.plannerStatus.phase = 'mc';
      this.plannerStatus.mcTotal = top.length * (MC_MEMBERS - 1);
      for (const res of top) {
        if (!res._runs) res._runs = [{ arrived: res.arrived, tArrH: res.tArrH, closestKm: res.closestKm }];
        res._runs.push(this.sim.mcMember(res.site, target, perf, res.t0H, mcRound, captureKm));
        res.mc = this.sim.mcAggregate(res._runs);
        res._v.mc = res.mc;
        mcDone++;
      }
      this.plannerStatus.mcDone = mcDone;
      mcRound++;
      bump();
      this._planTimer = setTimeout(mcTick, 0);
    };
    const finish = () => {
      if (gen !== this._planGen) return;
      this.plannerStatus = { phase: 'done' };
      this.recomputeSelection();
    };
    this._planTimer = setTimeout(simTick, 0);
  }

  // Light recompute on selection/variant change: strategies + launch window only.
  recomputeSelection() {
    const res = this.selRoute();
    if (!res || !this.perf || !this.perf.canLift) {
      this.strategies = []; this.windowData = [];
    } else {
      const { cfg, target } = this.state;
      this.strategies = this.sim.compareStrategies(res.site, target, cfg, this.captureKm(), res.t0H ?? this.t0H());
      this.windowData = this.sim.launchWindow(res.site, target, this.perf, { days: 20, stepDays: 2, members: 6, captureKm: this.captureKm() });
    }
    this.setState((s) => ({ rev: s.rev + 1 }));
  }

  selectResult(i) {
    this.setState({ selected: i, scrubH: 0, playing: false }, () => this.recomputeSelection());
  }

  // Switch the selected point to one of its alternate start-day routes.
  pickVariant(i, startDay) {
    const res = this.results && this.results[i];
    if (!res || !res.variants) return;
    const v = res.variants.find((x) => x.startDay === startDay);
    if (!v || v === res._v) return;
    Object.assign(res, {
      path: v.path, arrived: v.arrived, tArrH: v.tArrH, closestKm: v.closestKm,
      flownKm: v.flownKm, altUsedKm: v.altUsedKm, budgetLeftKm: v.budgetLeftKm,
      startDay: v.startDay, t0H: v.t0H, mc: v.mc, _v: v, _runs: null,
    });
    if (!res.mc && this.perf && this.perf.canLift) {
      res.mc = v.mc = this.sim.monteCarloDay(res.site, this.state.target, this.perf, v.t0H, 6, this.captureKm());
    }
    this.setState({ selected: i, scrubH: 0, playing: false }, () => this.recomputeSelection());
  }

  selT0H() {
    const r = this.selRoute();
    return r && r.t0H != null ? r.t0H : this.t0H();
  }

  // Draw strength for a route: the better it ranks (and if it arrives), the stronger.
  routeGrade(i) {
    const n = (this.results || []).length;
    const res = this.results && this.results[i];
    if (!res) return 0.2;
    const rank = n > 1 ? 1 - i / (n - 1) : 1;
    return res.arrived ? 0.45 + 0.55 * rank : 0.08 + 0.2 * rank;
  }
  scheduleRecompute() {
    clearTimeout(this._deb);
    this._deb = setTimeout(() => this.recompute(), 140);
  }
  updateCfg(patch) {
    this.setState((s) => ({ cfg: { ...s.cfg, ...patch } }));
    this.scheduleRecompute();
  }

  selRoute() { return this.results && this.results[this.state.selected] || null; }
  scrubMaxH() {
    const r = this.selRoute();
    return r ? r.path[r.path.length - 1].t : 1;
  }
  balloonAt(h) {
    const r = this.selRoute();
    if (!r) return null;
    const p = r.path;
    const i = Math.min(Math.floor(h), p.length - 1);
    const j = Math.min(i + 1, p.length - 1);
    const f = Math.min(1, Math.max(0, h - i));
    const dLon = this.sim.wrapLon(p[j].lon - p[i].lon);
    return {
      lat: p[i].lat + (p[j].lat - p[i].lat) * f,
      lon: this.sim.wrapLon(p[i].lon + dLon * f),
      alt: p[i].alt + (p[j].alt - p[i].alt) * f,
    };
  }

  // ---------- playback ----------
  togglePlay() {
    if (this.state.playing) { this.setState({ playing: false }); cancelAnimationFrame(this._raf); return; }
    this.setState({ playing: true });
    let last = performance.now();
    const step = (now) => {
      if (!this.state.playing) return;
      const dt = (now - last) / 1000; last = now;
      let h = this.state.scrubH + dt * 10; // 10 sim-hours per second
      const max = this.scrubMaxH();
      if (h >= max) { h = max; this.setState({ scrubH: h, playing: false }); return; }
      this.setState({ scrubH: h });
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  // ---------- drawing ----------
  mapColors() {
    return {
      outer: '#070a0f', bg: '#0c1218', landFill: '#151f2a', coast: 'rgba(125,155,180,0.45)',
      tileFilter: 'saturate(0.85) brightness(0.95)',
      grid: 'rgba(86,200,232,0.08)',
      dim: 'rgba(120,160,190,0.28)', route: 'rgba(111,213,138,0.65)', sel: '#56c8e8', selGlow: 'rgba(86,200,232,0.3)',
      site: '#5f7a90', target: '#e8b356', balloon: '#56c8e8',
      wind: 'rgba(140,180,205,0.24)', label: 'rgba(190,210,225,0.9)', city: 'rgba(150,172,190,0.8)', country: 'rgba(86,200,232,0.35)',
    };
  }
  drawAll() { this.drawMap(); this.drawProfile(); }

  drawGlobe() {
    const cv = this._map, wrap = this._mapWrap;
    if (!cv || !wrap || !this.sim) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (W < 10 || H < 10) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.mapColors();
    const v = this.view;
    v.lat = Math.max(-85, Math.min(85, v.lat)); v.lon = this.sim.wrapLon(v.lon);
    const R = Math.max(60, (Math.min(W, H) / 2 - 20) * v.zoom);
    const cx = W / 2, cy = H / 2;
    this._mapT = { mode: 'globe', W, H, R, cx, cy };
    x.fillStyle = C.outer; x.fillRect(0, 0, W, H);
    const halo = x.createRadialGradient(cx, cy, Math.min(R, Math.max(W, H)) * 0.92, cx, cy, Math.min(R, Math.max(W, H)) * 1.1);
    halo.addColorStop(0, 'rgba(86,200,232,0.16)'); halo.addColorStop(1, 'rgba(86,200,232,0)');
    x.fillStyle = halo;
    x.beginPath(); x.arc(cx, cy, Math.min(R, Math.max(W, H)) * 1.1, 0, 7); x.fill();
    const dark = true;
    this.prepOsm(R, W, H);
    const key = [v.lon.toFixed(2), v.lat.toFixed(2), Math.round(R), dark, !!this._texData, !!this._lowRes, W, H, this._osmKey].join('|');
    if (this._sphereKey !== key) { this.renderSphere(R, v.lon, v.lat, dark, W, H); this._sphereKey = key; }
    const oc = this._globeCanvas, sr = this._sphereRect;
    if (oc && sr) x.drawImage(oc, cx - sr.rectW / 2, cy - sr.rectH / 2, sr.rectW, sr.rectH);
    // orthographic projection
    const D2R = Math.PI / 180;
    const sin0 = Math.sin(v.lat * D2R), cos0 = Math.cos(v.lat * D2R);
    const PXg = (lon, lat) => {
      const p = lat * D2R, l = (lon - v.lon) * D2R, cp = Math.cos(p);
      const sx = cp * Math.sin(l);
      const sy = cos0 * Math.sin(p) - sin0 * cp * Math.cos(l);
      const sz = sin0 * Math.sin(p) + cos0 * cp * Math.cos(l);
      return [cx + R * sx, cy - R * sy, sz];
    };
    const stroke3 = (pts, color, width, dash) => {
      x.strokeStyle = color; x.lineWidth = width; x.setLineDash(dash || []);
      x.beginPath();
      let pen = false;
      for (const [lo, la] of pts) {
        const [px, py, z] = PXg(lo, la);
        if (z <= 0.01) { pen = false; continue; }
        if (!pen) { x.moveTo(px, py); pen = true; } else x.lineTo(px, py);
      }
      x.stroke(); x.setLineDash([]);
    };
    // graticule
    for (let lo = -180; lo < 180; lo += 30) {
      const pts = []; for (let la = -80; la <= 80; la += 4) pts.push([lo, la]);
      stroke3(pts, C.grid, 1);
    }
    for (let la = -60; la <= 60; la += 30) {
      const pts = []; for (let lo = -180; lo <= 180; lo += 4) pts.push([lo, la]);
      stroke3(pts, C.grid, 1);
    }
    // candidate-country outlines (always visible)
    for (const co of this.sim.COUNTRIES) {
      for (const ring of (co.rings || [co.poly])) {
        stroke3(ring.concat([ring[0]]), C.country, 1.2);
      }
    }
    // custom launch area
    const ca3 = this.state.areaMode === 'custom' ? this.state.customArea : null;
    if (ca3) {
      const th = ca3.radiusKm / 6371;
      const pt0 = ca3.lat * D2R, sl0 = Math.sin(pt0), cl0 = Math.cos(pt0);
      const ring = [];
      for (let a = 0; a <= 360; a += 10) {
        const br = a * D2R;
        const la2 = Math.asin(sl0 * Math.cos(th) + cl0 * Math.sin(th) * Math.cos(br));
        const lo2 = ca3.lon * D2R + Math.atan2(Math.sin(br) * Math.sin(th) * cl0, Math.cos(th) - sl0 * Math.sin(la2));
        ring.push([lo2 / D2R, la2 / D2R]);
      }
      stroke3(ring, C.sel, 1.2, [6, 4]);
    }
    // cities
    const cTier = v.zoom >= 3 ? 3 : v.zoom >= 1.6 ? 2 : 1;
    x.font = '9px "IBM Plex Mono", monospace';
    for (const c of this.sim.CITIES) {
      if (c.t > cTier) continue;
      const [px, py, z] = PXg(c.lon, c.lat);
      if (z <= 0.05) continue;
      x.globalAlpha = Math.min(1, 0.35 + z);
      x.fillStyle = C.city;
      x.beginPath(); x.arc(px, py, 1.6, 0, 7); x.fill();
      x.fillText(c.n.toUpperCase(), px + 5, py + 3);
      x.globalAlpha = 1;
    }
    // selected country outline + candidates
    const selRes = (this.results || [])[this.state.selected];
    if (selRes && selRes.country) {
      for (const ring of (selRes.country.rings || [selRes.country.poly])) {
        stroke3(ring.concat([ring[0]]), C.sel, 1.4, [5, 4]);
      }
      for (const c of selRes.candidates || []) {
        const [px, py, z] = PXg(c.lon, c.lat);
        if (z <= 0.01) continue;
        x.fillStyle = c.arrived ? 'rgba(111,213,138,0.85)' : 'rgba(130,160,185,0.55)';
        x.beginPath(); x.arc(px, py, 2, 0, 7); x.fill();
      }
    }
    // wind field
    if (this.state.showWinds) {
      const b0 = this.balloonAt(this.state.scrubH);
      const alt = b0 ? b0.alt : ((this.perf && this.perf.ceiling) || 12);
      const t = this.selT0H() + this.state.scrubH;
      const stepPx = 36;
      x.lineWidth = 1;
      for (let py = Math.max(0, cy - R); py < Math.min(H, cy + R); py += stepPx) {
        for (let px = Math.max(0, cx - R); px < Math.min(W, cx + R); px += stepPx) {
          const xs = (px - cx) / R, ys = (cy - py) / R;
          const r2 = xs * xs + ys * ys;
          if (r2 > 0.96) continue;
          const z = Math.sqrt(1 - r2);
          const lat = Math.asin(Math.max(-1, Math.min(1, ys * cos0 + z * sin0))) / D2R;
          const lon = this.sim.wrapLon(v.lon + Math.atan2(xs, z * cos0 - ys * sin0) / D2R);
          if (lat > 86 || lat < -86) continue;
          const w = this.sim.windAt(lat, lon, alt, t);
          const s = Math.hypot(w.u, w.v);
          const p0 = PXg(lon, lat), pe = PXg(lon + 0.8, lat), pn = PXg(lon, lat + 0.8);
          let ex = pe[0] - p0[0], ey = pe[1] - p0[1];
          let nx = pn[0] - p0[0], ny = pn[1] - p0[1];
          const en = Math.hypot(ex, ey) || 1, nn = Math.hypot(nx, ny) || 1;
          ex /= en; ey /= en; nx /= nn; ny /= nn;
          let dx = w.u * ex + w.v * nx, dy = w.u * ey + w.v * ny;
          const dn = Math.hypot(dx, dy) || 1;
          const k = Math.min(14, s * 0.28);
          dx = dx / dn * k; dy = dy / dn * k;
          x.strokeStyle = C.wind;
          x.globalAlpha = Math.min(1, 0.25 + s / 50);
          x.beginPath(); x.moveTo(px - dx / 2, py - dy / 2); x.lineTo(px + dx / 2, py + dy / 2); x.stroke();
          x.fillStyle = C.wind;
          x.beginPath(); x.arc(px + dx / 2, py + dy / 2, 1.1, 0, 7); x.fill();
        }
      }
      x.globalAlpha = 1;
    }
    // trajectories
    const path3 = (path, color, width, upTo) => {
      x.strokeStyle = color; x.lineWidth = width;
      x.beginPath();
      const n = upTo != null ? Math.min(path.length, Math.ceil(upTo) + 1) : path.length;
      let pen = false;
      for (let i = 0; i < n; i++) {
        const [px, py, z] = PXg(path[i].lon, path[i].lat);
        if (z <= 0.01) { pen = false; continue; }
        if (!pen) { x.moveTo(px, py); pen = true; } else x.lineTo(px, py);
      }
      x.stroke();
    };
    (this.results || []).forEach((res, i) => {
      if (i === this.state.selected) return;
      const g = this.routeGrade(i);
      x.globalAlpha = g;
      path3(res.path, res.arrived ? C.route : C.dim, 0.7 + 1.6 * g);
    });
    x.globalAlpha = 1;
    const sel = this.selRoute();
    if (sel) {
      if (sel.variants && sel.variants.length > 1) {
        x.setLineDash([3, 5]); x.globalAlpha = 0.4;
        for (const vv of sel.variants) { if (vv !== sel._v) path3(vv.path, C.sel, 0.8); }
        x.setLineDash([]); x.globalAlpha = 1;
      }
      path3(sel.path, C.selGlow, 4);
      path3(sel.path, C.dim, 1);
      path3(sel.path, C.sel, 1.6, this.state.scrubH);
    }
    // sites
    x.font = '9px "IBM Plex Mono", monospace';
    (this.results || []).forEach((res, i) => {
      const [px, py, z] = PXg(res.site.lon, res.site.lat);
      if (z <= 0.01) return;
      x.fillStyle = res.custom ? C.target : (i === this.state.selected ? C.sel : C.site);
      x.fillRect(px - 3, py - 3, 6, 6);
      x.fillStyle = C.label;
      const name = v.zoom >= 1.8 ? String(i + 1) + ' ' + res.site.name.toUpperCase() : String(i + 1);
      x.fillText(name, px + 6, py + 3);
    });
    // target + capture ring
    const tgt = this.state.target;
    const [tx, ty, tzv] = PXg(tgt.lon, tgt.lat);
    if (tzv > 0.01) {
      x.strokeStyle = C.target; x.lineWidth = 1.4;
      x.beginPath(); x.arc(tx, ty, 8, 0, 7); x.stroke();
      x.beginPath();
      x.moveTo(tx - 13, ty); x.lineTo(tx - 4, ty); x.moveTo(tx + 4, ty); x.lineTo(tx + 13, ty);
      x.moveTo(tx, ty - 13); x.lineTo(tx, ty - 4); x.moveTo(tx, ty + 4); x.lineTo(tx, ty + 13);
      x.stroke();
      const th = this.captureKm() / 6371;
      const ring = [];
      const pt = tgt.lat * D2R, sl = Math.sin(pt), cl = Math.cos(pt);
      for (let a = 0; a <= 360; a += 12) {
        const br = a * D2R;
        const la2 = Math.asin(sl * Math.cos(th) + cl * Math.sin(th) * Math.cos(br));
        const lo2 = tgt.lon * D2R + Math.atan2(Math.sin(br) * Math.sin(th) * cl, Math.cos(th) - sl * Math.sin(la2));
        ring.push([lo2 / D2R, la2 / D2R]);
      }
      x.globalAlpha = 0.3;
      stroke3(ring, C.target, 1.4);
      x.globalAlpha = 1;
    }
    // balloon
    const b = this.balloonAt(this.state.scrubH);
    if (b) {
      const [bx, by, bz] = PXg(b.lon, b.lat);
      if (bz > 0.01) {
        x.fillStyle = C.balloon;
        x.beginPath(); x.arc(bx, by, 4, 0, 7); x.fill();
        x.strokeStyle = C.balloon; x.globalAlpha = 0.45;
        x.beginPath(); x.arc(bx, by, 8, 0, 7); x.stroke();
        x.globalAlpha = 1;
      }
    }
  }

  drawMap() {
    if (this.state.globe) return this.drawGlobe();
    const cv = this._map, wrap = this._mapWrap;
    if (!cv || !wrap || !this.sim) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (W < 10 || H < 10) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.mapColors();
    const v = this.view || (this.view = { lon: 0, lat: 25, zoom: 1 });
    const base = Math.min(W / 360, H / 180);
    const ppd = base * v.zoom;
    const worldW = 360 * ppd;
    const mHalfView = (H / 2) * (2 * Math.PI / worldW);
    const mMax = Math.PI - mHalfView;
    let mC = this.mercY(v.lat);
    mC = mMax <= 0 ? 0 : Math.max(-mMax, Math.min(mMax, mC));
    v.lat = this.invMerc(mC);
    v.lon = this.sim.wrapLon(v.lon);
    const PX = (lon, lat) => [W / 2 + (lon - v.lon) * ppd, H / 2 + (mC - this.mercY(lat)) * worldW / (2 * Math.PI)];
    const invLat = (py) => this.invMerc(mC - (py - H / 2) * 2 * Math.PI / worldW);
    this._mapT = { W, H, ppd, worldW, mC };
    x.fillStyle = C.outer; x.fillRect(0, 0, W, H);
    const shifts = [-360, 0, 360].filter((sh) => PX(180 + sh, 0)[0] > 0 && PX(-180 + sh, 0)[0] < W);
    const topY = Math.max(0, PX(0, 85.05)[1]), botY = Math.min(H, PX(0, -85.05)[1]);
    // ocean + fallback coastlines (shown until tiles arrive)
    for (const sh of shifts) {
      const l = Math.max(0, PX(-180 + sh, 0)[0]), rr = Math.min(W, PX(180 + sh, 0)[0]);
      x.fillStyle = C.bg; x.fillRect(l, topY, rr - l, botY - topY);
    }
    for (const sh of shifts) {
      x.fillStyle = C.landFill; x.strokeStyle = C.coast; x.lineWidth = 1;
      for (const poly of this.sim.CONTINENTS) {
        x.beginPath();
        poly.forEach(([lo, la], i) => {
          const [px, py] = PX(lo + sh, la);
          if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
        });
        x.closePath(); x.fill(); x.stroke();
      }
    }
    // OSM raster underlay
    const tz = Math.max(1, Math.min(17, Math.round(Math.log2(worldW / 256))));
    const tn = 1 << tz;
    const tilePx = worldW / tn;
    const wx0 = PX(-180, 0)[0];
    const wy0 = H / 2 + (mC - Math.PI) * worldW / (2 * Math.PI);
    x.save();
    x.filter = C.tileFilter;
    const ix0 = Math.floor((0 - wx0) / tilePx), ix1 = Math.ceil((W - wx0) / tilePx);
    const iy0 = Math.max(0, Math.floor((0 - wy0) / tilePx)), iy1 = Math.min(tn, Math.ceil((H - wy0) / tilePx));
    for (let ty = iy0; ty < iy1; ty++) {
      for (let tx = ix0; tx < ix1; tx++) {
        const img = this.tileFor(tz, tx, ty);
        if (img) x.drawImage(img, wx0 + tx * tilePx, wy0 + ty * tilePx, tilePx + 0.5, tilePx + 0.5);
      }
    }
    x.restore();
    // graticule (finer with zoom)
    const g = v.zoom >= 5 ? 5 : v.zoom >= 2.2 ? 10 : 30;
    x.strokeStyle = C.grid; x.lineWidth = 1;
    for (const sh of shifts) for (let lo = -180; lo <= 180; lo += g) {
      const [px] = PX(lo + sh, 0);
      if (px < 0 || px > W) continue;
      x.beginPath(); x.moveTo(px, topY); x.lineTo(px, botY); x.stroke();
    }
    for (let la = -80; la <= 80; la += g) {
      const [, py] = PX(0, la);
      if (py < topY || py > botY) continue;
      x.beginPath(); x.moveTo(0, py); x.lineTo(W, py); x.stroke();
    }
    // candidate-country outlines (always visible)
    x.strokeStyle = C.country; x.lineWidth = 1.2;
    for (const sh of shifts) {
      for (const co of this.sim.COUNTRIES) {
        for (const ring of (co.rings || [co.poly])) {
          x.beginPath();
          ring.forEach(([lo, la], i) => {
            const [px, py] = PX(lo + sh, la);
            if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
          });
          x.closePath(); x.stroke();
        }
      }
    }
    // selected country: outline + tested candidate points
    const selRes = (this.results || [])[this.state.selected];
    if (selRes && selRes.country) {
      const p0 = selRes.country.poly[0][0];
      const csh = v.lon + this.sim.wrapLon(p0 - v.lon) - p0;
      x.strokeStyle = C.sel; x.lineWidth = 1.4; x.setLineDash([5, 4]);
      for (const ring of (selRes.country.rings || [selRes.country.poly])) {
        x.beginPath();
        ring.forEach(([lo, la], i) => {
          const [px, py] = PX(lo + csh, la);
          if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
        });
        x.closePath(); x.stroke();
      }
      x.setLineDash([]);
      for (const c of selRes.candidates || []) {
        const [px, py] = PX(c.lon + csh, c.lat);
        x.fillStyle = c.arrived ? 'rgba(111,213,138,0.85)' : 'rgba(130,160,185,0.55)';
        x.beginPath(); x.arc(px, py, 2, 0, 7); x.fill();
      }
    }
    // wind field at balloon altitude / mission time
    if (this.state.showWinds) {
      const b0 = this.balloonAt(this.state.scrubH);
      const alt = b0 ? b0.alt : ((this.perf && this.perf.ceiling) || 12);
      const t = this.selT0H() + this.state.scrubH;
      x.strokeStyle = C.wind; x.lineWidth = 1;
      const stepPx = 34;
      for (let py = Math.max(0, topY) + stepPx / 2; py < botY; py += stepPx) {
        for (let px = stepPx / 2; px < W; px += stepPx) {
          const lon = this.sim.wrapLon(v.lon + (px - W / 2) / ppd);
          const lat = invLat(py);
          if (lat > 84 || lat < -84) continue;
          const w = this.sim.windAt(lat, lon, alt, t);
          const s = Math.hypot(w.u, w.v);
          const k = Math.min(14, s * 0.28);
          const dx = w.u / (s || 1) * k, dy = -w.v / (s || 1) * k;
          x.globalAlpha = Math.min(1, 0.25 + s / 50);
          x.beginPath(); x.moveTo(px - dx / 2, py - dy / 2); x.lineTo(px + dx / 2, py + dy / 2); x.stroke();
          x.beginPath(); x.arc(px + dx / 2, py + dy / 2, 1.1, 0, 7); x.fillStyle = C.wind; x.fill();
        }
      }
      x.globalAlpha = 1;
    }
    // trajectories (drawn per visible world copy)
    const drawPath = (path, color, width, upTo, sh) => {
      x.strokeStyle = color; x.lineWidth = width;
      x.beginPath();
      let prev = null;
      const n = upTo != null ? Math.min(path.length, Math.ceil(upTo) + 1) : path.length;
      for (let i = 0; i < n; i++) {
        const p = path[i];
        const [px, py] = PX(p.lon + sh, p.lat);
        if (prev && Math.abs(p.lon - prev.lon) > 180) { x.moveTo(px, py); }
        else if (i === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
        prev = p;
      }
      x.stroke();
    };
    for (const sh of shifts) {
      (this.results || []).forEach((res, i) => {
        if (i === this.state.selected) return;
        const g = this.routeGrade(i);
        x.globalAlpha = g;
        drawPath(res.path, res.arrived ? C.route : C.dim, 0.7 + 1.6 * g, null, sh);
      });
      x.globalAlpha = 1;
      const sel = this.selRoute();
      if (sel) {
        if (sel.variants && sel.variants.length > 1) {
          x.setLineDash([3, 5]); x.globalAlpha = 0.4;
          for (const vv of sel.variants) { if (vv !== sel._v) drawPath(vv.path, C.sel, 0.8, null, sh); }
          x.setLineDash([]); x.globalAlpha = 1;
        }
        drawPath(sel.path, C.selGlow, 4, null, sh);
        drawPath(sel.path, C.dim, 1, null, sh);
        drawPath(sel.path, C.sel, 1.6, this.state.scrubH, sh);
      }
    }
    // nearest wrapped copy for point features
    const NP = (lon, lat) => PX(v.lon + this.sim.wrapLon(lon - v.lon), lat);
    // custom launch area
    const ca2 = this.state.areaMode === 'custom' ? this.state.customArea : null;
    if (ca2) {
      const [ax, ay] = NP(ca2.lon, ca2.lat);
      const rPx = ca2.radiusKm / 111 * ppd / Math.max(0.15, Math.cos(ca2.lat * Math.PI / 180));
      x.strokeStyle = C.sel; x.setLineDash([6, 4]); x.lineWidth = 1.2;
      x.beginPath(); x.arc(ax, ay, rPx, 0, 7); x.stroke();
      x.setLineDash([]);
    }
    // cities
    const cTier = v.zoom >= 4 ? 3 : v.zoom >= 2 ? 2 : 1;
    x.font = '9px "IBM Plex Mono", monospace';
    for (const c of this.sim.CITIES) {
      if (c.t > cTier) continue;
      const [px, py] = NP(c.lon, c.lat);
      if (px < -60 || px > W + 60 || py < topY || py > botY) continue;
      x.fillStyle = C.city;
      x.beginPath(); x.arc(px, py, 1.6, 0, 7); x.fill();
      x.fillText(c.n.toUpperCase(), px + 5, py + 3);
    }
    // sites
    x.font = '9px "IBM Plex Mono", monospace';
    (this.results || []).forEach((res, i) => {
      const [px, py] = NP(res.site.lon, res.site.lat);
      x.fillStyle = res.custom ? C.target : (i === this.state.selected ? C.sel : C.site);
      x.fillRect(px - 3, py - 3, 6, 6);
      x.fillStyle = C.label;
      const name = v.zoom >= 2.4 ? String(i + 1) + ' ' + res.site.name.toUpperCase() : String(i + 1);
      x.fillText(name, px + 6, py + 3);
    });
    // target crosshair
    const [tx, ty] = NP(this.state.target.lon, this.state.target.lat);
    x.strokeStyle = C.target; x.lineWidth = 1.4;
    x.beginPath(); x.arc(tx, ty, 8, 0, 7); x.stroke();
    x.beginPath();
    x.moveTo(tx - 13, ty); x.lineTo(tx - 4, ty); x.moveTo(tx + 4, ty); x.lineTo(tx + 13, ty);
    x.moveTo(tx, ty - 13); x.lineTo(tx, ty - 4); x.moveTo(tx, ty + 4); x.lineTo(tx, ty + 13);
    x.stroke();
    // capture radius (approx, Mercator-scaled)
    const capPx = this.captureKm() / 111 * ppd / Math.max(0.15, Math.cos(this.state.target.lat * Math.PI / 180));
    x.strokeStyle = C.target; x.globalAlpha = 0.3;
    x.beginPath(); x.arc(tx, ty, capPx, 0, 7); x.stroke();
    x.globalAlpha = 1;
    // balloon
    const b = this.balloonAt(this.state.scrubH);
    if (b) {
      const [bx, by] = NP(b.lon, b.lat);
      x.fillStyle = C.balloon;
      x.beginPath(); x.arc(bx, by, 4, 0, 7); x.fill();
      x.strokeStyle = C.balloon; x.globalAlpha = 0.45;
      x.beginPath(); x.arc(bx, by, 8, 0, 7); x.stroke();
      x.globalAlpha = 1;
    }
  }

  drawProfile() {
    const cv = this._prof;
    if (!cv || !this.sim) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = 84;
    if (W < 10) return;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#0c1117'; x.fillRect(0, 0, W, H);
    const sel = this.selRoute();
    const maxAlt = Math.max(20, Math.ceil(((this.perf && this.perf.ceiling ? this.perf.ceiling : 16) + 4) / 5) * 5);
    const PY = (a) => H - 8 - (a / maxAlt) * (H - 18);
    // grid lines every 10 km
    x.font = '9px "IBM Plex Mono", monospace';
    for (let a = 0; a <= 30; a += 10) {
      x.strokeStyle = 'rgba(86,200,232,0.07)';
      x.beginPath(); x.moveTo(34, PY(a)); x.lineTo(W - 8, PY(a)); x.stroke();
      x.fillStyle = '#41576b'; x.fillText(a + ' km', 4, PY(a) + 3);
    }
    if (!sel || !this.perf) return;
    const maxT = sel.path[sel.path.length - 1].t || 1;
    const PXt = (t) => 34 + (t / maxT) * (W - 42);
    // control band
    x.fillStyle = 'rgba(86,200,232,0.06)';
    const bLo = PY(this.perf.bandHi), bHi = PY(this.perf.bandLo);
    x.fillRect(34, bLo, W - 42, Math.max(1, bHi - bLo));
    // altitude trace
    x.strokeStyle = '#56c8e8'; x.lineWidth = 1.4;
    x.beginPath();
    sel.path.forEach((p, i) => {
      const px = PXt(p.t), py = PY(p.alt);
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    });
    x.stroke();
    // day ticks
    x.fillStyle = '#41576b';
    for (let d = 0; d * 24 <= maxT; d += Math.max(1, Math.round(maxT / 24 / 10))) {
      const px = PXt(d * 24);
      x.fillRect(px, H - 6, 1, 4);
      x.fillText('D' + d, px + 2, H - 1);
    }
    // scrub cursor
    const cx = PXt(Math.min(this.state.scrubH, maxT));
    x.strokeStyle = '#e8b356'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(cx, 4); x.lineTo(cx, H - 8); x.stroke();
  }

  // ---------- formatting ----------
  fmtLL(lat, lon) {
    const la = Math.abs(lat).toFixed(1) + (lat >= 0 ? 'N' : 'S');
    const lo = Math.abs(lon).toFixed(1) + (lon >= 0 ? 'E' : 'W');
    return la + ' ' + lo;
  }
  fmtKm(km) { return km >= 1000 ? (km / 1000).toFixed(1) + ' Mm' : Math.round(km) + ' km'; }
  fmtDur(h) {
    const d = Math.floor(h / 24), hh = Math.floor(h % 24);
    return 'T+' + String(d).padStart(2, '0') + 'd ' + String(hh).padStart(2, '0') + 'h';
  }
  resText(r) {
    if (!r) return { txt: 'N/A', color: '#41576b' };
    return r.arrived
      ? { txt: 'ARRIVED ' + this.fmtDur(r.tArrH), color: '#6fd58a' }
      : { txt: 'MISS · ' + this.fmtKm(r.closestKm), color: '#e2705f' };
  }

  // ---------- map interaction (bound via callback refs) ----------
  bindMapEvents(el) {
    this._map = el;
    if (!el || el._bound) return;
    el._bound = true;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = this._mapT; if (!t || !this.view) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const v = this.view;
      if (t.mode === 'globe') {
        this.markInteracting();
        v.zoom = Math.max(0.85, Math.min(30, v.zoom * Math.exp(-e.deltaY * 0.0016)));
        this.drawMap();
        return;
      }
      const geoLon = v.lon + (px - t.W / 2) / t.ppd;
      const mCursor = t.mC - (py - t.H / 2) * 2 * Math.PI / t.worldW;
      v.zoom = Math.max(1, Math.min(600, v.zoom * Math.exp(-e.deltaY * 0.0016)));
      const ppd2 = Math.min(t.W / 360, t.H / 180) * v.zoom;
      const worldW2 = 360 * ppd2;
      v.lon = geoLon - (px - t.W / 2) / ppd2;
      v.lat = this.invMerc(mCursor + (py - t.H / 2) * 2 * Math.PI / worldW2);
      this.drawMap();
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      this._drag = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (!this._drag.moved && Math.hypot(dx, dy) < 4) return;
      this._drag.moved = true;
      const t = this._mapT; if (!t || !this.view) return;
      if (t.mode === 'globe') {
        this.markInteracting();
        const k = 60 / t.R;
        this.view.lon = this.sim.wrapLon(this.view.lon - dx * k);
        this.view.lat = Math.max(-85, Math.min(85, this.view.lat + dy * k));
      } else {
        this.view.lon -= dx / t.ppd;
        this.view.lat = this.invMerc(t.mC + dy * 2 * Math.PI / t.worldW);
      }
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      this.drawMap();
    });
    el.addEventListener('pointerup', () => {
      if (this._drag && this._drag.moved) this._suppressClick = true;
      this._drag = null;
    });
  }

  onMapClick = (e) => {
    if (this._suppressClick) { this._suppressClick = false; return; }
    const s = this.state;
    const t = this._mapT; if (!t || !this.view) return;
    const rect = this._map.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let lon, lat;
    if (t.mode === 'globe') {
      const xs = (px - t.cx) / t.R, ys = (t.cy - py) / t.R;
      const r2 = xs * xs + ys * ys;
      if (r2 > 1) return;
      const D2R = Math.PI / 180;
      const z = Math.sqrt(1 - r2);
      const sin0 = Math.sin(this.view.lat * D2R), cos0 = Math.cos(this.view.lat * D2R);
      lat = Math.asin(Math.max(-1, Math.min(1, ys * cos0 + z * sin0))) / D2R;
      lon = this.sim.wrapLon(this.view.lon + Math.atan2(xs, z * cos0 - ys * sin0) / D2R);
    } else {
      lon = this.sim.wrapLon(this.view.lon + (px - t.W / 2) / t.ppd);
      lat = this.invMerc(t.mC - (py - t.H / 2) * 2 * Math.PI / t.worldW);
    }
    if (lat < -84 || lat > 84) return;
    const pt = { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10 };
    if (s.clickMode === 'launch') {
      const radiusKm = (s.customArea && s.customArea.radiusKm) || 400;
      this.setState({ areaMode: 'custom', customArea: { lat: pt.lat, lon: pt.lon, radiusKm }, selected: 0, scrubH: 0, playing: false });
    } else {
      this.setState({ target: pt, scrubH: 0, playing: false });
    }
    this.scheduleRecompute();
  };

  // ---------- render ----------
  render() {
    const s = this.state;
    const perf = this.perf;
    const sel = this.selRoute();
    const b = this.balloonAt(s.scrubH);
    const T0 = (s.windSource === 'live' && this._liveStart) ? this._liveStart : Date.UTC(2026, 6, 4);

    const dateOf = (day) => new Date(T0 + day * 86400e3).toISOString().slice(5, 10);
    let bestW = null;
    for (const w of this.windowData || []) {
      if (!bestW || w.p > bestW.p || (w.p === bestW.p && w.medT != null && bestW.medT != null && w.medT < bestW.medT)) bestW = w;
    }

    const readouts = perf ? [
      { k: 'FLOAT CEILING', v: perf.ceiling ? perf.ceiling.toFixed(1) + ' km' : '—', color: '#e8b356' },
      { k: 'CONTROL BAND', v: perf.canLift ? perf.bandLo.toFixed(0) + '–' + perf.bandHi.toFixed(0) + ' km' : '—', color: '#c6d2dd' },
      { k: 'ENVELOPE', v: Math.round(perf.envelopeKg) + ' kg', color: '#c6d2dd' },
      { k: 'GAS MASS', v: Math.round(perf.gasMassKg) + ' kg', color: '#c6d2dd' },
      { k: 'LAUNCH FILL', v: Math.round(perf.launchGasM3).toLocaleString() + ' m³', color: '#c6d2dd' },
      { k: 'GROSS MASS', v: Math.round(perf.grossKg) + ' kg', color: '#c6d2dd' },
      { k: 'FREE LIFT', v: Math.round(perf.freeLiftKg) + ' kg', color: '#c6d2dd' },
      { k: 'ENDURANCE', v: perf.capDays.toFixed(0) + ' d max', color: '#e8b356' },
    ] : [];

    let wind = { u: 0, v: 0 };
    if (this.sim && b) wind = this.sim.windAt(b.lat, b.lon, b.alt, this.selT0H() + s.scrubH);
    const wspd = Math.hypot(wind.u, wind.v);
    const wdir = (Math.atan2(wind.u, wind.v) * 180 / Math.PI + 360) % 360;
    const utc = new Date(T0 + (this.selT0H() + s.scrubH) * 3600 * 1000);
    const arrived = (this.results || []).filter((r) => r.arrived).length;
    const ps = this.plannerStatus;
    const selectedName = sel ? sel.site.name.toUpperCase() : '—';
    const srcLabel = s.fetching ? 'FETCHING GFS…' : s.liveError ? 'SRC: SYNTH (LIVE FAILED)' : s.windSource === 'live' ? 'SRC: OPEN-METEO' : 'SRC: SYNTH-CLIM';

    const sectionTitle = { fontSize: 10, letterSpacing: 2, color: '#647a8e', marginBottom: 8 };
    const overlayBtn = (border, color) => ({
      padding: '5px 10px', fontSize: 10, letterSpacing: 1, cursor: 'pointer',
      border: '1px solid ' + border, color, background: 'rgba(14,19,25,0.85)',
    });

    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0a0e13', color: '#c6d2dd', fontFamily: MONO, fontSize: 12, overflow: 'hidden' }}>

        {/* ============ HEADER ============ */}
        <div style={{ height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 20, padding: '0 16px', background: '#0e1319', borderBottom: PANEL_BORDER }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#56c8e8', animation: 'blinkdot 2.4s infinite' }} />
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: 2.5, color: '#e8eef4' }}>STRATOS ROUTE PLANNER</div>
          </div>
          <div style={{ color: '#647a8e', letterSpacing: 1 }}>LONG-DURATION BALLOON MISSION DESIGN</div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 18, color: '#647a8e' }}>
            <div>LAUNCH <span data-testid="launch-date" style={{ color: '#c6d2dd' }}>{new Date(T0 + this.selT0H() * 3600e3).toISOString().slice(0, 10)} 00Z</span></div>
            <div>TGT <span style={{ color: '#e8b356' }}>{this.fmtLL(s.target.lat, s.target.lon)}</span></div>
            <div>WIND MODEL <span style={{ color: '#6fd58a' }}>{s.windSource === 'live' ? 'OPEN-METEO GFS' : 'SYNTH-CLIM v2'}</span></div>
          </div>
        </div>

        {/* ============ MAIN ============ */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative', flexDirection: 'row' }}>

          {/* ---- CONTROL PANEL ---- */}
          <div style={{ width: 340, flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', background: '#0e1319', borderRight: PANEL_BORDER, display: 'flex', flexDirection: 'column' }}>

            {/* Target */}
            <div style={{ padding: '12px 14px', borderBottom: PANEL_BORDER }}>
              <div style={sectionTitle}>TARGET</div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
                <div style={{ fontSize: 17, color: '#e8b356', fontWeight: 600 }}>{this.fmtLL(s.target.lat, s.target.lon)}</div>
                <div style={{ color: '#647a8e', fontSize: 11 }}>capture {this.captureKm()} km</div>
              </div>
              <div style={{ color: '#41576b', fontSize: 10, marginTop: 5 }}>CLICK MAP TO SET TARGET OR LAUNCH PT (MODE TOP-LEFT) · ROUTES RECOMPUTE LIVE</div>
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ color: '#647a8e', fontSize: 10 }}>CAPTURE RADIUS</span>
                  <span style={{ color: '#e8b356', fontSize: 11 }}>{this.captureKm()} km</span>
                </div>
                <input type="range" min={50} max={1000} step={25} value={this.captureKm()}
                  onChange={(e) => { this.setState({ captureKmUI: Number(e.target.value) }); this.scheduleRecompute(); }}
                  style={{ width: '100%', height: 16 }} />
              </div>
            </div>

            {/* Ranked launch sites */}
            <div style={{ padding: '12px 14px', borderBottom: PANEL_BORDER }}>
              <div style={sectionTitle}>LAUNCH AREA</div>
              <select
                value={s.areaMode === 'custom' ? 'custom' : s.areaCountryId}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === 'custom') this.setState({ areaMode: 'custom', clickMode: 'launch', selected: 0, scrubH: 0 });
                  else this.setState({ areaMode: 'country', areaCountryId: val, selected: 0, scrubH: 0 });
                  this.scheduleRecompute();
                }}
                style={{ width: '100%', background: '#10161d', color: '#c6d2dd', border: PANEL_BORDER, fontFamily: MONO, fontSize: 11, padding: 6, marginBottom: 8 }}>
                <option value="custom">◆ CUSTOM AREA (CLICK MAP IN LAUNCH MODE)</option>
                {this.sim.COUNTRIES.map((c) => <option key={c.id} value={c.id}>{c.name.toUpperCase()}</option>)}
              </select>
              {s.areaMode === 'custom' && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ color: '#41576b', fontSize: 10, marginBottom: 6 }}>
                    {s.customArea
                      ? 'AREA CENTER ' + this.fmtLL(s.customArea.lat, s.customArea.lon) + ' · CLICK MAP TO MOVE'
                      : 'CLICK THE MAP (LAUNCH MODE ACTIVE) TO PLACE THE AREA'}
                  </div>
                  {s.customArea && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: '#647a8e', fontSize: 10 }}>AREA RADIUS</span>
                        <span style={{ color: '#c6d2dd', fontSize: 11 }}>{s.customArea.radiusKm} km</span>
                      </div>
                      <input type="range" min={100} max={2000} step={50} value={s.customArea.radiusKm}
                        onChange={(e) => {
                          this.setState({ customArea: { ...s.customArea, radiusKm: Number(e.target.value) } });
                          this.scheduleRecompute();
                        }}
                        style={{ width: '100%', height: 16 }} />
                    </>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: '#647a8e' }}>LAUNCH POINTS — RANKED</div>
                <div style={{ fontSize: 10, color: ps && ps.phase !== 'done' ? '#56c8e8' : '#41576b' }} data-testid="planner-status">
                  {ps && ps.phase === 'sim' ? 'SIMULATING ' + ps.done + '/' + ps.total
                    : ps && ps.phase === 'mc' ? 'REFINING P · ' + ps.mcDone + '/' + ps.mcTotal
                    : arrived + '/' + (this.results?.length || 0) + ' REACH TARGET'}
                </div>
              </div>
              <div style={{ color: '#41576b', fontSize: 10, marginBottom: 8 }}>
                EACH POINT SCANNED OVER THE NEXT 5 START DAYS · BEST SHOWN, ALTERNATES SELECTABLE
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="site-list">
                {(this.results || []).map((res, i) => {
                  let status, statusColor, med;
                  if (res.mc) {
                    const p = res.mc.p;
                    status = 'P ' + Math.round(p * 100) + '%';
                    statusColor = p >= 0.66 ? '#6fd58a' : p > 0 ? '#e8b356' : '#e2705f';
                    med = res.mc.medT != null ? 'median ' + this.fmtDur(res.mc.medT) : 'median miss ' + this.fmtKm(res.mc.medClosest);
                  } else {
                    const st = this.resText(res);
                    status = st.txt; statusColor = st.color;
                    med = 'nominal run';
                  }
                  const variants = (res.variants && res.variants.length > 1)
                    ? [...res.variants].sort((a, b) => a.startDay - b.startDay) : null;
                  return (
                    <div key={i}
                      onClick={() => this.selectResult(i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', cursor: 'pointer',
                        borderLeft: '2px solid ' + (res.custom ? '#e8b356' : (i === s.selected ? '#56c8e8' : '#1b2530')),
                        background: i === s.selected ? '#131c26' : 'transparent',
                      }}>
                      <div style={{ width: 18, color: '#41576b', fontSize: 11 }}>{String(i + 1).padStart(2, '0')}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: res.custom ? '#e8b356' : (i === s.selected ? '#e8eef4' : '#9db0c0'), fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>
                          {(res.custom ? '◆ ' : '') + res.site.name.toUpperCase()}
                          <span style={{ color: '#56c8e8', fontWeight: 400, marginLeft: 6 }}>{'↑ ' + dateOf(s.launchDay + (res.startDay || 0))}</span>
                        </div>
                        <div style={{ color: '#647a8e', fontSize: 10, marginTop: 1 }}>
                          {'launch ' + this.fmtLL(res.site.lat, res.site.lon) + ' · ' + med + ' · direct ' + this.fmtKm(res.directKm)}
                        </div>
                        {i === s.selected && variants && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }} data-testid="variant-chips">
                            {variants.map((vv) => {
                              const active = vv.startDay === res.startDay;
                              return (
                                <div key={vv.startDay}
                                  onClick={(e) => { e.stopPropagation(); this.pickVariant(i, vv.startDay); }}
                                  style={{
                                    padding: '2px 6px', fontSize: 9, cursor: 'pointer', whiteSpace: 'nowrap',
                                    border: '1px solid ' + (active ? '#56c8e8' : '#2a3a4a'),
                                    color: active ? '#56c8e8' : vv.arrived ? '#6fd58a' : '#e2705f',
                                    background: active ? '#10202c' : 'transparent',
                                  }}>
                                  {dateOf(s.launchDay + vv.startDay) + ' ' + (vv.arrived ? this.fmtDur(vv.tArrH) : 'miss ' + this.fmtKm(vv.closestKm))}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div style={{ color: statusColor, fontSize: 10, fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}>{status}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Launch window (Monte Carlo over start dates) */}
            <div style={{ padding: '12px 14px', borderBottom: PANEL_BORDER }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: '#647a8e' }}>LAUNCH WINDOW — {selectedName}</div>
                <div style={{ fontSize: 10, color: '#6fd58a' }}>
                  {bestW ? 'BEST ' + dateOf(bestW.day) + ' · P ' + Math.round(bestW.p * 100) + '%' : '—'}
                </div>
              </div>
              <div style={{ color: '#41576b', fontSize: 10, marginBottom: 8 }}>6-MEMBER ENSEMBLE × 11 START DATES AT OPTIMAL POINT · CLICK BAR TO SET LAUNCH</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70 }}>
                {(this.windowData || []).map((w) => {
                  const isSel = w.day === s.launchDay;
                  const isBest = bestW && w.day === bestW.day;
                  return (
                    <div key={w.day}
                      onClick={() => { this.setState({ launchDay: w.day, scrubH: 0, playing: false }); this.scheduleRecompute(); }}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 3, cursor: 'pointer', height: '100%' }}>
                      <div style={{ fontSize: 9, color: w.p >= 0.66 ? '#6fd58a' : w.p > 0 ? '#e8b356' : '#41576b' }}>{Math.round(w.p * 100)}</div>
                      <div style={{
                        width: '100%', height: Math.max(3, Math.round(w.p * 40)),
                        background: isSel ? '#56c8e8' : isBest ? 'rgba(111,213,138,0.75)' : '#22303e',
                        border: '1px solid ' + (isSel ? '#56c8e8' : isBest ? '#3f6b4d' : '#2a3a4a'),
                      }} />
                      <div style={{ fontSize: 9, color: isSel ? '#56c8e8' : '#41576b', whiteSpace: 'nowrap' }}>{dateOf(w.day)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Balloon / payload config */}
            <div style={{ padding: '12px 14px', borderBottom: PANEL_BORDER }}>
              <div style={sectionTitle}>BALLOON &amp; PAYLOAD</div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {[['zeropressure', 'ZERO-PRESS'], ['superpressure', 'SUPERPRESS'], ['adjustable', 'ADJUSTABLE'], ['roziere', 'ROZIÈRE']].map(([k, label]) => (
                  <div key={k} onClick={() => this.updateCfg({ type: k })} style={{
                    flex: '1 0 45%', textAlign: 'center', padding: '6px 2px', fontSize: 10, letterSpacing: 0.5, cursor: 'pointer',
                    border: '1px solid ' + (s.cfg.type === k ? '#2b4a58' : '#1b2530'),
                    color: s.cfg.type === k ? '#56c8e8' : '#647a8e',
                    background: s.cfg.type === k ? '#101c24' : 'transparent',
                  }}>{label}</div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
                {[['helium', 'HELIUM'], ['hydrogen', 'HYDROGEN']].map(([k, label]) => (
                  <div key={k} onClick={() => this.updateCfg({ gas: k })} style={{
                    flex: 1, textAlign: 'center', padding: '5px 2px', fontSize: 10, cursor: 'pointer',
                    border: '1px solid ' + (s.cfg.gas === k ? '#2b4a58' : '#1b2530'),
                    color: s.cfg.gas === k ? '#56c8e8' : '#647a8e',
                    background: s.cfg.gas === k ? '#101c24' : 'transparent',
                  }}>{label}</div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ color: '#647a8e', fontSize: 10 }}>ENVELOPE VOLUME</span>
                    <span style={{ color: '#c6d2dd', fontSize: 11 }}>{(s.cfg.volume / 1000).toFixed(0)} ×10³ m³</span>
                  </div>
                  <input type="range" min={10} max={800} step={5} value={Math.round(s.cfg.volume / 1000)}
                    onChange={(e) => this.updateCfg({ volume: Number(e.target.value) * 1000 })}
                    style={{ width: '100%', height: 16 }} />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ color: '#647a8e', fontSize: 10 }}>PAYLOAD MASS</span>
                    <span style={{ color: '#c6d2dd', fontSize: 11 }}>{s.cfg.payloadKg} kg</span>
                  </div>
                  <input type="range" min={5} max={2500} step={5} value={s.cfg.payloadKg}
                    onChange={(e) => this.updateCfg({ payloadKg: Number(e.target.value) })}
                    style={{ width: '100%', height: 16 }} />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ color: '#647a8e', fontSize: 10 }}>{s.cfg.type === 'roziere' ? 'BURNER FUEL' : 'BALLAST'}</span>
                    <span style={{ color: '#c6d2dd', fontSize: 11 }}>{s.cfg.ballastKg} kg</span>
                  </div>
                  <input type="range" min={0} max={800} step={5} value={s.cfg.ballastKg}
                    onChange={(e) => this.updateCfg({ ballastKg: Number(e.target.value) })}
                    style={{ width: '100%', height: 16 }} />
                </div>
              </div>

              {perf && !perf.canLift && (
                <div style={{ marginTop: 10, padding: '7px 9px', border: '1px solid #5a3028', color: '#e2705f', fontSize: 10, letterSpacing: 0.5 }}>
                  NEGATIVE LIFT — REDUCE MASS OR INCREASE VOLUME
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 14px', marginTop: 12 }}>
                {readouts.map((r) => (
                  <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dotted #1b2530', paddingBottom: 3 }}>
                    <span style={{ color: '#647a8e', fontSize: 10 }}>{r.k}</span>
                    <span style={{ color: r.color, fontSize: 11 }}>{r.v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Strategy comparison */}
            <div style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 10, letterSpacing: 2, color: '#647a8e', marginBottom: 2 }}>ALTITUDE STRATEGY — {selectedName}</div>
              <div style={{ color: '#41576b', fontSize: 10, marginBottom: 8 }}>same envelope, three control philosophies</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {(this.strategies || []).map((row) => {
                  const rt = this.resText(row.r);
                  return (
                    <div key={row.key} style={{ padding: '7px 9px', border: PANEL_BORDER, background: '#10161d' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ color: '#c6d2dd', fontSize: 11, fontWeight: 600 }}>{row.label}</div>
                        <div style={{ color: rt.color, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{rt.txt}</div>
                      </div>
                      <div style={{ color: '#647a8e', fontSize: 10, marginTop: 2 }}>{row.detail + (row.r ? ' · flown ' + this.fmtKm(row.r.flownKm) : '')}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---- MAP ---- */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', background: '#0a0e13' }}
            ref={(el) => { this._mapWrap = el; if (el && !this._ro) { this._ro = new ResizeObserver(() => this.drawAll()); this._ro.observe(el); } }}>
            <canvas ref={(el) => this.bindMapEvents(el)} onClick={this.onMapClick}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', display: 'block' }} />
            <div style={{ position: 'absolute', top: 10, left: 10, right: 10, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', pointerEvents: 'none' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', pointerEvents: 'auto' }}>
                <div style={{ padding: '5px 8px', fontSize: 10, letterSpacing: 1, color: '#647a8e', background: 'rgba(14,19,25,0.85)', border: PANEL_BORDER }}>CLICK SETS</div>
                {[['target', 'TARGET'], ['launch', 'LAUNCH PT']].map(([k, label]) => (
                  <div key={k} onClick={() => this.setState({ clickMode: k })} style={overlayBtn(
                    s.clickMode === k ? (k === 'target' ? '#6b5228' : '#2b4a58') : '#1b2530',
                    s.clickMode === k ? (k === 'target' ? '#e8b356' : '#56c8e8') : '#647a8e',
                  )}>{label}</div>
                ))}
                {s.areaMode === 'custom' && (
                  <div onClick={() => { this.setState({ areaMode: 'country', customArea: null, selected: 0, scrubH: 0 }); this.scheduleRecompute(); }}
                    style={overlayBtn('#5a3028', '#e2705f')}>CLEAR CUSTOM AREA</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', pointerEvents: 'auto' }}>
                <div onClick={() => { this._sphereKey = null; this.setState((st) => ({ globe: !st.globe })); }}
                  style={overlayBtn('#2b4a58', '#56c8e8')}>{s.globe ? 'VIEW: 3D GLOBE' : 'VIEW: 2D MAP'}</div>
                <div data-testid="wind-source"
                  onClick={() => {
                    if (s.fetching) return;
                    if (s.windSource === 'live') {
                      this.sim.setLiveField(null);
                      this.setState({ windSource: 'synthetic' });
                      this.scheduleRecompute();
                    } else if (this._liveField) {
                      this.sim.setLiveField(this._liveField);
                      this.setState({ windSource: 'live' });
                      this.scheduleRecompute();
                    } else {
                      this.fetchLive();
                    }
                  }}
                  style={overlayBtn(
                    s.windSource === 'live' ? '#3f6b4d' : '#1b2530',
                    s.fetching ? '#e8b356' : s.windSource === 'live' ? '#6fd58a' : '#647a8e',
                  )}>{srcLabel}</div>
                <div onClick={() => this.setState((st) => ({ showWinds: !st.showWinds }))}
                  style={overlayBtn(s.showWinds ? '#2b4a58' : '#1b2530', s.showWinds ? '#56c8e8' : '#647a8e')}>
                  WIND FIELD {s.showWinds ? 'ON' : 'OFF'}
                </div>
              </div>
            </div>
            <div style={{ position: 'absolute', bottom: 10, right: 10, padding: '5px 10px', fontSize: 10, color: '#647a8e', background: 'rgba(14,19,25,0.85)', border: PANEL_BORDER }}>
              {b ? 'WINDS @ FL' + Math.round(b.alt * 10) / 10 + ' km · ' + this.fmtDur(s.scrubH) : 'WINDS @ FLOAT ALT'}
            </div>
            <div style={{ position: 'absolute', bottom: 10, left: 10, padding: '3px 8px', fontSize: 9, color: '#647a8e', background: 'rgba(14,19,25,0.7)' }}>
              {s.windSource === 'live'
                ? 'MAP © OSM © CARTO · WINDS © OPEN-METEO (GFS, 14D HORIZON — SYNTH BEYOND)'
                : 'MAP © OSM © CARTO · WINDS SYNTH-CLIM v2 (SIMULATED)'}
            </div>
          </div>
        </div>

        {/* ============ TIMELINE / SCRUBBER ============ */}
        <div style={{ flexShrink: 0, background: '#0e1319', borderTop: PANEL_BORDER }}>
          <canvas ref={(el) => { this._prof = el; }} style={{ display: 'block', width: '100%', height: 84 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 14px', borderTop: '1px solid #141c25' }}>
            <div onClick={() => this.togglePlay()} data-testid="play"
              style={{ width: 76, textAlign: 'center', padding: '6px 0', cursor: 'pointer', border: '1px solid #2b4a58', color: '#56c8e8', fontSize: 11, fontWeight: 600, letterSpacing: 2 }}>
              {s.playing ? '❚❚ HOLD' : '▶ FLY'}
            </div>
            <input type="range" min={0} max={this.scrubMaxH()} step={1} value={Math.round(s.scrubH)}
              onChange={(e) => this.setState({ scrubH: Number(e.target.value), playing: false })}
              style={{ flex: 1, height: 18 }} />
            <div style={{ display: 'flex', gap: 16, color: '#647a8e', fontSize: 11, whiteSpace: 'nowrap' }}>
              <div><span style={{ color: '#56c8e8', fontWeight: 600 }}>{this.fmtDur(s.scrubH)}</span></div>
              <div>{utc.toISOString().slice(0, 16).replace('T', ' ')}Z</div>
              <div>POS <span style={{ color: '#c6d2dd' }}>{b ? this.fmtLL(b.lat, b.lon) : '—'}</span></div>
              <div>ALT <span style={{ color: '#e8b356' }}>{b ? b.alt.toFixed(1) + ' km' : '—'}</span></div>
              <div>WIND <span style={{ color: '#c6d2dd' }}>{b ? wspd.toFixed(0) + ' m/s @ ' + wdir.toFixed(0) + '°' : '—'}</span></div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
