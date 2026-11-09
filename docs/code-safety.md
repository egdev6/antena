# Code safety

The Code safety workflow provisions hash-verified Python wheels and runs Semgrep 1.180.0 and zizmor 1.30.1 offline in a pinned, restricted Docker container. The scanner and its rules, manifest and locks live in `tools/code-safety/`. It exports committed Git blobs as inert data; it does not run target code or install target dependencies. Findings are advisory, but an operational failure or unknown coverage fails the check. The repository-policy slot is empty, so only the scanners run.

For pull requests, controls come from a separate checkout of the exact PR base SHA; the target is the event's merge/head SHA. Pushes to `main` and manual runs use the event SHA for both separate checkouts. A scanner change cannot affect its own PR scan; it takes effect after merge. The workflow itself can be changed by a PR and is protected by maintainer review and branch protection, not by the separate checkout alone.

## Scope and limits

Semgrep covers JavaScript and TypeScript extensions, and zizmor covers direct `.github/workflows/*.yml` and `.yaml` files. Other files are reported as outside scope; Rust, arbitrary YAML and local actions are not scanned as such. This is not a malware or syntax certificate. Findings need human review. Empty scope, unsafe Git entries, invalid source, incomplete scanner reports and resource or time limits fail closed. Export is bounded to 10,000 tree entries, 1 MiB per selected file and 32 MiB total selected bytes. The Semgrep parse gate uses two workers, a 10-second per-call cap and a total budget of `min(300 s, 120 s + 0.25 s/file)`; cleanup is also bounded. Node 24, Git, the hosted Linux runner and Docker remain platform dependencies.

## Provenance and updates

The vendored scanner comes from `egdev6/quorb` main `79ee3cd` plus parse-gate fixes `95e70d3`, `593f70a` and `1384a03` on `fix/semgrep-parse-gate-budget`. To update it, review the upstream diff and the complete runtime closure, bring over matching scripts, rules, manifest, locks and self-contained tests, and review any path changes. Preserve wheel hashes and the Docker image digest unless a deliberate reviewed update changes them together. Run the Node and Python tests and verify a real offline Docker scan before merging; review the workflow and trust boundary separately. New controls only become authoritative for subsequent scans once merged.

The initial vendoring PR has a bootstrap constraint: its base predates `tools/code-safety/`, so this workflow cannot execute the new controls from that base. The maintainer must arrange an explicitly reviewed bootstrap without treating a missing scanner as success.
