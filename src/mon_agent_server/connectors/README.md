# Connector packages

Connectors are discovered from `manifests/<connector-key>.json`. The Agent
Server does not import concrete adapters. Each connected identity runs in its
own `python -m mon_agent_server.connectors.worker` process and communicates
with the host over newline-delimited JSON RPC.

## Manifest contract

A manifest declares:

- stable `key`, display metadata, connector `version`, and `module:Class`
  adapter;
- `watch` files whose content revision replaces only that connector worker;
- input `events`, read-only `queries`, and executable `actions`;
- a Draft 2020-12 JSON Schema for every query and action payload.

The same manifest drives runtime validation, model-visible tool contracts, the
HTTP connector catalog, and the desktop connector page. Do not duplicate an
action schema in the manager, tool implementation, or frontend.

## Adapter contract

The adapter class receives `(connector, publish, report_state)` and implements:

- `run()` for the long-lived remote event stream;
- `execute(action, payload)` for connector actions;
- `runtime_snapshot()` for bounded status/capability data;
- `close()` for idempotent shutdown.

Adapter diagnostics must go to logging or stderr. Ordinary stdout is redirected
to stderr inside the worker so it cannot corrupt the RPC stream.

## Reload boundary

Editing a valid manifest or any listed `watch` file retires the old worker and
starts a fresh worker with a revision-specific import cache. A short grace
period tolerates an editor's partial write; a persistently invalid or removed
manifest retires stale code. Changing the generic catalog, supervisor, worker
protocol, or Agent Server HTTP code still requires an Agent Server restart.
