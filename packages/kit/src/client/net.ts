import { CLOSE_FULL, CLOSE_KICKED, CLOSE_NOT_FOUND, CLOSE_STALE } from "../shared/constants";

export type NetStatus = "connecting" | "open" | "closed";

/** Dev aid: `?lag=150` adds that many ms of round-trip delay (half each way), to try latency locally. */
const LAG = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("lag")) || 0 : 0;

/** How often a quiet socket checks it still works, with a "ping" the room answers without waking up. */
const PING_MS = 25000;
/** A socket that hears nothing this long after a ping is dead, even if it still says it's open. */
const ANSWER_MS = 8000;
/** A socket that takes this long to open has hung (a phone changing networks, say). */
const CONNECT_MS = 15000;
/** How many round trips `ClockSync` keeps. */
const PINGS_KEPT = 10;

type AnyMsg = { t: string };

/**
 * The server's clock, as an offset from ours. A ping that carries our clock comes back with the
 * server's: the server read its clock about half a round trip ago. The quickest of the last few
 * round trips wins, since a slow one waited somewhere on the way. Until a ping is back, the
 * offset comes from the newest message's clock, which is off by however long it took to arrive.
 */
export class ClockSync {
  /** Server clock minus ours. */
  skew = 0;
  private pings: { rtt: number; skew: number }[] = [];

  /** Start over (a new connection, perhaps after the computer slept). */
  reset(): void {
    this.pings = [];
  }

  /** A message carrying the server's clock. */
  message(now: number): void {
    if (!this.pings.length) this.skew = now - Date.now();
  }

  /** A pong: the server's clock, and ours from when the ping went. */
  pong(now: number, sent: number): void {
    const rtt = Date.now() - sent;
    if (rtt < 0) return;
    this.pings.push({ rtt, skew: now + rtt / 2 - Date.now() });
    if (this.pings.length > PINGS_KEPT) this.pings.shift();
    this.skew = this.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).skew;
  }
}

export interface NetHandlers<C extends AnyMsg, S extends AnyMsg> {
  hello(): C;
  message(msg: S): void;
  status(s: NetStatus): void;
  fatal(reason: string): void;
  /** The room runs newer code than this page. Without this, it's fatal. */
  stale?(): void;
}

/** A WebSocket to one game room that reconnects on its own until told to stop. */
export class Connection<C extends AnyMsg = AnyMsg, S extends AnyMsg = AnyMsg> {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer = 0;
  private connectTimer = 0;
  private pingTimer = 0;
  private answerTimer = 0;
  private heartbeatTimer = 0;
  /** How many messages the socket has heard, of any kind. */
  private heard = 0;

  constructor(
    readonly code: string,
    private h: NetHandlers<C, S>,
  ) {
    this.open();
  }

  /** Returns false if the socket isn't open (the message is dropped). */
  send(msg: C): boolean {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(msg);
    if (LAG) setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(data), LAG / 2);
    else ws.send(data);
    return true;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.stopTimers();
    clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  /**
   * Check the connection now (when the tab becomes visible again, say): reconnect straight away
   * if it's down, and make sure an open socket still works. A phone that slept or changed
   * networks can be left with a socket that says it's open but is dead.
   */
  nudge(): void {
    if (this.stopped) return;
    if (this.ws) return this.probe();
    clearTimeout(this.retryTimer);
    this.open();
  }

  /**
   * While a game is live, send a real message every few seconds. It refreshes the clock skew and
   * keeps the room's CPU budget topped up: each incoming message resets a Durable Object's
   * 30-second budget, but the plain-text pings below are answered without waking the room.
   */
  heartbeat(on: boolean): void {
    clearInterval(this.heartbeatTimer);
    if (!on) return;
    this.heartbeatTimer = window.setInterval(() => {
      this.ping();
      // A live game notices a dead socket in seconds, not at the next quiet-socket check.
      this.probe();
    }, 5000);
  }

  /** A ping the room answers itself, with our clock (`c`) and its own: see `Shell.skew`. */
  ping(): void {
    this.send({ t: "ping", c: Date.now() } as unknown as C);
  }

  private open(): void {
    if (this.stopped) return;
    this.h.status("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${import.meta.env.BASE_URL}api/games/${this.code}/ws`);
    this.ws = ws;
    this.connectTimer = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) this.abandon(ws);
    }, CONNECT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.connectTimer);
      this.attempt = 0;
      ws.send(JSON.stringify(this.h.hello()));
      this.h.status("open");
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.probe(), PING_MS);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.heard++;
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg: S;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (LAG) setTimeout(() => this.ws === ws && this.h.message(msg), LAG / 2);
      else this.h.message(msg);
    };

    ws.onclose = (ev) => this.closed(ws, ev.code);
  }

  /** The socket closed: say why, or try again after a backoff. Sockets already given up on are ignored. */
  private closed(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopTimers();
    if (this.stopped) return;
    if (code === CLOSE_NOT_FOUND) return this.fail("That game doesn't exist anymore.");
    if (code === CLOSE_KICKED) return this.fail("The host removed you from the game.");
    if (code === CLOSE_FULL) return this.fail("That game is full.");
    if (code === CLOSE_STALE) {
      if (!this.h.stale) return this.fail("This game has been updated. Reload the page to keep playing.");
      this.stopped = true;
      clearInterval(this.heartbeatTimer);
      this.h.status("closed");
      return this.h.stale();
    }
    this.h.status("closed");
    const delay = Math.min(10000, 500 * 2 ** this.attempt++);
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  /**
   * Send a "ping", which the room's auto-response answers without waking it up. If nothing at
   * all comes back in time, the socket is dead.
   */
  private probe(): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN || this.answerTimer) return;
    const heard = this.heard;
    ws.send("ping");
    this.answerTimer = window.setTimeout(() => {
      this.answerTimer = 0;
      if (this.heard === heard) this.abandon(ws);
    }, ANSWER_MS);
  }

  /** Give up on a socket and reconnect, without waiting for it to agree to close: a dead one never would. */
  private abandon(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    this.closed(ws, 0);
  }

  private stopTimers(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.answerTimer);
    clearInterval(this.pingTimer);
    this.answerTimer = 0;
  }

  private fail(reason: string): void {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    this.h.status("closed");
    this.h.fatal(reason);
  }
}
