# Stack Attack

A falling-block battle game like *Tetris 99* or a *Puyo Puyo Tetris* versus match. Read `README.md` for the rules, the architecture and how to deploy.

## Rules that the code relies on

- Everyone in a round shares one seed, so everyone gets the same piece order (7-bag).
- `Lane` in `src/shared/engine.ts` is the only model of a player's game, and the browser and the server must run it identically. Any rule change (scoring, garbage, top-out) goes there, and the checksum must cover anything that affects later play.
- Garbage timing: a clear cancels garbage up to the `known` id the lock reports; a lock without a clear lets in garbage up to the previous lock's `known`. Don't make it time-based: it would differ between browser and server.
- The garbage multiplier (`attackScale`) depends on time, so it's applied only on the server, to what goes out. Keep it out of `Lane`.
- The server is the authority. When it disagrees with a browser it bumps the board's epoch and sends a `fix`; it never trusts a placement it couldn't reach with `explore()`.
- Super Rotation System turns and kicks, 500 ms lock delay with 15 move resets, guideline gravity curve. Keep the controls local: no input should wait on the network.

## Not in v1

Opponents' falling pieces, 180° turns, per-player targeting (like *Tetris 99*'s attacker/KO modes), key remapping, and a solo marathon or sprint mode. Design so they can be added.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys. Blur buttons after clicks in the game screen, since Space is hard drop.
- Make every limit visible. If something stops a player from acting, the UI must say why.

Ask before deploying, committing or pushing.
