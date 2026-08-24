# Eden Agent Victoria 3 Observer Bridge

This directory contains the Victoria 3 side of the integration. The
source tree under `mod/` is deployed as a local Victoria 3 mod; do not copy its
files into the game's installation directory.

The bridge appends child on-actions to `on_game_started_after_lobby` and
`on_monthly_pulse_country`. For the player country it writes namespaced
telemetry to Victoria 3's `logs/debug.log`. It has no gameplay actions.

The Rust host can optionally run a no-op control probe. That probe is not an
input channel inside this Mod: the host writes a generated effect file, invokes
Victoria 3's Debug-console `run` command with deterministic keyboard input, and
waits for a matching ACK in `debug.log`. Control is disabled by default and no
construction, production, diplomacy, save, speed, or pause action exists yet.

Use `Script/Cmd/Win/InstallVictoria3Observer.ps1` to deploy the development mod,
then enable **Eden Agent Victoria 3 Observer Bridge** in a launcher playset and
start Victoria 3 in Debug Mode.
