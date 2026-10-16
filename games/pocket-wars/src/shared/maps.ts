// The hand-made maps, as ASCII. Each tile is two characters:
//
//   terrain   .  plains    =  road    +  bridge    T  forest    ^  mountain    ~  river    w  sea
//             (followed by a space)
//   building  H  HQ        F  factory              C  city
//             followed by the owner's seat (1–4), or "-" for neutral
//
// Trailing spaces may be trimmed. The maps are symmetric so every seat gets the same start
// (test/maps.test.ts checks it): 2-player maps turn 180° onto themselves, Four Corners is
// mirrored both ways, and Three Crowns is mirrored left to right with seat 3 on the axis.
import { CAPTURE_POINTS, isBuilding, type BuildingKind, type Terrain } from "./terrain";

export interface MapBuilding {
  x: number;
  y: number;
  kind: BuildingKind;
  /** The seat that owns it at the start, or -1. */
  owner: number;
}

export interface MapDef {
  id: string;
  name: string;
  players: number;
  blurb: string;
  w: number;
  h: number;
  /** Terrain by tile index (y * w + x). */
  tiles: Terrain[];
  buildings: MapBuilding[];
  /** Tile index → building index, or -1. */
  buildingAt: number[];
  /** Each seat's HQ, as a building index. */
  hq: number[];
}

interface RawMap {
  id: string;
  name: string;
  players: number;
  blurb: string;
  rows: string[];
}

const RAW: RawMap[] = [
  {
    id: "pocket-duel",
    name: "Pocket Duel",
    players: 2,
    blurb: "Tiny and quick: a couple of roads and a factory each to fight over.",
    rows: [
      "^ . . T . . C-. . T .",
      ". H1= = = . . . ^ . C-",
      ". F1. C-= . T . . . .",
      "T . . . = = = F-. T .",
      ". T . F-= = = . . . T",
      ". . . . T . = C-. F2.",
      "C-. ^ . . . = = = H2.",
      ". T . . C-. . T . . ^",
    ],
  },
  {
    id: "twin-rivers",
    name: "Twin Rivers",
    players: 2,
    blurb: "Two rivers, four bridges. Tanks need the bridges; infantry can wade. A spare factory each, behind the rivers.",
    rows: [
      "^ T . . ~ . . T . . ~ . . C-^",
      "T H1F1. ~ . C-. . . ~ . T . .",
      ". = = = + = = = = = + = = C-.",
      ". C1. . ~ . . T . . ~ F-. . T",
      "T . . C-~ . . ^ C-. ~ . . . .",
      ". . . . ~ . C-^ . . ~ C-. . T",
      "T . . F-~ . . T . . ~ . . C2.",
      ". C-= = + = = = = = + = = = .",
      ". . T . ~ . . . C-. ~ . F2H2T",
      "^ C-. . ~ . . T . . ~ . . T ^",
    ],
  },
  {
    id: "mirror-lake",
    name: "Mirror Lake",
    players: 2,
    blurb: "A ring road around a lake, with a spare factory on each side.",
    rows: [
      "w w . . T . . C-. . ^ ^ . . T .",
      "w . . C-. . = = = = = = = . . .",
      ". . T . . = = . T . . . = C-F2.",
      ". F-. . = = . . . . ^ . = . H2.",
      "^ . . = = . . w w . . . = . C2.",
      ". . C-= . T w w w w . . = = = .",
      ". = = = . . w w w w T . = C-. .",
      ". C1. = . . . w w . . = = . . ^",
      ". H1. = . ^ . . . . = = . . F-.",
      ". F1C-= . . . T . = = . . T . .",
      ". . . = = = = = = = . . C-. . w",
      ". T . . ^ ^ . . C-. . T . . w w",
    ],
  },
  {
    id: "three-crowns",
    name: "Three Crowns",
    players: 3,
    blurb: "Three bases round a crown of cities and a factory in the middle.",
    rows: [
      "w w . . T . . ^ ^ ^ ^ ^ . . T . . w w",
      "w . . T . . T . ^ . ^ . T . . T . . w",
      ". . . . . . . . . C-. . . . . . . . .",
      "T F1. F-. T . C-. . . C-. T . F-. F2T",
      ". H1= = = C-= = = = = = = C-= = = H2.",
      ". C1. . = . T . C-F-C-. T . = . . C2.",
      "T . . . = . . . . = . . . . = . . . T",
      "~ ~ ~ . = . ^ ^ . = . ^ ^ . = . ~ ~ ~",
      ". C-. . = C-. . T = T . . C-= . . C-.",
      ". . . C-= . . ^ . = . ^ . . = C-. . .",
      "w . T . = . . . . F-. . . . = . T . w",
      "w w . . C-= = = = = = = = = C-. . w w",
      "w w w . . . C-. T F3T . C-. . . w w w",
      "w w w w . . . T . H3. T . . . w w w w",
      "w w w w w . . . . C3. . . . w w w w w",
    ],
  },
  {
    id: "four-corners",
    name: "Four Corners",
    players: 4,
    blurb: "A base in each corner, two rivers, and four cities in the middle.",
    rows: [
      "^ ^ . . T . ~ . C-. . C-. ~ . T . . ^ ^",
      "^ H1= = = = + = . . . . = + = = = = H2^",
      ". F1. C1. = ~ . . ^ ^ . . ~ = . C2. F2.",
      ". . . . T = ~ C-. . . . C-~ = T . . . .",
      "T C-. . . = + = = = = = = + = . . . C-T",
      ". . ^ . . = ~ . F-. . F-. ~ = . . ^ . .",
      "w T . . C-= ~ T . C-C-. T ~ = C-. . T w",
      "w T . . C-= ~ T . C-C-. T ~ = C-. . T w",
      ". . ^ . . = ~ . F-. . F-. ~ = . . ^ . .",
      "T C-. . . = + = = = = = = + = . . . C-T",
      ". . . . T = ~ C-. . . . C-~ = T . . . .",
      ". F4. C4. = ~ . . ^ ^ . . ~ = . C3. F3.",
      "^ H4= = = = + = . . . . = + = = = = H3^",
      "^ ^ . . T . ~ . C-. . C-. ~ . T . . ^ ^",
    ],
  },
];

const TERRAIN_CHARS: Record<string, Terrain> = {
  ".": "plains",
  "=": "road",
  "+": "bridge",
  T: "forest",
  "^": "mountain",
  "~": "river",
  w: "sea",
  H: "hq",
  F: "factory",
  C: "city",
};

export function parseMap(raw: RawMap): MapDef {
  const h = raw.rows.length;
  const w = Math.max(...raw.rows.map((r) => Math.ceil(r.length / 2)));
  const tiles: Terrain[] = [];
  const buildings: MapBuilding[] = [];
  const buildingAt: number[] = [];
  const hq: number[] = new Array(raw.players).fill(-1);
  raw.rows.forEach((row, y) => {
    const padded = row.padEnd(w * 2, " ");
    for (let x = 0; x < w; x++) {
      const c = padded[x * 2];
      const o = padded[x * 2 + 1];
      const t = TERRAIN_CHARS[c];
      if (!t) throw new Error(`${raw.id}: unknown terrain "${c}" at ${x},${y}`);
      tiles.push(t);
      if (isBuilding(t)) {
        const owner = o === "-" ? -1 : Number(o) - 1;
        if (!(owner === -1 || (owner >= 0 && owner < raw.players))) throw new Error(`${raw.id}: bad owner "${o}" at ${x},${y}`);
        if (t === "hq") {
          if (owner < 0 || hq[owner] >= 0) throw new Error(`${raw.id}: seat ${o} needs exactly one HQ`);
          hq[owner] = buildings.length;
        }
        buildingAt.push(buildings.length);
        buildings.push({ x, y, kind: t, owner });
      } else {
        if (o !== " " && o !== undefined) throw new Error(`${raw.id}: "${c}${o}" at ${x},${y} isn't a tile`);
        buildingAt.push(-1);
      }
    }
  });
  if (hq.some((b) => b < 0)) throw new Error(`${raw.id}: every seat needs an HQ`);
  return { id: raw.id, name: raw.name, players: raw.players, blurb: raw.blurb, w, h, tiles, buildings, buildingAt, hq };
}

export const MAP_LIST: MapDef[] = RAW.map(parseMap);
export const MAPS: Record<string, MapDef> = Object.fromEntries(MAP_LIST.map((m) => [m.id, m]));
export const MAP_IDS = MAP_LIST.map((m) => m.id);

export function mapsFor(players: number): MapDef[] {
  return MAP_LIST.filter((m) => m.players === players);
}

/** Capture points for a fresh game: every building untouched. */
export function freshCapture(m: MapDef): number[] {
  return m.buildings.map(() => CAPTURE_POINTS);
}
