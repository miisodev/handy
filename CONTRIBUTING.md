# Contributing

Contributions that improve cross-platform reliability, latency, coordinate accuracy, or safety are welcome.

## Development Workflow

```bash
npm install
npm run build
npm run typecheck
npm test
npm run validate
```

## Guidelines

1. **Zero native C++ npm addons**: Keep installation instant on every OS and CPU architecture (`win32`, `darwin`, `linux`; `x64` and `arm64`) without requiring `node-gyp`.
2. **Stdout purity**: Never write diagnostic logs to `stdout` in MCP mode (`MCP-04`); `stdout` belongs exclusively to JSON-RPC frames.
3. **Permission enforcement**: Any new capability that observes the desktop or injects input must call `permissions.assertCanSee()` or `permissions.assertCanControl()` at execution time.
4. **Tests & release checks**: All pull requests must pass `npm test`, `npm run typecheck`, and `npm run validate`.
