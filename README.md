# Deploy Browser Extension

A GitHub Action to upload and publish browser extensions to the **Chrome Web Store** and/or **Microsoft Edge Add-ons** store.

Both stores deploy in parallel when multiple targets are specified. The first submission to each store must be done manually — this action only updates existing extensions.

## Structure

```
src/
├── utils.ts          — shared utilities (requireEnv, base64url)
├── deploy.ts         — abstract DeployTarget base class
├── index.ts          — action entrypoint
└── targets/
    ├── chrome.ts     — ChromeWebStoreTarget
    └── edge.ts       — EdgeAddonsTarget
```

## Usage

### Chrome only

```yaml
- uses: GreedyLabs/action-deploy-browser-extension@v1
  with:
    zip-path: dist/extension.zip
    targets: chrome
    chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
  env:
    CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
```

### Edge only

```yaml
- uses: GreedyLabs/action-deploy-browser-extension@v1
  with:
    zip-path: dist/extension.zip
    targets: edge
    edge-product-id: ${{ vars.EDGE_PRODUCT_ID }}
  env:
    EDGE_CLIENT_ID: ${{ secrets.EDGE_CLIENT_ID }}
    EDGE_API_KEY: ${{ secrets.EDGE_API_KEY }}
```

### Both stores

```yaml
- uses: GreedyLabs/action-deploy-browser-extension@v1
  with:
    zip-path: dist/extension.zip
    targets: chrome, edge
    chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
    edge-product-id: ${{ vars.EDGE_PRODUCT_ID }}
    publish: true
  env:
    CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
    EDGE_CLIENT_ID: ${{ secrets.EDGE_CLIENT_ID }}
    EDGE_API_KEY: ${{ secrets.EDGE_API_KEY }}
```

### Full workflow example

```yaml
name: Release Extension

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: npm ci && npm run build

      - name: Zip extension
        run: zip -r dist/extension.zip dist/ --exclude "*.map"

      - name: Deploy
        uses: GreedyLabs/action-deploy-browser-extension@v1
        with:
          zip-path: dist/extension.zip
          targets: chrome, edge
          chrome-extension-id: ${{ vars.CHROME_EXTENSION_ID }}
          edge-product-id: ${{ vars.EDGE_PRODUCT_ID }}
          publish: true
        env:
          CHROME_SERVICE_ACCOUNT_KEY: ${{ secrets.CHROME_SERVICE_ACCOUNT_KEY }}
          EDGE_CLIENT_ID: ${{ secrets.EDGE_CLIENT_ID }}
          EDGE_API_KEY: ${{ secrets.EDGE_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `zip-path` | ✅ | — | Path to the `.zip` file to upload |
| `targets` | ✅ | `chrome` | Comma-separated list of targets: `chrome`, `edge` |
| `publish` | ❌ | `false` | Set to `true` to publish after upload |
| `chrome-extension-id` | When targeting `chrome` | — | Chrome Web Store extension ID (use `vars`) |
| `edge-product-id` | When targeting `edge` | — | Edge Add-ons product ID (use `vars`) |

## Outputs

| Output | Description |
|---|---|
| `chrome-upload-status` | Chrome Web Store upload state (`SUCCESS` or error) |
| `chrome-publish-status` | Chrome Web Store publish status |
| `edge-operation-id` | Edge Add-ons upload operation ID |

## Obtaining credentials

### Chrome Web Store — `CHROME_SERVICE_ACCOUNT_KEY`

1. [Google Cloud Console](https://console.cloud.google.com) → IAM → **Service Accounts** → Create service account
2. Keys tab → **Add Key** → JSON → download
3. Enable the **Chrome Web Store API** in APIs & Services → Library
4. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Account → **API Access** → register the service account email
5. Store the JSON file contents (**minified** with `jq -c . key.json`) as `CHROME_SERVICE_ACCOUNT_KEY`

### Microsoft Edge Add-ons — `EDGE_CLIENT_ID`, `EDGE_API_KEY`

1. [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) → Extensions → **Publish API**
2. Click **Create API credentials**
3. Copy the **Client ID** and **API Key**

## License

[MIT](./LICENSE)
