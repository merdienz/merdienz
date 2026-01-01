import { describe, expect, it } from 'vitest';
import { assertProbeConfig, defaultUserTier } from '../src/guard.js';
import { callProbeB } from '../src/probes/confirm.js';
import { testConfig } from './helpers.js';

const VALID_PIN = 'a'.repeat(64);
const HTTPS_URL = 'https://probe.example/internal/probe';

describe('MERDIENZ_MODE and probe B startup', () => {
  it('defaults to cloud and refuses to start without PROBE_B_URL and a strong secret', () => {
    expect(() => assertProbeConfig({ merdienzMode: 'cloud', probeBUrl: '', probeBSecret: 's'.repeat(32) })).toThrow(
      /PROBE_B_URL/
    );
    expect(() =>
      assertProbeConfig({ merdienzMode: 'cloud', probeBUrl: HTTPS_URL, probeBSpkiSha256: VALID_PIN, probeBSecret: '' })
    ).toThrow(/PROBE_B_SECRET/);
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: HTTPS_URL, probeBSpkiSha256: VALID_PIN,
        probeBSecret: 'dev-probe-secret-change-me',
      })
    ).toThrow(/PROBE_B_SECRET/);
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: HTTPS_URL, probeBSpkiSha256: VALID_PIN,
        probeBSecret: 'short',
      })
    ).toThrow(/PROBE_B_SECRET/);
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: HTTPS_URL, probeBSpkiSha256: VALID_PIN,
        probeBSecret: 's'.repeat(32),
      })
    ).not.toThrow();
  });

  it('allows selfhosted and dev to run without PROBE_B_URL, and records via=in-process', async () => {
    expect(() => assertProbeConfig({ merdienzMode: 'dev', probeBUrl: '', probeBSecret: '' })).not.toThrow();
    expect(() => assertProbeConfig({ merdienzMode: 'selfhosted', probeBUrl: '', probeBSecret: 's'.repeat(32) })).not.toThrow();
    const result = await callProbeB(
      { url: 'https://example.com', timeout_ms: 50, up_status_codes: '2xx' },
      testConfig({ merdienzMode: 'selfhosted', probeBUrl: '', allowPrivateTargets: true }),
      async () => ({ status: 200 })
    );
    expect(result.via).toBe('in-process');
    expect(result.up).toBe(true);
  });

  it('does not use the in-process fallback in cloud mode', async () => {
    const result = await callProbeB(
      { url: 'https://example.com', timeout_ms: 1000, up_status_codes: '2xx' },
      testConfig({ merdienzMode: 'cloud', probeBUrl: '' })
    );
    expect(result.unavailable).toBe(true);
    expect(result.via).toBe('none');
  });

  it('defaults new cloud users to no plan, and everyone else to selfhosted', () => {
    expect(defaultUserTier('cloud')).toBe('no_plan');
    expect(defaultUserTier('selfhosted')).toBe('selfhosted');
    expect(defaultUserTier('dev')).toBe('selfhosted');
    expect(defaultUserTier('test')).toBe('selfhosted');
  });

  it('refuses a plain http probe URL and a missing pin in cloud mode', () => {
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: 'http://probe.example/internal/probe',
        probeBSecret: 's'.repeat(32),
        probeBSpkiSha256: VALID_PIN,
      })
    ).toThrow(/https/);
    expect(() =>
      assertProbeConfig({
        merdienzMode: 'cloud',
        probeBUrl: HTTPS_URL,
        probeBSecret: 's'.repeat(32),
        probeBSpkiSha256: '',
      })
    ).toThrow(/SPKI/);
  });
});
