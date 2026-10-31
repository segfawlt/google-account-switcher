# Security Policy

## Architecture & Data Boundaries

- **Zero External Network Calls:** Account Switcher runs strictly locally inside Firefox (`data_collection_permissions: none`). The only network endpoint queried by background sync is Google's own session endpoint (`https://accounts.google.com/ListAccounts`) using the browser's existing cookie jar.
- **No Remote Code or Bundled Obfuscation:** All extension logic is plain, unminified ES modules under `src/` with strict Content Security Policy defaults (Manifest V3) and DOM construction via `document.createElement` / `textContent` (never `innerHTML`).
- **Least-Privilege Host Access:** Only `https://*.google.com/*` is requested at install time. Any non-`*.google.com` custom domain uses `optional_host_permissions` gated behind an explicit user click.

## Reporting a Vulnerability

Please report security issues privately via [GitHub Private Vulnerability Reporting](https://github.com/segfawlt/google-account-switcher/security/advisories/new) rather than opening a public issue.
