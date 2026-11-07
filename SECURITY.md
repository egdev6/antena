# Security policy

antena runs on your own PC: a local server on `127.0.0.1:4500`, a desktop app (Tauri), an MCP server and browser layers for Meld Studio. It stores your Twitch, YouTube and Meld connections locally. Please report security problems privately so they can be fixed before they are public.

## Supported versions

Only the latest release receives security fixes. The desktop app updates itself from **Ajustes › Acerca de** with signed updates.

## How to report

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting).
2. Describe what is affected, how to reproduce it and what an attacker could do.
3. Do not open a public issue, pull request or discussion about it, and do not include real tokens, keys or personal data in the report.

You will get an answer in the private report. Once a fix is released, the report can be published as a security advisory with credit to you, if you want it.

## Scope

Especially relevant areas:

- The local HTTP API and its origin checks, including LAN access with the access key.
- Custom overlays: the sandboxed iframe, the read-only SDK and actions behind approved permissions.
- The desktop app: window capabilities, navigation rules and the signed updater.
- The MCP server and anything that stores or sends Twitch, YouTube or Meld credentials.

Out of scope: problems that need someone who already controls your Windows account or your antena data folder, and reports from automated scanners without a concrete impact.
