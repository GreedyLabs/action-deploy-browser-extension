import { describe, it, expect, afterEach } from 'vitest';
import { parseTargets, getInputs } from '../src/inputs.js';

describe('parseTargets', () => {
  it('parses a single target', () => {
    expect(parseTargets('chrome')).toEqual(['chrome']);
  });

  it('parses multiple comma-separated targets', () => {
    expect(parseTargets('chrome, edge')).toEqual(['chrome', 'edge']);
  });

  it('trims whitespace and lowercases', () => {
    expect(parseTargets('  Chrome ,  EDGE ')).toEqual(['chrome', 'edge']);
  });

  it('ignores empty segments (e.g. a trailing comma)', () => {
    expect(parseTargets('chrome,,edge,')).toEqual(['chrome', 'edge']);
  });

  it('throws on an unknown target', () => {
    expect(() => parseTargets('firefox')).toThrow(/Unknown target\(s\): firefox/);
  });

  it('reports only the invalid targets', () => {
    expect(() => parseTargets('chrome, safari')).toThrow(/safari/);
  });
});

describe('getInputs', () => {
  const keys = ['INPUT_ZIP-PATH', 'INPUT_TARGETS', 'INPUT_PUBLISH', 'INPUT_CHROME-EXTENSION-ID', 'INPUT_EDGE-PRODUCT-ID'];
  afterEach(() => keys.forEach((k) => delete process.env[k]));

  it('reads and parses all inputs', () => {
    process.env['INPUT_ZIP-PATH'] = 'dist.zip';
    process.env['INPUT_TARGETS'] = 'chrome, edge';
    process.env['INPUT_PUBLISH'] = 'true';
    process.env['INPUT_CHROME-EXTENSION-ID'] = 'abc';
    process.env['INPUT_EDGE-PRODUCT-ID'] = 'def';

    expect(getInputs()).toEqual({
      zipPath: 'dist.zip',
      targets: ['chrome', 'edge'],
      shouldPublish: true,
      chromeExtensionId: 'abc',
      edgeProductId: 'def',
    });
  });

  it('defaults publish to false when not "true"', () => {
    process.env['INPUT_ZIP-PATH'] = 'dist.zip';
    process.env['INPUT_TARGETS'] = 'chrome';
    process.env['INPUT_PUBLISH'] = 'no';
    expect(getInputs().shouldPublish).toBe(false);
  });
});
