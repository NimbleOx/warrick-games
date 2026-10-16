# Turf War

A territory-capture game like *Paper.io* and *Splix.io*. Each player owns a patch of the board. Leave it to draw a trail, then return to your land to claim everything the trail encloses. If anyone crosses your trail while you're outside, you're out.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 2–8 players online, each on their own device. Arrows or WASD to turn; swipe on touch screens. Players move one cell per tick (about 8–10 cells a second) and can't reverse straight back.
- The board is a grid (start around 100 × 70 cells). Everyone spawns with a small 3 × 3 home patch.
- Claiming: when your head re-enters your own land, your trail and everything it encloses become yours. Find the enclosed area with a flood fill from the board edges: any cell the fill can't reach without crossing your land or trail is claimed.
- Kills: crossing someone's trail kills them, and you take their trail cells. Head-on collisions kill both.
- Rounds are timed (host picks; default 3 minutes). Dead players respawn after a few seconds with a fresh home patch and lose their old land. The biggest share of the board when time runs out wins. A live scoreboard shows each player's percentage.
- CPU players: wander out in a short loop and come home, and turn back early when an enemy gets near their trail.
- Not in v1: power-ups and a no-respawn battle-royale mode. Design so they can be added.

## Design notes

- A grid with discrete ticks is deterministic and cheap to network. Clients send direction changes; the server broadcasts per-tick changes (head moves, plus claimed cells as runs or bitmasks), and a full board snapshot on join or reconnect.
- Grid games tolerate latency well. Movement on the client can simply snap to each tick, with no prediction.
