// Room codes: five characters with the easily confused ones (I, O, 0, 1) left out.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

export const MAX_PLAYERS = 8;

/** The usual player colours. A game can pass its own palette to its lobby and shell. */
export const DEFAULT_COLORS = [
  "#ff4d4d", // red
  "#4da6ff", // blue
  "#5ce65c", // green
  "#ffd23f", // yellow
  "#ff6bd6", // pink
  "#3ff0e0", // cyan
  "#ff9a3c", // orange
  "#e8e8e8", // white
] as const;

export const CPU_LEVELS = ["easy", "normal", "hard"] as const;

/** WebSocket close codes: the game is gone, or the host removed this player. */
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
