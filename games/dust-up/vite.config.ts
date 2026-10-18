import { defineConfig } from "vite";

// Milestone 1 is a client-only sandbox: no Worker yet, so not the kit's gameConfig (milestone 4).
// It's served under /dust-up/ already, like the finished game will be. check.html is the
// determinism check to open in each browser.
export default defineConfig({
  base: "/dust-up/",
  build: { rollupOptions: { input: { main: "index.html", check: "check.html" } } },
});
