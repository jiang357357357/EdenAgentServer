# Victoria 3 Connector Package

The Victoria 3 integration runs as an isolated Connector Worker. Build and stage it with:

```bash
node Script/Project/package_connector.mjs victoria3
```

The observer is read-only. `probe_control` remains disabled unless `controlEnabled` is explicitly set.

Install the built `dist/connectors/victoria3` directory through plugin management, authorize this package version, enable its component, then configure and grant the connector instance resources. The host has no game-name launch branch.

The TS probe implementation requires both command-directory write permission and `desktop.input` for `application:victoria3`. Windows input uses PowerShell/.NET interop in the plugin. The current host has no Windows connector sandbox, so this path is not enabled or OS-validated; Linux observation remains available.
