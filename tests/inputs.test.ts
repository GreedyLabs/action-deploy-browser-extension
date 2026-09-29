import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseTargets, getInputs } from '../src/inputs.js';

afterEach(() => vi.unstubAllEnvs());
function input(key: string, value: string) { vi.stubEnv(`INPUT_${key.toUpperCase()}`, value); }
function defaults() { input('zip-path', 'dist.zip'); input('targets', 'chrome, edge'); }

describe('inputs', () => {
  it('normalizes and deduplicates targets to prevent duplicate writes', () => {
    expect(parseTargets(' Chrome,,edge,CHROME, ')).toEqual(['chrome', 'edge']);
  });
  it('rejects an empty target selection', () => expect(() => parseTargets(', ,')).toThrow(/At least one/));
  it('rejects unsupported targets', () => expect(() => parseTargets('chrome,safari')).toThrow(/safari/));
  it('maps the legacy publish input to deploy', () => {
    defaults(); input('publish', 'true');
    expect(getInputs()).toMatchObject({ operation: 'deploy', targets: ['chrome', 'edge'], pollTimeoutMs: 300000 });
  });
  it('defaults to upload', () => { defaults(); expect(getInputs().operation).toBe('upload'); });
  it('supports status without a ZIP', () => {
    input('targets', 'edge'); input('operation', 'status'); input('zip-path', '');
    expect(getInputs().zipPath).toBe('');
  });
  it('requires the original ZIP for publish', () => {
    input('targets', 'edge'); input('operation', 'publish'); input('zip-path', '');
    expect(() => getInputs()).toThrow(/zip-path/);
  });
  it('rejects contradictory operation and legacy flag', () => {
    defaults(); input('publish', 'true'); input('operation', 'upload');
    expect(() => getInputs()).toThrow(/conflicts/);
  });
  it.each(['no', '1'])('rejects ambiguous boolean %s', (value) => {
    defaults(); input('publish', value); expect(() => getInputs()).toThrow(/true or false/);
  });
  it.each(['0', '-1', '1.5', 'Infinity', 'garbage', '121'])('rejects invalid request timeout %s', (value) => {
    defaults(); input('request-timeout-seconds', value); expect(() => getInputs()).toThrow(/integer between/);
  });
});
