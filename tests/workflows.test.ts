import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ArtifactStub { id?: number; name: string; expired: boolean }
interface JobStub { name: string; status: string; conclusion: string | null }
interface ApiState {
  artifacts?: Record<number, ArtifactStub[]>;
  jobs?: Record<string, JobStub[]>;
  runs?: Record<number, number>;
  error?: Error;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as
  new (...arguments_: string[]) => (...arguments_: unknown[]) => Promise<void>;
const environment = { RUN_ATTEMPT: '1', DEPLOY_TARGET: 'edge', SOURCE_RUN_ID: '', OPERATION: 'upload' };
const edge: JobStub = { name: 'Deploy (edge)', status: 'completed', conclusion: 'success' };
const chrome: JobStub = { name: 'Deploy (chrome)', status: 'completed', conclusion: 'success' };
const old: ArtifactStub = { id: 41, name: 'deploy-state-edge-1', expired: false };
const latest: ArtifactStub = { id: 42, name: 'deploy-state-edge-2', expired: false };

/** Extract only the known github-script blocks without a YAML parsing dependency. */
function scriptsFrom(yaml: string): string[] {
  const lines = yaml.split('\n');
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== '          script: |') continue;
    const body: string[] = [];
    while (index + 1 < lines.length && (lines[index + 1]!.startsWith('            ') || lines[index + 1] === '')) {
      body.push(lines[++index]!.slice(12));
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

for (const file of ['.github/workflows/test.yml', 'examples/release.yml']) {
  describe(file, () => {
    const yaml = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const scripts = scriptsFrom(yaml);

    async function run(index: number, env: Record<string, string>, data: ApiState = {}) {
      const outputs: Record<string, unknown> = {};
      const writes: Array<{ path: string; value: string }> = [];
      const github = {
        rest: { actions: {
          listWorkflowRunArtifacts: 'artifacts',
          listJobsForWorkflowRunAttempt: 'jobs',
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            if (data.error) throw data.error;
            return { data: { run_attempt: data.runs?.[run_id] ?? 1 } };
          },
        } },
        paginate: async (method: string, { run_id, attempt_number }: { run_id: number; attempt_number?: number }) => {
          if (data.error) throw data.error;
          return method === 'jobs' ? data.jobs?.[`${run_id}:${attempt_number}`] ?? [] : data.artifacts?.[run_id] ?? [];
        },
      };
      const fs = {
        mkdir: async () => undefined,
        writeFile: async (path: string, value: string) => { writes.push({ path, value }); },
      };
      await new AsyncFunction('core', 'github', 'context', 'process', 'require', scripts[index]!)(
        { setOutput: (key: string, value: unknown) => { outputs[key] = value; }, info: () => undefined },
        github,
        { runId: 10, repo: { owner: 'test', repo: 'test' } },
        { env },
        (name: string) => { expect(name).toBe('node:fs/promises'); return fs; },
      );
      return { outputs, writes };
    }

    it('has four script blocks and records the invocation before calling the action', () => {
      expect(scripts).toHaveLength(4);
      const marker = yaml.indexOf('      - name: Record this invocation');
      const deploy = yaml.indexOf('      - name: Deploy selected store');
      expect(marker).toBeGreaterThan(0);
      expect(marker).toBeLessThan(deploy);
      expect(yaml).toContain('if: ${{ always() && hashFiles(\'.browser-extension-deploy/*.json\') != \'\' }}');
      expect(yaml).toContain('include-hidden-files: true');
      expect(yaml).toContain('fail-fast: false');
      expect(yaml).toContain('cancel-in-progress: false');
    });

    it('builds one new upload package and chooses independent targets', async () => {
      const { outputs } = await run(0, { REQUESTED_TARGETS: 'both', REQUESTED_OPERATION: 'upload', SOURCE_RUN_ID: '' });
      expect(outputs.targets).toBe('["chrome","edge"]');
      expect(outputs.build).toBe(true);
    });

    it('reuses a source ZIP for publish and refuses publish without that source', async () => {
      const { outputs } = await run(0, { REQUESTED_TARGETS: 'edge', REQUESTED_OPERATION: 'publish', SOURCE_RUN_ID: '123' });
      expect(outputs.build).toBe(false);
      expect(outputs['source-run-id']).toBe('123');
      await expect(run(0, { REQUESTED_TARGETS: 'edge', REQUESTED_OPERATION: 'publish', SOURCE_RUN_ID: '' })).rejects.toThrow('requires source-run-id');
    });

    it('reuses an existing package even when the package job is rerun', async () => {
      const { outputs } = await run(1, { RUN_ATTEMPT: '2' }, { artifacts: { 10: [{ name: 'extension-package', expired: false }] } });
      expect(outputs.exists).toBe(true);
      expect(yaml).toContain('if: steps.package.outputs.exists != \'true\'');
    });

    it('does not rebuild a missing or expired original ZIP on a retry', async () => {
      await expect(run(1, { RUN_ATTEMPT: '2' })).rejects.toThrow('Original extension-package');
      await expect(run(1, { RUN_ATTEMPT: '2' }, { artifacts: { 10: [{ name: 'extension-package', expired: true }] } })).rejects.toThrow('Original extension-package');
    });

    it('allows an initial store invocation without a previous receipt', async () => {
      expect((await run(2, environment)).outputs).toEqual({});
    });

    it('skips attempts that ran only the other store', async () => {
      const { outputs } = await run(2, { ...environment, RUN_ATTEMPT: '3' }, {
        jobs: { '10:2': [chrome], '10:1': [edge] }, artifacts: { 10: [old] },
      });
      expect(outputs['artifact-id']).toBe('41');
    });

    it('blocks stale fallback after the latest store invocation lost its snapshot', async () => {
      await expect(run(2, { ...environment, RUN_ATTEMPT: '3' }, {
        jobs: { '10:2': [{ ...edge, conclusion: 'cancelled' }], '10:1': [edge] }, artifacts: { 10: [old] },
      })).rejects.toThrow('Missing receipt snapshot deploy-state-edge-2');
    });

    it('rejects an expired latest snapshot even when an older snapshot is available', async () => {
      await expect(run(2, { ...environment, RUN_ATTEMPT: '3' }, {
        jobs: { '10:2': [edge] }, artifacts: { 10: [old, { ...latest, expired: true }] },
      })).rejects.toThrow('Missing receipt snapshot');
    });

    it('selects the snapshot matching the latest executed target job exactly', async () => {
      const { outputs } = await run(2, { ...environment, RUN_ATTEMPT: '3' }, {
        jobs: { '10:2': [edge] }, artifacts: { 10: [old, latest] },
      });
      expect(outputs['artifact-id']).toBe('42');
      expect(outputs['artifact-name']).toBe('deploy-state-edge-2');
    });

    it('ignores a skipped target job because it could not write to the store', async () => {
      const { outputs } = await run(2, { ...environment, RUN_ATTEMPT: '3' }, {
        jobs: { '10:2': [{ ...edge, conclusion: 'skipped' }], '10:1': [edge] }, artifacts: { 10: [old, latest] },
      });
      expect(outputs['artifact-id']).toBe('41');
    });

    it('validates source-run job history before restoring its receipt', async () => {
      const { outputs } = await run(2, { ...environment, SOURCE_RUN_ID: '123', OPERATION: 'publish' }, {
        runs: { 123: 2 }, jobs: { '123:2': [edge] }, artifacts: { 123: [latest] },
      });
      expect(outputs['run-id']).toBe('123');
      expect(outputs['artifact-id']).toBe('42');
    });

    it('does not use a source-run snapshot from before its last store write', async () => {
      await expect(run(2, { ...environment, SOURCE_RUN_ID: '123' }, {
        runs: { 123: 3 }, jobs: { '123:3': [chrome], '123:2': [{ ...edge, conclusion: 'cancelled' }] }, artifacts: { 123: [old] },
      })).rejects.toThrow('Missing receipt snapshot deploy-state-edge-2');
    });

    it('does not restore a source job that is still running or does not exist', async () => {
      await expect(run(2, { ...environment, SOURCE_RUN_ID: '123' }, {
        jobs: { '123:1': [{ ...edge, status: 'in_progress', conclusion: null }] }, artifacts: { 123: [old] },
      })).rejects.toThrow('Cannot establish a completed');
      await expect(run(2, { ...environment, SOURCE_RUN_ID: '123' })).rejects.toThrow('no executed Deploy');
    });

    it('propagates API failures rather than treating them as missing state', async () => {
      await expect(run(2, { ...environment, RUN_ATTEMPT: '2' }, { error: new Error('API offline') })).rejects.toThrow('API offline');
      await expect(run(1, { RUN_ATTEMPT: '1' }, { error: new Error('API offline') })).rejects.toThrow('API offline');
    });

    it('creates a separate invocation marker for validation or authentication failures', async () => {
      const { writes } = await run(3, environment);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.path).toBe('.browser-extension-deploy/invocation.json');
      expect(JSON.parse(writes[0]!.value)).toEqual({ schemaVersion: 1, runId: 10, runAttempt: 1, target: 'edge' });
    });
  });
}
