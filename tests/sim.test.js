import { describe, it, expect, afterEach } from 'vitest';
import {
  isa, gasRho, computePayload, windAt, setLiveField, hasLive,
  gcKm, wrapLon, simulate, samplePoints, samplePointsInCircle,
  rankPoints, monteCarloDay, launchWindow, compareStrategies,
  pointInPoly, COUNTRIES, CITIES, CONTINENTS,
} from '../src/sim.js';

afterEach(() => setLiveField(null));

describe('ISA atmosphere', () => {
  it('matches sea-level standard conditions', () => {
    const a = isa(0);
    expect(a.T).toBeCloseTo(288.15, 2);
    expect(a.p).toBeCloseTo(101325, 0);
    expect(a.rho).toBeCloseTo(1.225, 2);
  });
  it('pressure and density fall monotonically with altitude', () => {
    let prev = isa(0);
    for (let h = 1; h <= 40; h++) {
      const a = isa(h);
      expect(a.p).toBeLessThan(prev.p);
      expect(a.rho).toBeLessThan(prev.rho);
      prev = a;
    }
  });
  it('has an isothermal layer between 11 and 20 km', () => {
    expect(isa(12).T).toBeCloseTo(216.65, 2);
    expect(isa(19).T).toBeCloseTo(216.65, 2);
  });
});

describe('lift model', () => {
  const cfg = { volume: 25000, payloadKg: 900, ballastKg: 300, gas: 'helium', type: 'adjustable' };

  it('helium is lighter than air at all altitudes', () => {
    for (let h = 0; h <= 30; h += 5) expect(gasRho(h, 'helium')).toBeLessThan(isa(h).rho);
  });
  it('computes a stratospheric ceiling for the default config', () => {
    const p = computePayload(cfg);
    expect(p.canLift).toBe(true);
    expect(p.ceiling).toBeGreaterThan(10);
    expect(p.ceiling).toBeLessThan(40);
    expect(p.bandLo).toBeLessThanOrEqual(p.bandHi);
    expect(p.capDays).toBeGreaterThan(0);
  });
  it('hydrogen lifts higher than helium for the same envelope', () => {
    const he = computePayload(cfg);
    const h2 = computePayload({ ...cfg, gas: 'hydrogen' });
    expect(h2.ceiling).toBeGreaterThan(he.ceiling);
  });
  it('reports negative lift when overloaded', () => {
    const p = computePayload({ ...cfg, volume: 1000, payloadKg: 2500 });
    expect(p.canLift).toBe(false);
    expect(p.ceiling).toBeNull();
  });
  it('superpressure has a zero-width control band', () => {
    const p = computePayload({ ...cfg, type: 'superpressure' });
    expect(p.bandLo).toBe(p.bandHi);
    expect(p.budgetKm).toBe(0);
  });
});

describe('geo helpers', () => {
  it('computes known great-circle distances', () => {
    // London -> New York ~ 5570 km
    expect(gcKm(51.5, -0.1, 40.7, -74.0)).toBeGreaterThan(5400);
    expect(gcKm(51.5, -0.1, 40.7, -74.0)).toBeLessThan(5750);
    expect(gcKm(48.1, 11.5, 48.1, 11.5)).toBe(0);
  });
  it('wraps longitudes into [-180, 180]', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(360)).toBe(0);
    expect(wrapLon(45)).toBe(45);
  });
  it('point-in-polygon works on country polygons', () => {
    const usa = COUNTRIES.find((c) => c.id === 'usa');
    expect(pointInPoly(-100, 40, usa.poly)).toBe(true);   // Kansas
    expect(pointInPoly(10, 50, usa.poly)).toBe(false);    // Germany
  });
});

describe('wind field', () => {
  it('synthetic field returns finite winds everywhere', () => {
    for (let lat = -80; lat <= 80; lat += 20) {
      for (let alt = 1; alt <= 30; alt += 7) {
        const w = windAt(lat, 30, alt, 12);
        expect(Number.isFinite(w.u)).toBe(true);
        expect(Number.isFinite(w.v)).toBe(true);
        expect(Math.hypot(w.u, w.v)).toBeLessThan(150);
      }
    }
  });
  it('prefers the live (forecast) field when one is set', () => {
    // uniform 10 m/s westerly on a coarse grid
    const lats = [-70, 0, 70], lons = [-180, -60, 60], alts = [1, 10, 20], hours = 4;
    const n = hours * alts.length * lats.length * lons.length;
    const u = new Float32Array(n).fill(10);
    const v = new Float32Array(n).fill(0);
    setLiveField({ lats, lons, alts, hours, u, v });
    expect(hasLive()).toBe(true);
    const w = windAt(45, 10, 12, 1);
    expect(w.u).toBeCloseTo(10, 5);
    expect(w.v).toBeCloseTo(0, 5);
  });
  it('falls back to synthetic outside the live-data time horizon', () => {
    const lats = [-70, 0, 70], lons = [-180, -60, 60], alts = [1, 10, 20], hours = 4;
    const n = hours * alts.length * lats.length * lons.length;
    setLiveField({ lats, lons, alts, hours, u: new Float32Array(n).fill(10), v: new Float32Array(n) });
    const live = windAt(45, 10, 12, 1);
    const beyond = windAt(45, 10, 12, 1000); // past the horizon -> synthetic
    expect(live.u).toBeCloseTo(10, 5);
    expect(beyond.u).not.toBeCloseTo(10, 5);
  });
});

describe('trajectory simulation', () => {
  const perf = computePayload({ volume: 25000, payloadKg: 900, ballastKg: 300, gas: 'helium', type: 'adjustable' });
  const opts = { bandLo: perf.bandLo, bandHi: perf.bandHi, budgetKm: perf.budgetKm, capDays: perf.capDays, captureKm: 200 };

  it('produces an hourly path starting at the launch point', () => {
    const r = simulate({ lat: 34.5, lon: -104.2 }, { lat: 48.1, lon: 11.5 }, opts);
    expect(r.path[0]).toMatchObject({ lat: 34.5, lon: -104.2, t: 0 });
    expect(r.path.length).toBeGreaterThan(24);
    for (const p of r.path) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(88);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
      expect(p.alt).toBeGreaterThanOrEqual(0);
    }
  });
  it('stops within capture radius when it arrives', () => {
    const target = { lat: 48.1, lon: 11.5 };
    const r = simulate({ lat: 34.5, lon: -104.2 }, target, opts);
    if (r.arrived) {
      const last = r.path[r.path.length - 1];
      expect(gcKm(last.lat, last.lon, target.lat, target.lon)).toBeLessThanOrEqual(200);
      expect(r.tArrH).toBe(r.path.length - 1);
    }
    expect(r.closestKm).toBeGreaterThanOrEqual(0);
    expect(r.flownKm).toBeGreaterThan(0);
  });
  it('a zero-width band never spends altitude budget', () => {
    const r = simulate({ lat: 40, lon: -100 }, { lat: 48, lon: 11 }, { ...opts, bandLo: 18, bandHi: 18, budgetKm: 0 });
    expect(r.altUsedKm).toBe(0);
    for (const p of r.path) expect(p.alt).toBe(18);
  });
});

describe('mission planning', () => {
  const perf = computePayload({ volume: 25000, payloadKg: 900, ballastKg: 300, gas: 'helium', type: 'adjustable' });
  const target = { lat: 48.1, lon: 11.5 };

  it('samples launch points inside a country polygon', () => {
    const usa = COUNTRIES.find((c) => c.id === 'usa');
    const pts = samplePoints(usa.poly, 12);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThanOrEqual(14);
    for (const p of pts) expect(pointInPoly(p.lon, p.lat, usa.poly)).toBe(true);
  });
  it('samples points inside a circular custom area', () => {
    const pts = samplePointsInCircle({ lat: 47, lon: 8 }, 400, 14);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(gcKm(p.lat, p.lon, 47, 8)).toBeLessThanOrEqual(400);
  });
  it('ranks launch points best-first', () => {
    const usa = COUNTRIES.find((c) => c.id === 'usa');
    const ranked = rankPoints(samplePoints(usa.poly, 8), target, perf, 200, 0, 3, 2);
    expect(ranked.length).toBeGreaterThan(0);
    for (let i = 1; i < ranked.length; i++) {
      const a = ranked[i - 1], b = ranked[i];
      if (a.arrived === b.arrived && a.arrived) expect(a.tArrH).toBeLessThanOrEqual(b.tArrH);
      if (a.arrived === b.arrived && !a.arrived) expect(a.closestKm).toBeLessThanOrEqual(b.closestKm);
      if (a.arrived !== b.arrived) expect(a.arrived).toBe(true);
    }
    expect(ranked[0].mc).not.toBeNull();
  });
  it('monte carlo probability is a valid fraction', () => {
    const mc = monteCarloDay({ lat: 34.5, lon: -104.2 }, target, perf, 0, 4, 200);
    expect(mc.p).toBeGreaterThanOrEqual(0);
    expect(mc.p).toBeLessThanOrEqual(1);
    expect(mc.members).toBe(4);
  });
  it('launch window scans the requested date range', () => {
    const w = launchWindow({ lat: 34.5, lon: -104.2 }, target, perf, { days: 8, stepDays: 4, members: 2 });
    expect(w.map((x) => x.day)).toEqual([0, 4, 8]);
  });
  it('compares the three altitude strategies', () => {
    const rows = compareStrategies({ lat: 34.5, lon: -104.2 }, target,
      { volume: 25000, payloadKg: 900, ballastKg: 300, gas: 'helium', type: 'adjustable' });
    expect(rows.map((r) => r.key)).toEqual(['superpressure', 'zeropressure', 'adjustable']);
    for (const row of rows) expect(row.r === null || typeof row.r.arrived === 'boolean').toBe(true);
  });
});

describe('static data', () => {
  it('countries, cities and coastlines are well-formed', () => {
    expect(COUNTRIES.length).toBeGreaterThan(30);
    for (const c of COUNTRIES) expect(c.poly.length).toBeGreaterThanOrEqual(3);
    expect(CITIES.length).toBeGreaterThan(50);
    for (const c of CITIES) {
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
    }
    expect(CONTINENTS.length).toBeGreaterThan(10);
  });
});
