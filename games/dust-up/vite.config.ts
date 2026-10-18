import { gameConfig } from "@warrick/kit/vite";

// Served at warrick.games/dust-up/, next to the hub and the other games (see wrangler.jsonc).
// The client has a second page, check.html: the determinism check, to open in each browser (see
// the README).
export default gameConfig("dust-up", {
  environments: {
    client: { build: { rollupOptions: { input: { main: "index.html", check: "check.html" } } } },
  },
});
