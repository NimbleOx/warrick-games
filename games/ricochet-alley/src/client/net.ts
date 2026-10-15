import { CLOSE_KICKED, CLOSE_NOT_FOUND, type ClientMsg, type ServerMsg } from "../shared/protocol";

export type NetStatus = "connecting" | "open" | "closed";

/** Dev aid: `?lag=150` adds that many ms of round-trip delay (half each way), to try prediction locally. */
const LAG = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("lag")) || 0 : 0;

export interface NetHandlers {
  hello(): ClientMsg;
  message(msg: ServerMsg): void;
  status(s: NetStatus): void;
  fatal(reason: string): void;
}

/** A WebSocket to one game room that reconnects on its own until told to stop. */
export class Connection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer = 0;
  private pingTimer = 0;

  constructor(
    readonly code: string,
    private h: NetHandlers,
  ) {
    this.open();
  }

  /** Returns false if the socket isn't open (the message is dropped). */
  send(msg: ClientMsg): boolean {
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
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  /** Reconnect now (e.g. when the tab becomes visible again) instead of waiting for backoff. */
  nudge(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    this.h.status("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${import.meta.env.BASE_URL}api/games/${this.code}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify(this.h.hello()));
      this.h.status("open");
      clearInterval(this.pingTimer);
      // Answered by the room's auto-response without waking it up.
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 25000);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (LAG) setTimeout(() => this.ws === ws && this.h.message(msg), LAG / 2);
      else this.h.message(msg);
    };

    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (ev.code === CLOSE_NOT_FOUND) return this.fail("That game doesn't exist anymore.");
      if (ev.code === CLOSE_KICKED) return this.fail("The host removed you from the game.");
      this.h.status("closed");
      const delay = Math.min(10000, 500 * 2 ** this.attempt++);
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  private fail(reason: string): void {
    this.stopped = true;
    this.h.status("closed");
    this.h.fatal(reason);
  }
}
