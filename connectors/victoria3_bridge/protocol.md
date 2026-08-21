# Victoria 3 Bridge Protocol

The Mod remains read-only. The optional host-side control probe uses Victoria 3's
Debug console and a generated effect file; the Mod does not read external files,
open sockets, edit saves, or access process memory.

Victoria 3 writes records through the Jomini `debug_log` effect. A normal log
prefix may precede the marker; consumers start parsing at `[MONAGENT]|`.

```text
[MONAGENT]|1|HELLO|bridge_version=0.1.0|mode=observe
[MONAGENT]|1|SNAPSHOT|date=1842.03.15|country_id=CHI|country_name=Great Qing|...
[MONAGENT]|1|ACK|command_id=019...|status=success|action=probe_control
```

Rules:

- Field separator: `|`
- Key/value separator: the first `=` in each field
- Protocol version: unsigned decimal immediately after the marker
- Unknown record kinds and protocol versions are ignored
- `ACK` requires a non-empty `command_id`
- Values are transported as strings; normalization belongs to the Rust side
- A snapshot is emitted after entering a campaign and once per in-game month
- Connector events use `country_id + date` as the durable deduplication key

Protocol changes that alter field meaning require a new protocol version.

## Control probe

The probe is deliberately not a general command protocol. The Rust host writes a
single effect file under the Victoria 3 user-data `run/` directory. Its complete
effect is a `debug_log` ACK containing a host-generated UUID. The Windows host
requires a prior compatible `HELLO`, so a log file or loading window alone never
marks the game ready for input. It then
focuses the verified `victoria3.exe` top-level window and types only
`run monagent_<uuid>` into the Debug console. Success is reported only after the
observer receives the matching ACK.

No gameplay action is implemented by protocol version 1.
