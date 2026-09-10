# OpenTTD Connector Package

Build and stage the isolated Admin Port Worker with:

```bash
node Script/Project/package_connector.mjs openttd
```

The Worker accepts loopback Admin Port targets only and receives only its declared credential environment variable.

Install the built `dist/connectors/openttd` directory through plugin management, authorize this package version, enable its component, then configure and grant the connector instance resources. The host has no game-name launch branch.
