# Decisions Made

## 2025-10-29 – Bundle Applesauce client for bunker support

The NIP-46 "bunker" flow requires a browser-side client so that remote signer secrets never transit the orchestrator. We evaluated two options:

- Expose the `applesauce-*` packages directly through the `/vendor` shim.
- Pre-bundle only the small surface the dashboard needs.

Serving the raw packages triggered a large number of module requests and MIME-type errors (macOS `sendfile` rejects bare directories). To keep the front-end simple while still letting users paste a `bunker://` URI, we now build a dedicated bundle with:

```bash
bun run build:bunker-client
```

This emits `public/vendor/bunker-client.js`, which exports the applesauce `NostrConnectSigner` and `RelayPool`. The dashboard imports that bundle instead of reaching into `node_modules` at runtime. If we swap libraries later, we only need to update the bundling step.
