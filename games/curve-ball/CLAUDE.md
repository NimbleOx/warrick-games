# Curve Ball

A browser multiplayer take on *Achtung, die Kurve* (also known as *Curve Fever*). Every player steers a line that is always moving forward; you can only turn left or right. Lines leave a permanent trail with short random gaps you can slip through. Touch any trail or the edge of the arena and you're out.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 2–8 players online, each on their own device. Steer with ←/→ or A/D; on touch screens, hold the left or right half of the screen.
- A round: everyone spawns at a random spot and heading, a 3-second countdown, then go. Constant speed and turn rate.
- Trails have a gap every 1.5–3 seconds (random), a few pixels long. Gaps can be driven through.
- Scoring follows the original: whenever someone dies, every player still alive gets 1 point. The match ends when someone reaches the target (host picks it; default 10 × (players − 1)) with a 2-point lead.
- CPU players: cast a few rays ahead (left / straight / right) and steer toward the most open direction.
- Not in v1: power-ups (speed up, slow others, fat/thin lines, wrap-around walls, clear the board). Design so they can be added.

## Design notes

- Collision: keep trails in an occupancy bitmap of the arena. Each tick, test the pixels just ahead of each head, ignoring the player's own most recent pixels.
- Trails are a pure function of inputs and tick numbers, so the network traffic can stay tiny: clients send steering changes, the server broadcasts head positions (or input changes) per tick, plus a full snapshot on join or reconnect.
