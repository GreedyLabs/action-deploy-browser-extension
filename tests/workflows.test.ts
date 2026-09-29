import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { invocationStep, receiptArtifact } from '../src/control/types.js';

const shared = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const example = readFileSync(new URL('../examples/release.yml', import.meta.url), 'utf8');
const manual = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const helper = 'GreedyLabs/action-deploy-browser-extension/internal/control@v2.1.0';

function stageBlock(stage: string): string {
  const blocks = shared.split(/(?=      - name:)/);
  const found = blocks.find((block) => block.includes(`          stage: ${stage}\n`));
  expect(found, `Missing ${stage} control stage`).toBeDefined();
  return found!;
}

describe('reusable deployment workflow contract', () => {
  it('owns the shared jobs and delegates workflow control to the tested helper', () => {
    expect(shared).toContain('  workflow_call:');
    expect(shared).toContain('  plan:');
    expect(shared).toContain('  package:');
    expect(shared).toContain('  deploy:');
    expect(shared).not.toContain('actions/github-script');
    expect(shared).toContain('uses: GreedyLabs/action-deploy-browser-extension@v2.1.0');
    for (const stage of ['plan', 'package', 'validate-package', 'restore', 'checkpoint', 'guard']) {
      const block = stageBlock(stage);
      expect(block).toContain(`uses: ${helper}`);
      expect(block).toContain('github-token: ${{ github.token }}');
      expect(block).toContain('artifact-name: ${{ inputs.artifact-name }}');
      expect(block).toContain('release-branch: ${{ inputs.release-branch }}');
    }
  });

  it('keeps each store as an independent retry boundary under an item lock', () => {
    expect(shared).toContain('fail-fast: false');
    expect(shared).toContain('target: ${{ fromJSON(needs.plan.outputs.targets) }}');
    expect(shared).toContain('group: browser-extension-${{ matrix.target }}-');
    expect(shared).toContain('cancel-in-progress: false');
    expect(shared).not.toMatch(/^\s*cancel-in-progress: true/m);
    expect(shared).toContain('targets: ${{ matrix.target }}');
  });

  it('reuses original packages and does not check out or rebuild in a store job', () => {
    const deploy = shared.split('  deploy:\n')[1]!;
    expect(deploy).not.toContain('actions/checkout');
    expect(deploy).not.toContain('pnpm/action-setup');
    expect(shared).toContain('if: steps.package.outputs.exists != \'true\'');
    expect(shared).toContain('if: needs.plan.outputs.build == \'true\'');
    expect(shared).toContain('run-id: ${{ needs.plan.outputs.source-run-id || github.run_id }}');
    expect(shared).toContain('zip-path: package/${{ needs.plan.outputs.zip-file-name }}');
    expect(shared).toContain('path: ${{ inputs.zip-path }}');
  });

  it('supports caller build commands and only sets up pnpm when a lockfile exists', () => {
    expect(shared).toContain('hashFiles(\'pnpm-lock.yaml\') != \'\'');
    expect(shared).toContain('uses: pnpm/action-setup@v6');
    expect(shared).toContain('node-version: ${{ inputs.node-version }}');
    expect(shared).toContain('BUILD_COMMAND: ${{ inputs.build-command }}');
    expect(shared).toContain('run: bash -e -o pipefail -c "$BUILD_COMMAND"');
  });

  it('uses stable marker and snapshot names independently of the caller job name', () => {
    const rendered = shared
      .replaceAll('${{ inputs.artifact-name }}', 'sample-package')
      .replaceAll('${{ matrix.target }}', 'chrome')
      .replaceAll('${{ github.run_attempt }}', '123');
    expect(rendered).toContain(`name: ${invocationStep('sample-package', 'chrome')}`);
    expect(rendered).toContain(`name: ${receiptArtifact('sample-package', 'chrome', 123)}`);
    expect(shared).toContain('include-hidden-files: true');
    expect(shared).toContain('retention-days: ${{ inputs.retention-days }}');
    expect(shared).toContain('if: ${{ always() && hashFiles(\'.browser-extension-deploy/*.json\') != \'\' }}');
  });

  it('restores before checkpointing and checks release freshness immediately before writes', () => {
    const restore = shared.indexOf('      - name: Restore deployment receipt');
    const checkpoint = shared.indexOf('      - name: Record deployment invocation');
    const guard = shared.indexOf('      - name: Verify the current release commit');
    const write = shared.indexOf('      - name: Deploy selected store');
    expect(restore).toBeGreaterThan(0);
    expect(checkpoint).toBeGreaterThan(restore);
    expect(guard).toBeGreaterThan(checkpoint);
    expect(write).toBeGreaterThan(guard);
    expect(stageBlock('guard')).toContain('if: needs.plan.outputs.operation != \'status\'');
    expect(stageBlock('restore')).toContain('source-run-id: ${{ needs.plan.outputs.source-run-id }}');
  });

  it('accepts explicit credentials without repository-specific defaults', () => {
    expect(shared).toContain('chrome-publisher-id: ${{ inputs.chrome-publisher-id }}');
    expect(shared).toContain('chrome-extension-id: ${{ inputs.chrome-extension-id }}');
    expect(shared).toContain('edge-product-id: ${{ inputs.edge-product-id }}');
    expect(shared).not.toContain('${{ vars.');
    for (const secret of ['CHROME_SERVICE_ACCOUNT_KEY', 'EDGE_CLIENT_ID', 'EDGE_API_KEY']) {
      expect(shared).toContain(`      ${secret}:\n        required: false`);
      expect(shared).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
    expect(shared).toContain('  contents: read');
    expect(shared).toContain('  actions: read');
  });
});

describe('thin workflow callers', () => {
  for (const [name, source] of [['example', example], ['manual integration', manual]]) {
    it(`${name} passes configuration and leaves retry infrastructure to the shared workflow`, () => {
      expect(source).not.toContain('actions/github-script');
      expect(source).not.toContain('actions/upload-artifact');
      expect(source).not.toContain('actions/download-artifact');
      expect(source).not.toContain('strategy:');
      expect(source).not.toContain('  package:');
      expect(source).toContain('default: status');
      expect(source).toContain('chrome-publisher-id: ${{ vars.CHROME_PUBLISHER_ID }}');
      expect(source).toContain('source-run-id: ${{ inputs.source-run-id }}');
    });
  }

  it('keeps main uploads and tag publication as caller policy', () => {
    expect(example).toContain('startsWith(github.ref, \'refs/tags/\') && \'publish\' || \'upload\'');
    expect(example).toContain('GreedyLabs/action-deploy-browser-extension/.github/workflows/deploy.yml@v2');
    expect(example).toContain('build-command: pnpm install --frozen-lockfile && pnpm run build:zip');
  });

  it('uses a dedicated fixture for manual integration without a duplicated implementation', () => {
    expect(manual).toContain('uses: ./.github/workflows/deploy.yml');
    expect(manual).toContain('build-command: cp tests/fixtures/dist.zip extension.zip');
    expect(manual).not.toContain('  push:');
    expect(manual).toContain('operation: ${{ inputs.operation }}');
  });
});
