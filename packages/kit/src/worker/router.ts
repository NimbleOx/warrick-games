import { CODE_ALPHABET, CODE_LENGTH, CODE_RE } from "../shared/constants";
import type { RoomInfo } from "../shared/protocol";

/** The room methods the router calls, over Durable Object RPC. */
interface RoomStub {
  init(code: string): Promise<boolean>;
  info(): Promise<RoomInfo | null>;
  fetch(request: Request): Promise<Response>;
}

interface Bindings {
  GAME_ROOM: { getByName(name: string): unknown };
}

/**
 * The Worker for a game served at warrick.games/<slug>/. Static assets are served before this
 * runs; it answers only the API:
 *
 *   POST /<slug>/api/games           allocate a code and initialize that room
 *   GET  /<slug>/api/games/:code     does the game exist?
 *   GET  /<slug>/api/games/:code/ws  the room's WebSocket
 */
export function gameWorker(slug: string): ExportedHandler<Bindings> {
  const api = `/${slug}/api/games`;
  const route = new RegExp(`^/${slug}/api/games/([A-Za-z0-9]+)(/ws)?$`);
  return {
    async fetch(request, env): Promise<Response> {
      const { pathname } = new URL(request.url);
      const room = (code: string) => env.GAME_ROOM.getByName(code) as RoomStub;

      if (pathname === api && request.method === "POST") {
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = randomCode();
          if (await room(code).init(code)) return Response.json({ code });
        }
        return Response.json({ error: "Couldn't allocate a game code, try again" }, { status: 503 });
      }

      const match = pathname.match(route);
      if (match) {
        const code = match[1].toUpperCase();
        if (!CODE_RE.test(code)) return Response.json({ error: "Game not found" }, { status: 404 });
        if (match[2]) {
          if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket", { status: 426 });
          }
          return room(code).fetch(request);
        }
        const info = await room(code).info();
        if (!info) return Response.json({ error: "Game not found" }, { status: 404 });
        return Response.json(info);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  };
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
