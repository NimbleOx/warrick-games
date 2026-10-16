// Pieces as little SVG pictures, for the tray and the player list.
import { PIECE_IDS, orientFor, orientations, type Orientation, type PieceId } from "../shared/pieces";

/**
 * The way each piece lies in the tray, and the way it first comes out of it: as it's defined if
 * it fits a 5 × 3 box, otherwise turned a quarter.
 */
export const HOME_T: Record<PieceId, number> = Object.fromEntries(
  PIECE_IDS.map((id) => {
    const o = orientations(id)[orientFor(id, 0)];
    return [id, o.w >= o.h || o.h <= 3 ? 0 : 1];
  }),
) as Record<PieceId, number>;

export function homeOrientation(id: PieceId): Orientation {
  return orientations(id)[orientFor(id, HOME_T[id])];
}

/** An SVG of the piece in its tray orientation, centred in a w × h box of squares. */
export function pieceSvg(id: PieceId, color: string, box: [number, number] = [5, 3], gap = 0.12): string {
  const o = homeOrientation(id);
  const dx = (box[0] - o.w) / 2;
  const dy = (box[1] - o.h) / 2;
  const s = 1 - gap;
  const rects = o.cells
    .map(([x, y]) => `<rect x="${x + dx + gap / 2}" y="${y + dy + gap / 2}" width="${s}" height="${s}" rx="0.12" />`)
    .join("");
  return `<svg viewBox="0 0 ${box[0]} ${box[1]}" aria-hidden="true"><g fill="${color}">${rects}</g></svg>`;
}
