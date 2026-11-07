// NLA counts unit footprints minus only the block / structure area that sits
// ON a unit (owner 2026-11-07). Corridors and entrances drawn as blocks
// between units must not reduce NLA — they used to (SW L1 showed 1,096 sq ft
// against 2,196 sq ft of units).

import { describe, expect, it } from 'vitest';
import { computeBoundaryMetrics } from '../../src/core/floorPlans';

const rect = ([x, y, width, height]: number[]) => ({ x, y, width, height });
const square = [[0, 0], [20, 0], [20, 20], [0, 20]];

describe('boundary metrics — NLA', () => {
  it('a corridor block beside the units reduces UFA but not NLA', () => {
    const m = computeBoundaryMetrics({
      boundaries: [{ points: square, closed: true, kind: 'BOUNDARY' }],
      placements: [rect([0, 0, 10, 10]), rect([10, 0, 10, 10])],
      blocks: [rect([0, 10, 20, 4])], // corridor south of both units
      structure: null,
    });
    expect(m.ufa).toBe(320);
    expect(m.nla).toBe(200);
    expect(m.blockAreaSqft).toBe(80);
  });

  it('a block on top of a unit subtracts only the overlap', () => {
    const m = computeBoundaryMetrics({
      boundaries: [{ points: square, closed: true, kind: 'BOUNDARY' }],
      placements: [rect([0, 0, 10, 10])],
      blocks: [rect([8, 8, 4, 4])], // pillar straddling the unit corner: 2×2 on the unit
      structure: null,
    });
    expect(m.nla).toBe(96);
    expect(m.ufa).toBe(384);
  });

  it('Sembawang L1 (live geometry 2026-11-07): NLA follows the unit area', () => {
    const g = {"placements":[[13.123,18.373,11.155,6.561],[24.278,18.373,11.155,6.561],[22.966,24.934,12.467,9.843],[22.966,3.281,6.562,11.155],[22.966,34.777,12.467,9.842],[22.966,44.619,12.467,9.843],[22.966,54.462,12.467,9.842],[13.123,64.304,11.155,6.562],[24.278,64.304,11.155,6.562],[40.682,13.124,3.281,4.922],[40.682,22.967,3.281,4.921],[40.682,27.888,3.281,4.921],[40.682,32.809,3.281,4.922],[40.682,37.731,3.281,4.921],[40.682,42.652,3.281,4.921],[40.682,47.573,3.281,4.921],[40.682,52.494,3.281,4.922],[40.682,62.337,3.281,9.514],[3.3,5.3,6.46,9.19],[3.281,17.717,6.39,3.84],[3.281,21.557,6.44,3.95],[3.281,25.507,6.45,3.85],[3.281,29.357,6.38,3.86],[3.281,33.217,6.39,3.84],[40.682,57.416,3.281,4.921],[3.281,73.299,3.281,3.937],[6.562,73.299,3.281,3.937],[40.682,18.046,3.281,4.921],[16.404,3.281,6.562,11.155],[29.528,3.281,6.561,11.155],[3.281,37.057,6.47,4.93],[3.281,41.987,6.51,6.32],[6.753,48.307,3.09,3.84],[3.281,80.508,10.74,7.55],[14.021,80.578,10.43,7.48],[24.451,80.568,10.49,7.49],[13.124,24.935,9.82,6.58],[13.124,31.515,9.7,6.4],[13.124,37.915,9.76,6.45],[13.124,44.365,9.84,6.57],[13.124,50.935,9.71,6.57],[13.124,57.505,9.84,5.6],[3.281,58.709,6.58,4.83],[3.281,63.539,6.44,4.85],[3.281,68.389,6.49,4.91]],"blocks":[[3.3,3.3,3.527,3.281],[3.281,48.228,3.609,3.609],[42.979,4.593,0.984,7.874],[42.979,80.183,0.984,7.218],[3.281,14.49,6.562,3.227],[9.843,14.436,30.84,3.937],[36.089,3.281,6.89,9.843],[36.089,13.124,4.594,1.312],[9.908,18.373,3.216,62.139],[35.433,18.373,5.25,62.139],[13.124,70.866,22.309,9.646],[3.281,77.236,6.627,3.276],[34.941,80.512,5.742,7.546],[40.683,71.851,2.296,16.207]],"boundary":[[3.281,3.281],[43.963,3.281],[43.963,88.058],[3.281,88.058]]};
    const m = computeBoundaryMetrics({
      boundaries: [{ points: g.boundary, closed: true, kind: 'BOUNDARY' }],
      placements: g.placements.map(rect),
      blocks: g.blocks.map(rect),
      structure: null,
      gfaSqft: 3448.9,
    });
    expect(m.ufa).toBe(2349.5);
    expect(m.blockAreaSqft).toBe(1099.4);
    expect(m.nla).toBe(2190.3); // 2,195.7 of unit footprints − ~5.3 of pillar overlap
  });
});
