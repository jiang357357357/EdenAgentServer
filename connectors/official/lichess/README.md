# Lichess Connector Package

Build and stage the isolated Worker with:

```bash
node Script/Project/package_connector.mjs lichess
```

Credentials are stored privately per connector identity and injected as `MON_CONNECTOR_IDENTITY_CREDENTIAL`. No host environment fallback is inherited; legacy `tokenEnv` does not select host variables.

Install the built `dist/connectors/lichess` directory through plugin management, authorize this package version, enable its component, then configure and grant the connector instance resources. The host has no game-name launch branch.
