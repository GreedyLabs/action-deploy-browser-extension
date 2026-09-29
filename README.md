# Deploy Browser Extension

Deploy browser extensions to Chrome Web Store and Microsoft Edge Add-ons with one reusable workflow call. It builds and preserves one ZIP, runs the stores independently, and restores deployment records when a job is retried.

## Recommended usage

Keep your checks and release triggers in the extension repository. Pass the build command and store settings to the shared workflow; no deployment scripts or receipt management belong in the caller.

```yaml
name: Release extension
on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read
  actions: read

jobs:
  deploy:
    uses: GreedyLabs/action-deploy-browser-extension/.github/workflows/deploy.yml@v2
    with:
      build-command: pnpm install --frozen-lockfile && pnpm run build:zip
      operation: ${{ startsWith(github.ref, 'refs/tags/') && 'publish' || 'upload' }}
      chrome-publisher-id: ${{ vars.CHROME_PUBLISHER_ID }}
      chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
      edge-product-id: ${{ vars.EDGE_PRODUCT_ID }}
    secrets:
      CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
      EDGE_CLIENT_ID: ${{ secrets.EDGE_CLIENT_ID }}
      EDGE_API_KEY: ${{ secrets.EDGE_API_KEY }}
```

This convenience workflow is available from **v2.1.0**. Existing direct action calls remain supported. If the repository has a check job, add `needs: check` to the deployment job. Never invoke deployment from an untrusted pull request.

The build command must produce `extension.zip`, with `manifest.json` at its root. Change `zip-path` if the project uses another filename. Node.js 22 is available by default; pnpm is installed automatically when the repository contains `pnpm-lock.yaml`. The build job does not receive store credentials.

[examples/release.yml](./examples/release.yml) includes main uploads, tag publication, and manual store/operation selection. The calling repository chooses **when** and **what** to deploy. This repository owns **how** to preserve packages, recover an interrupted operation, and coordinate the stores.

## What happens automatically

- **Main upload:** run the project build command once, save the original ZIP, then upload it to Chrome and Edge in separate jobs.
- **Tag publication:** locate the latest completed push run in the same workflow, release branch, and commit; reuse its ZIP and store records, then request publication without rebuilding or uploading again.
- **Retry:** use GitHub's **Re-run failed jobs** or rerun one store job. The original ZIP and that store's latest recorded attempt are restored automatically. A successful store does not need to run again.
- **Partial failure:** every store reports its result and preserves available records. Uncertain write requests are not blindly repeated.

Finish the main upload run before tagging the same commit. If the newest matching upload run is still running or has no original ZIP, publication stops with a clear error instead of choosing an older package. A renamed workflow or an upload started manually can use `source-run-id` explicitly.

If a tag's store job was already attempted while the upload had failed, finish recovery in the original upload run, then start a new manual `publish` for that store using the original upload's `source-run-id`. An attempted publish retains its own saved record; it never discards uncertain publication state to replace it with a different run's record.

## Workflow inputs

Only the build command and the selected stores' IDs normally need configuration.

| Input | Default | Purpose |
|---|---|---|
| `build-command` | — | Project installation/build command; required when creating a new ZIP |
| `operation` | `upload` | `status`, `upload`, `publish`, or `deploy` (upload then publish) |
| `targets` | `chrome, edge` | One or both stores |
| `chrome-publisher-id` | — | Required for Chrome API V2 |
| `chrome-extension-id` | — | Existing Chrome extension ID |
| `edge-product-id` | — | Existing Edge Add-ons product GUID |
| `zip-path` | `extension.zip` | Build output path; the original ZIP is reused on retries |
| `node-version` | `22` | Build runtime version |
| `source-run-id` | Automatic for publish | Original upload run to resume or publish; the same commit is required |
| `release-branch` | `main` | Only its current commit may write to stores; also scopes automatic source lookup. Empty disables the branch guard |
| `artifact-name` | `extension-package` | Package/receipt namespace; use distinct names for multiple extension deployments in one workflow |
| `retention-days` | `30` | Original ZIP and deployment record retention |

`status` makes no store changes and needs no build command. Supply `source-run-id` when checking a previously recorded Edge operation. Read-only status remains available for older commits. Source-run IDs must refer to an original upload run, because subsequent publish runs do not create another ZIP archive.

By default, older tags or manual runs cannot publish after `main` advances. This prevents an old upload record from being used for a newer draft. Change `release-branch` for another release branch. Disable that guard only when your release process otherwise guarantees that the selected upload still describes the store draft.

## Credentials

Configure repository **Actions variables** `CHROME_PUBLISHER_ID`, `CHROME_EXTENSION_ID`, and `EDGE_PRODUCT_ID`, and **Actions secrets** `CHROME_SERVICE_ACCOUNT_KEY`, `EDGE_CLIENT_ID`, and `EDGE_API_KEY`. Only configure credentials for the stores you select.

For Chrome, authorize the service account for the intended publisher and enable the Chrome Web Store API. See the [Chrome API setup instructions](https://developer.chrome.com/docs/webstore/api/get-started). For Edge, obtain the Publish API credentials in [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge).

The workflow uses the caller's GitHub token with `contents: read` and `actions: read` to inspect run history and restore artifacts. It does not need a personal access token.

## Recovery guarantees and limits

The saved record binds a store item, manifest version, and ZIP SHA-256. Do not rebuild a ZIP from the same source and assume it is identical. Re-running the package job reuses the original archive; a build that failed before any store invocation can be attempted again. Once a store invocation has started, a missing original archive stops recovery.

Receipt selection follows the latest attempt that reached the internal invocation checkpoint for that store. It does not depend on the caller's job display name. A missing or expired snapshot for that attempt stops recovery instead of reverting to an older one. Records are saved after failures when possible; a forcibly terminated runner can still lose its final record.

Store jobs share a concurrency group per store item and do not cancel an active deployment. Avoid workflow-level `cancel-in-progress: true`. GitHub concurrency cannot coordinate dashboard changes, other repositories, or tools using different locks. Do not replace a draft outside this workflow while a deployment is active.

Chrome can recognize a version already submitted or published, but its API cannot prove the identity of the current unpublished draft from its ZIP hash. Edge status checks require saved operation IDs; they do not discover all global review state. A completed submission request does not guarantee that the extension is publicly available. Existing v1 uploads do not automatically acquire v2 deployment records.

## Direct action usage

For workflows that already manage their own artifacts and store jobs, the existing JavaScript action remains available:

```yaml
- uses: GreedyLabs/action-deploy-browser-extension@v2
  id: deploy
  with:
    targets: chrome
    operation: upload
    zip-path: extension.zip
    chrome-publisher-id: ${{ vars.CHROME_PUBLISHER_ID }}
    chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
  env:
    CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
```

A direct call does not manage GitHub artifact retention or create separate GitHub jobs. Preserve and restore its `state-dir` yourself, or use the recommended reusable workflow above. Multiple targets within one direct call run in parallel but share one GitHub retry boundary.

All existing v2 inputs and outputs are unchanged. In addition to the store IDs, `zip-path`, `targets`, and `operation`, the direct action accepts:

| Input | Default | Purpose |
|---|---|---|
| `publish` | `false` | Legacy mapping: omitted `operation` selects upload or deploy. `true` conflicts with explicit status/upload |
| `state-dir` | `.browser-extension-deploy` | Local deployment record directory |
| `request-timeout-seconds` | `30` | Per-request timeout, 1–120 seconds |
| `poll-timeout-seconds` | `300` | Overall asynchronous polling timeout, 1–3600 seconds |
| `poll-interval-seconds` | `5` | Poll interval, 1–60 seconds |
| `max-attempts` | `3` | Read request attempt limit, 1–10; uncertain writes are not replayed |

`publish` requires a successful matching upload record and original ZIP. `status` is the only direct operation that can omit the ZIP. The `results` JSON output records each target's phase, identity, outcome, operation IDs, and error. `failed-targets` contains targets with pending/blocked/failed results; those outcomes fail the action. All-skipped results count as normal completion. Legacy Chrome status and Edge operation-ID outputs remain available; see [action.yml](./action.yml) for the complete interface.

**Migration from v1:** Chrome now requires `chrome-publisher-id` and uses API V2. Chrome status outputs use normalized phase states, so update comparisons against old API response strings. Existing `@v1` tags are unchanged.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Commit both generated `dist/index.js` and the internal controller bundle under `dist/control/`. Local tests do not submit packages to either store. [The manual integration workflow](./.github/workflows/test.yml) defaults to read-only status; configure dedicated test items before selecting a write operation. `internal/control` is an implementation detail of the reusable workflow, not an interface callers need to configure.

## License

[MIT](./LICENSE)
