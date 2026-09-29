# Deploy Browser Extension

Upload, publish, or inspect an existing extension in Chrome Web Store and Microsoft Edge Add-ons. Multiple targets run independently in parallel; every target's result is collected before the action determines the overall outcome.

**Migration note:** this implementation uses Chrome Web Store API v2 and requires the new `chrome-publisher-id` input for Chrome. That is a breaking change for existing Chrome callers; the package version is now `2.0.0`. Move existing `@v1` workflows to `@v2` only after adding the publisher ID and arranging receipt persistence as shown below. You can pin a reviewed commit SHA instead of the major-version tag. The manual workflow in this repository uses `./` to exercise the checked-out implementation.

## Operations

| `operation` | Behavior |
|---|---|
| `status` | Read store status and, when available, recorded operation status. Does not upload or publish. ZIP optional. |
| `upload` | Upload the supplied ZIP, or resume a matching recorded upload. Does not request publication. |
| `publish` | Publish an already uploaded package using its matching local receipt and original ZIP, or report a remotely confirmed completed submission. Does not upload a replacement. |
| `deploy` | Upload or resume the supplied package, then request publication when the upload is ready. |

If `operation` is omitted, legacy `publish: false` selects `upload` and `publish: true` selects `deploy`. When supplying `operation`, omit the legacy `publish` input. `publish: true` combined with `operation: status` or `operation: upload` is rejected as contradictory. `publish` still requires the original ZIP to verify package identity; `status` is the only operation that can omit it.

A successful submission is not a guarantee that the extension is already public. Store review can remain pending after submission. The action reports the observed phase and store state rather than equating every accepted request with a completed release.

## Single-store usage

```yaml
# Replace @v2 with the released version or reviewed commit you intend to run.
- uses: GreedyLabs/action-deploy-browser-extension@v2
  id: deploy
  with:
    targets: chrome
    operation: upload
    zip-path: extension.zip
    chrome-publisher-id: ${{ vars.CHROME_PUBLISHER_ID }}
    chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
    state-dir: .browser-extension-deploy
  env:
    CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
```

For Edge, use `targets: edge`, `edge-product-id: ${{ vars.EDGE_PRODUCT_ID }}`, and the `EDGE_CLIENT_ID` / `EDGE_API_KEY` secrets. `targets: chrome, edge` remains supported, but both targets then share one GitHub job and its retry boundary. The fragment above does not persist receipts; use the full workflow below for retries across runners.

## Independent retries and one package for both stores

[examples/release.yml](./examples/release.yml) contains a complete workflow to copy into an extension repository. Adapt its build steps to the project. It:

1. Builds one ZIP, with `manifest.json` at the ZIP root, and preserves it as `extension-package`.
2. Runs a Chrome/Edge matrix with `fail-fast: false`, passing one target to each action invocation.
3. Downloads that same ZIP for each store, including retries. Re-running the package job reuses the saved artifact instead of rebuilding the version.
4. Finds the latest earlier job that ran for that store, requires its matching receipt snapshot, and saves state with `always()` even after a deployment failure.
5. Lets a manual run choose a store and operation. `source-run-id` reuses an earlier run's original ZIP and receipt; it is required for `publish`.

The part that gives each store its own GitHub retry button is:

```yaml
strategy:
  fail-fast: false
  matrix:
    target: [chrome, edge]
# Within the deploy action's inputs:
# targets: ${{ matrix.target }}
```

After one store fails, use **Re-run failed jobs** or re-run that store's job. The successful store does not need to be re-executed. See GitHub's [job re-run documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) and [matrix failure handling](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations#handling-failures).

For a later publish, run the workflow manually with `operation: publish`, the intended target, and the ID of the earlier upload run. Do not build another ZIP from the same source and assume it is identical: ZIP metadata or build output can change its SHA-256. Receipts bind the store item, extension version, and ZIP SHA-256; the same version with a different ZIP is blocked.

### Receipt artifacts

Receipts are JSON files under `.browser-extension-deploy/`. They retain upload/publish intent, known operation IDs, and outcomes so another runner can resume the correct phase. They are not stored by GitHub automatically.

The example names snapshots `deploy-state-<target>-<run_attempt>`. It uses GitHub's [jobs-for-an-attempt API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt) to locate the most recent earlier `Deploy (chrome)` or `Deploy (edge)` job that actually ran. Attempts that ran only the other store are skipped. The snapshot must match that exact attempt: if attempt 2 ran this store but lost its snapshot, attempt 3 will stop instead of restoring attempt 1's stale state.

A `source-run-id` is subject to the same last-executed-job check. Only when no earlier invocation exists may a fresh upload/deploy/status start without a snapshot. Lookup/download failures, an unfinished source job, or a missing/expired snapshot for the last invocation stop the workflow for inspection. Keep the `Deploy (<target>)` job names and snapshot naming scheme consistent when adapting the examples.

Immediately before calling the action, the workflow creates `invocation.json` in the state directory. This marker is separate from the action's receipt files and makes a snapshot available even if input validation or authentication fails before any store write. Restoring a marker without a deployment receipt permits that first write to be tried again; it does not claim an upload already succeeded.

The example retains artifacts for 30 days and includes hidden files when uploading the receipt directory. Adjust retention before relying on a longer upload-to-publish interval. A forcibly terminated runner may not save its final receipt even with `always()`. If a write was accepted but its response or receipt is unavailable, inspect the store before attempting another write; the workflow cannot promise recovery of an operation ID it never received.

### Concurrency

Use one concurrency group per store item, with `cancel-in-progress: false`, as in the example. Use the same group in every workflow within that repository which writes to the item. Avoid an outer workflow-level `cancel-in-progress: true`: it can interrupt a deployment after the store has accepted a request.

GitHub concurrency groups do not coordinate different repositories, dashboard edits, or other deployment tools. Keep those writers separate from an active deployment. The matrix still permits Chrome and Edge to run in parallel because they use different groups.

### ZIP layout

The extension manifest must be at the ZIP root, not inside a `dist/` directory. Create the archive outside the directory being archived:

```sh
pnpm run build
(cd dist && zip -r ../extension.zip . -x '*.map' '*.DS_Store')
```

## Store-specific limits

**Chrome:** set both publisher and extension IDs. API v2 exposes publication/submission status, but it does not provide the current unpublished draft's version in the form needed to prove that a local upload receipt still describes that draft. A new publish-only request therefore requires the matching receipt and original ZIP, and assumes no one replaced the draft manually or through another tool after the recorded upload. Do not treat a local receipt as remote content verification.

**Edge:** the supported operation-status endpoints require known upload or publish operation IDs. They are not a general query for all current product/review state. Without a matching recorded operation, `status` cannot reconstruct a previous upload or prove that no submission is in review. Preserve the operation IDs in the receipts. An uncertain write is not blindly replayed, and a generic conflict is not automatically counted as success.

The first creation/submission of an extension remains a store-dashboard task. This action operates on an existing store item. See the official [Chrome Web Store API documentation](https://developer.chrome.com/docs/webstore/api) and [Microsoft Edge publishing API documentation](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/api/using-addons-api).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `zip-path` | Except for `status` | — | Original ZIP used to verify version and SHA-256, including publish-only |
| `targets` | Yes | `chrome` | Comma-separated `chrome`, `edge`; duplicates are removed and an empty list is rejected |
| `operation` | No | Legacy mapping | `status`, `upload`, `publish`, or `deploy` |
| `publish` | No | `false` | Legacy upload/deploy selection when `operation` is omitted |
| `chrome-publisher-id` | For Chrome | — | Chrome Web Store API v2 publisher ID |
| `chrome-extension-id` | For Chrome | — | Existing Chrome extension ID |
| `edge-product-id` | For Edge | — | Existing Edge Add-ons product ID |
| `state-dir` | No | `.browser-extension-deploy` | Local receipt directory; restore before and persist after the action |
| `request-timeout-seconds` | No | `30` | Individual HTTP timeout; integer 1–120 |
| `poll-timeout-seconds` | No | `300` | Polling timeout; integer 1–3600 |
| `poll-interval-seconds` | No | `5` | Polling delay; integer 1–60 |
| `max-attempts` | No | `3` | HTTP attempt limit, integer 1–10, for requests safe to retry; does not replay uncertain writes |

## Credentials

For Chrome, enable the Chrome Web Store API, authorize the service account for the intended publisher, and save its JSON key as `CHROME_SERVICE_ACCOUNT_KEY`. Configure `CHROME_PUBLISHER_ID` and `CHROME_EXTENSION_ID` as repository variables. Follow the current [Chrome API setup instructions](https://developer.chrome.com/docs/webstore/api/get-started) for account access.

For Edge, obtain Publish API credentials from [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge). Save `EDGE_CLIENT_ID` and `EDGE_API_KEY` as secrets and `EDGE_PRODUCT_ID` as a repository variable. The examples read credentials only from the corresponding target's environment variables.

## Outputs and results

| Output | Description |
|---|---|
| `results` | JSON array of per-target results; can be empty when shared input or ZIP validation fails before targets start |
| `failed-targets` | Comma-separated targets with `pending`, `blocked`, or `failed` outcomes |
| `outcome` | Overall outcome of the invocation |
| `state-dir` | Receipt directory to preserve for the next invocation |
| `chrome-upload-status` | Legacy Chrome upload status output |
| `chrome-publish-status` | Legacy Chrome publish status output |
| `edge-operation-id` | Legacy Edge upload operation ID output |
| `edge-publish-operation-id` | Edge publish operation ID |

Each target result includes `target`, `name`, `operation`, `outcome`, and `phase`, plus available version/SHA-256, remote status, upload/publish status, operation IDs, receipt path, message, and error details. Outcomes distinguish `success`, `skipped`, `pending`, `blocked`, and `failed`; inspect the phase and message before choosing the next operation. A `pending`, `blocked`, or `failed` result fails the action so unfinished work remains visible and can be retried. If every target is skipped, the overall outcome is `skipped`; a mix containing a failure reports overall `failed`. Results and the job summary preserve one store's completed work even when another store fails. A summary-writing problem does not change the deployment outcome.

An accepted or completed API request does not establish public availability. The summary reports the store's observed state; review completion can require a later status check.

## Development and manual integration checks

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Commit the rebuilt `dist/` with source changes because GitHub runs `dist/index.js`.

[The manual integration workflow](./.github/workflows/test.yml) defaults to read-only `status`. It runs against real store items and uses `tests/fixtures/dist.zip` for upload/deploy, so configure dedicated test items before choosing a write operation. Its matrix, package retention, receipt restore, and concurrency behavior match the release example. Running local tests does not submit to either store.

## License

[MIT](./LICENSE)
