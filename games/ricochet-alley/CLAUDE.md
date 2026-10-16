# Ricochet Alley

A top-down tank battle in a maze, in the spirit of Atari *Combat* and *Tank Trouble*. Tanks drive and rotate; bullets bounce off walls and expire after a few seconds. One hit kills — including your own bullet coming back around. Last tank standing wins the round.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 2–8 players online, each on their own device. ↑/↓ drive, ←/→ rotate, Space fires. On touch screens: a virtual stick and a fire button.
- A new random maze every round: a grid maze with some extra walls knocked out so it has loops.
- Each tank can have up to 5 bullets in flight. Bullets live about 6 seconds and reflect off walls.
- Scoring: 1 point for being the last tank alive in a round. First to the target score (host picks; default 10) wins.
- CPU players: path toward the nearest enemy over the maze grid (BFS), and fire when a ray with up to 2 bounces would hit an enemy.
- Not in v1: power-ups (laser, shotgun, homing missile, mines) and team mode. Design so they can be added.

## Design notes

- Walls are axis-aligned segments on a grid, which keeps collisions simple: tanks are circles against segments, bullets are points that reflect off them.
- Free movement needs smoothing: clients predict their own tank and interpolate others between server updates. The server decides every hit.
