import React from 'react';

const MONO = "'IBM Plex Mono', monospace";
const BORDER = '1px solid #1b2530';

const H = ({ children }) => (
  <div style={{ fontSize: 11, letterSpacing: 2.5, color: '#56c8e8', margin: '34px 0 12px', fontWeight: 600 }}>{children}</div>
);
const P = ({ children, style }) => (
  <p style={{ color: '#9db0c0', fontSize: 12, lineHeight: 1.75, margin: '0 0 10px', ...style }}>{children}</p>
);
const Code = ({ children }) => (
  <pre style={{
    background: '#10161d', border: BORDER, padding: '10px 12px', margin: '10px 0',
    color: '#c6d2dd', fontSize: 11, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre',
  }}>{children}</pre>
);
const Em = ({ children }) => <span style={{ color: '#e8eef4' }}>{children}</span>;
const K = ({ children }) => <span style={{ color: '#e8b356' }}>{children}</span>;

const TYPES = [
  ['Superpressure', 'Sealed envelope holds constant density altitude. No consumables, no altitude control — you take whatever wind blows at the ceiling. Endurance capped at 100 days.'],
  ['Zero-pressure', 'Open-duct envelope. Gas vents at sunset expansion, so ballast is dropped every night to survive the diurnal cycle. A shallow ~4 km control band; ballast runs out in days.'],
  ['Rozière', 'Hybrid: a sealed gas cell rides inside a heated air cone. The burner replaces ballast drops at night, so the consumable is fuel — a ~6 km band, cheap trim, endurance far beyond zero-pressure. The air cone and burner rig add ~18% envelope mass, so the same volume floats slightly lower.'],
  ['Adjustable', 'Vent gas to descend, drop ballast to climb — an actively-managed zero-pressure design. It reaches ~15 km below the ceiling, down into the tropospheric jet layers, which makes it the strongest steering platform here. Every maneuver spends the same ballast that also buys endurance: steer hard and the flight gets shorter.'],
];

const CAVEATS = [
  ['Coarse wind grid', 'Live winds are sampled on a 16° lat × 24° lon grid at 7 pressure levels (850–50 hPa) and interpolated trilinearly. Fronts, jet-stream cores and local terrain winds are far sharper in reality than this smoothed field.'],
  ['Forecast horizon', 'Open-Meteo GFS covers 14 days. Any simulated hour beyond that horizon quietly reuses the last forecast day — long flights and late start days degrade to persistence.'],
  ['Instant altitude moves', 'The simulator jumps between altitudes at decision time. Real balloons climb and descend at finite rates, drifting downwind through every layer on the way.'],
  ['Standard atmosphere', 'Lift, ceiling and density come from the ISA model. Real temperature profiles, weather systems and diurnal envelope heating shift the float altitude by hundreds of meters.'],
  ['Synthetic ensembles', 'The P% arrival probability perturbs the wind field with seeded synthetic noise — it is not a real NWP ensemble. Treat it as a relative ranking signal, not a calibrated probability.'],
  ['Linearized budgets', 'Ballast/fuel consumption is a fixed kg-per-km-of-altitude and kg-per-day. Real consumption depends on temperature, leak rate, burner efficiency and how hard the diurnal cycle bites.'],
  ['Geometry only', 'Arrival means passing within the capture radius (great-circle distance). There is no terrain, no airspace, no flight rules, no recovery logistics — and no icing, burst or envelope-stress modeling.'],
  ['Hourly integration', 'Positions advance in 1-hour Euler steps at the interpolated wind. Fine for planning-level trajectories; not for operational flight prediction.'],
];

export default function Explainer({ onClose }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0a0e13', fontFamily: MONO }} data-testid="explainer">
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 18px 80px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 22, letterSpacing: 2, color: '#e8eef4' }}>
            HOW THE SIMULATION WORKS
          </div>
          <div onClick={onClose} style={{ padding: '6px 12px', border: '1px solid #2b4a58', color: '#56c8e8', cursor: 'pointer', fontSize: 10, letterSpacing: 1 }}>
            ← BACK TO PLANNER
          </div>
        </div>
        <P>
          A balloon has no engine. The only thing you control is <Em>altitude</Em> — and because wind
          speed and direction change dramatically with height, choosing your altitude <Em>is</Em> choosing
          your direction. Everything on the planner follows from that one idea.
        </P>

        <H>1 · LIFT &amp; FLOAT CEILING</H>
        <P>
          The atmosphere follows the International Standard Atmosphere (ISA): pressure and density fall
          with height, with an isothermal layer between 11 and 20 km. A gas balloon floats where its
          buoyancy exactly carries its mass:
        </P>
        <Code>{`net lift(h) = V · (ρ_air(h) − ρ_gas(h)) − m_system  =  0   at the ceiling

m_system = payload + envelope + ballast        envelope ≈ 0.045 · V^0.8  (kg)
ρ_gas    from the gas law per gas (He / H₂)    (+18% envelope for a Rozière)`}</Code>
        <P>
          Since net lift falls monotonically with altitude, the planner finds the ceiling by
          <Em> bisection</Em>: 60 halvings between 0 and 40 km. Bigger envelope or lighter payload →
          higher ceiling. Hydrogen buys roughly 8% more lift than helium. If the balloon cannot float
          above 3 km, the mission is rejected (<K>CANNOT LIFT</K>).
        </P>

        <H>2 · HOW YOU STEER A BALLOON</H>
        <P>
          Winds are layered: surface winds, mid-tropospheric flow, the jet streams near 10–12 km, and
          the gentler stratospheric circulation above 16 km often blow in <Em>different directions</Em>.
          A balloon that can change altitude can hop between these conveyor belts.
        </P>
        <P>
          The simulator makes a steering decision every <K>6 hours</K>. It scans every whole-kilometer
          altitude inside the balloon&apos;s control band and scores each layer:
        </P>
        <Code>{`score(a) = wind(a) · direction_to_target  −  0.9 · |a − current_alt|

pick the altitude with the best score,
pay |Δalt| km from the maneuver budget — no budget left, no move.`}</Code>
        <P>
          The first term rewards layers whose wind pushes toward the target; the penalty term stops the
          balloon from wasting consumables chasing marginal gains. Between decisions the balloon simply
          drifts: position advances hourly at the interpolated wind for its layer.
        </P>
        <P>
          This is why the <Em>adjustable</Em> balloon dominates most missions — its deep band reaches the
          fast tropospheric jets — and why the superpressure balloon, which cannot steer at all, wins
          only when the ceiling-level wind happens to blow the right way.
        </P>

        <H>3 · THE FOUR BALLOON TYPES</H>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TYPES.map(([name, txt]) => (
            <div key={name} style={{ border: BORDER, background: '#10161d', padding: '10px 12px' }}>
              <div style={{ color: '#e8eef4', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{name}</div>
              <div style={{ color: '#9db0c0', fontSize: 11.5, lineHeight: 1.7 }}>{txt}</div>
            </div>
          ))}
        </div>
        <Code>{`type            band (below ceiling)   consumable      endurance model
superpressure   0 km  (fixed)          none            100 d cap
zero-pressure   ~4 km                  ballast         ballast / daily drops
roziere         ~6 km                  burner fuel     fuel / nightly burn
adjustable      ~15 km                 ballast + vent  ballast / managed cycle`}</Code>

        <H>4 · WINDS: FORECAST &amp; FALLBACK</H>
        <P>
          On startup the app downloads the real <Em>Open-Meteo GFS</Em> forecast: wind speed and
          direction at 7 pressure levels (850 → 50 hPa ≈ 1.5 → 20.6 km) on a global grid, 14 days ahead,
          hourly. Winds at any (lat, lon, altitude, time) come from trilinear interpolation of that
          field. If the fetch fails — or you toggle <K>SRC</K> — a synthetic climatology with seeded
          jet streams stands in.
        </P>

        <H>5 · RANKING, START DAYS &amp; MONTE CARLO</H>
        <P>
          The planner samples candidate launch points inside your area and simulates every point at
          <Em> five start days</Em> (launch day +0…+4), because waiting two days for a favorable pattern
          often beats launching now. Candidates are ranked by <Em>earliest absolute arrival</Em> —
          launch delay plus flight time — then misses by closest approach. Results stream in
          incrementally; the top points then get a Monte Carlo treatment: up to 10 simulations under
          perturbed winds, giving the <K>P%</K> arrival score and median flight time. The launch-window
          strip runs the same analysis across 11 start dates for the selected point.
        </P>

        <H>6 · WHAT THIS SIMULATION IS NOT — CAVEATS</H>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {CAVEATS.map(([name, txt]) => (
            <div key={name} style={{ border: BORDER, borderLeft: '2px solid #6b5228', background: '#10161d', padding: '10px 12px' }}>
              <div style={{ color: '#e8b356', fontSize: 11, fontWeight: 600, letterSpacing: 1, marginBottom: 4 }}>{name.toUpperCase()}</div>
              <div style={{ color: '#9db0c0', fontSize: 11.5, lineHeight: 1.7 }}>{txt}</div>
            </div>
          ))}
        </div>
        <P style={{ marginTop: 12 }}>
          In short: this is a <Em>mission design sandbox</Em> — good for comparing sites, dates,
          envelopes and control strategies against real forecast winds; not a substitute for
          operational flight prediction.
        </P>

        <div onClick={onClose} style={{
          marginTop: 30, display: 'inline-block', padding: '8px 16px',
          border: '1px solid #2b4a58', color: '#56c8e8', cursor: 'pointer', fontSize: 11, letterSpacing: 1,
        }}>
          ← BACK TO PLANNER
        </div>
      </div>
    </div>
  );
}
