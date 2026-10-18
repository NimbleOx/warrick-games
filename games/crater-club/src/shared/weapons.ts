export type WeaponKind = "missile" | "mirv" | "funky" | "leapfrog" | "roller" | "dirt" | "tracer";

export type WeaponId =
  | "baby_missile"
  | "missile"
  | "baby_nuke"
  | "nuke"
  | "mirv"
  | "deaths_head"
  | "funky_bomb"
  | "leapfrog"
  | "roller"
  | "dirt_clod"
  | "dirt_ball"
  | "tracer";

export type ItemId = "shield" | "parachute";
export type ShopId = WeaponId | ItemId;
export type Inventory = Partial<Record<ShopId, number>>;

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: WeaponKind;
  desc: string;
  price: number;
  bundle: number;
  radius: number;
  damage: number;
  /** MIRV: number of warheads released at the apex and their horizontal spread. */
  warheads?: number;
  spread?: number;
  /** Funky bomb: bomblets thrown out of the first blast. */
  bomblets?: number;
  bombletRadius?: number;
  bombletDamage?: number;
  /** Leapfrog: extra hops after the first impact. */
  bounces?: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  desc: string;
  price: number;
  bundle: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  baby_missile: {
    id: "baby_missile",
    name: "Baby Missile",
    kind: "missile",
    desc: "Small but unlimited.",
    price: 0,
    bundle: 0,
    radius: 18,
    damage: 45,
  },
  missile: {
    id: "missile",
    name: "Missile",
    kind: "missile",
    desc: "Reliable mid-size blast.",
    price: 1500,
    bundle: 5,
    radius: 30,
    damage: 70,
  },
  baby_nuke: {
    id: "baby_nuke",
    name: "Baby Nuke",
    kind: "missile",
    desc: "Big crater, big damage.",
    price: 6000,
    bundle: 3,
    radius: 55,
    damage: 90,
  },
  nuke: {
    id: "nuke",
    name: "Nuke",
    kind: "missile",
    desc: "Flattens a neighborhood.",
    price: 10000,
    bundle: 1,
    radius: 90,
    damage: 120,
  },
  mirv: {
    id: "mirv",
    name: "MIRV",
    kind: "mirv",
    desc: "Splits into 5 warheads at the top of its arc.",
    price: 9000,
    bundle: 2,
    radius: 28,
    damage: 55,
    warheads: 5,
    spread: 0.7,
  },
  deaths_head: {
    id: "deaths_head",
    name: "Death's Head",
    kind: "mirv",
    desc: "Splits into 9 heavy warheads. Overkill.",
    price: 18000,
    bundle: 1,
    radius: 38,
    damage: 70,
    warheads: 9,
    spread: 0.8,
  },
  funky_bomb: {
    id: "funky_bomb",
    name: "Funky Bomb",
    kind: "funky",
    desc: "Scatters bomblets everywhere.",
    price: 7000,
    bundle: 2,
    radius: 40,
    damage: 50,
    bomblets: 7,
    bombletRadius: 22,
    bombletDamage: 35,
  },
  leapfrog: {
    id: "leapfrog",
    name: "Leapfrog",
    kind: "leapfrog",
    desc: "Hops forward, exploding three times.",
    price: 6000,
    bundle: 3,
    radius: 30,
    damage: 55,
    bounces: 2,
  },
  roller: {
    id: "roller",
    name: "Roller",
    kind: "roller",
    desc: "Rolls downhill into whoever is hiding there.",
    price: 3000,
    bundle: 5,
    radius: 30,
    damage: 65,
  },
  dirt_clod: {
    id: "dirt_clod",
    name: "Dirt Clod",
    kind: "dirt",
    desc: "Dumps a ball of dirt. Bury someone.",
    price: 2000,
    bundle: 5,
    radius: 35,
    damage: 0,
  },
  dirt_ball: {
    id: "dirt_ball",
    name: "Dirt Ball",
    kind: "dirt",
    desc: "A much bigger ball of dirt.",
    price: 4500,
    bundle: 3,
    radius: 65,
    damage: 0,
  },
  tracer: {
    id: "tracer",
    name: "Tracer",
    kind: "tracer",
    desc: "Harmless. Leaves its path on screen.",
    price: 300,
    bundle: 10,
    radius: 0,
    damage: 0,
  },
};

export const ITEMS: Record<ItemId, ItemDef> = {
  shield: {
    id: "shield",
    name: "Shield",
    price: 5000,
    bundle: 1,
    desc: "Absorbs 60 blast damage. One is raised automatically each round.",
  },
  parachute: {
    id: "parachute",
    name: "Parachute",
    price: 1500,
    bundle: 2,
    desc: "Opens automatically when you fall, preventing fall damage.",
  },
};

export const WEAPON_ORDER = Object.keys(WEAPONS) as WeaponId[];
export const ITEM_ORDER = Object.keys(ITEMS) as ItemId[];
export const SHOP_ORDER: ShopId[] = [...WEAPON_ORDER.filter((w) => w !== "baby_missile"), ...ITEM_ORDER];

export function isWeaponId(id: string): id is WeaponId {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id);
}

export function isShopId(id: string): id is ShopId {
  return isWeaponId(id) || Object.prototype.hasOwnProperty.call(ITEMS, id);
}

export function shopDef(id: ShopId): { name: string; desc: string; price: number; bundle: number } {
  return isWeaponId(id) ? WEAPONS[id] : ITEMS[id];
}

/** Baby missiles are unlimited; everything else is counted. */
export function weaponCount(inv: Inventory, id: WeaponId): number {
  return id === "baby_missile" ? Infinity : (inv[id] ?? 0);
}
