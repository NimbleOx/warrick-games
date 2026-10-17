import { CODE_ALPHABET, CODE_LENGTH, CODE_RE } from "../shared/constants";

export { GameRoom } from "./room";

export default {
  async fetch(request, env): Promise<Response> {
    // The zone route only sends warrick.games/light-cycles* here; vite.config.ts uses the same base path.
    const { pathname } = new URL(request.url);

    if (pathname === "/light-cycles/api/games" && request.method === "POST") {
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = randomCode();
        if (await env.GAME_ROOM.getByName(code).init(code)) return Response.json({ code });
      }
      return Response.json({ error: "Couldn't allocate a game code, try again" }, { status: 503 });
    }

    const match = pathname.match(/^\/light-cycles\/api\/games\/([A-Za-z0-9]+)(\/ws)?$/);
    if (match) {
      const code = match[1].toUpperCase();
      if (!CODE_RE.test(code)) return Response.json({ error: "Game not found" }, { status: 404 });
      const stub = env.GAME_ROOM.getByName(code);
      if (match[2]) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected a WebSocket", { status: 426 });
        }
        return stub.fetch(request);
      }
      const info = await stub.info();
      if (!info) return Response.json({ error: "Game not found" }, { status: 404 });
      return Response.json(info);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
