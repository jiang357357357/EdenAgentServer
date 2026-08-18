# Native runtime binaries

Release packages place one `mon-agent-runtime` sidecar in the directory matching
the Server host:

| Host | Directory | Executable |
| --- | --- | --- |
| Windows x64 | `windows-x64` | `mon-agent-runtime.exe` |
| Windows ARM64 | `windows-arm64` | `mon-agent-runtime.exe` |
| Linux x64 glibc | `linux-x64` | `mon-agent-runtime` |
| Linux ARM64 glibc | `linux-arm64` | `mon-agent-runtime` |
| macOS Intel | `macos-x64` | `mon-agent-runtime` |
| macOS Apple Silicon | `macos-arm64` | `mon-agent-runtime` |

Portable musl builds are published as `linux-x64-musl` and
`linux-arm64-musl`. A deployment can select one explicitly with
`MON_AGENT_RUNTIME_PATH`; the automatic bundled lookup uses the glibc folder.

The Server launches the executable as a private stdio sidecar. Set
`MON_AGENT_RUNTIME_PATH` to an absolute binary path to override the bundled
runtime. Every release artifact includes a sibling `.sha256` file.
