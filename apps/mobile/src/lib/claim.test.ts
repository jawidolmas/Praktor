import { describe, expect, it } from 'vitest';

import { claimErrorMessage, parseClaimCode } from './claim';

const CODE = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);

describe('parseClaimCode', () => {
  it('accepts exactly what `exec-agent cloud connect` shows', () => {
    expect(parseClaimCode(`praktor-claim:v1:${CODE}`)).toBe(CODE);
    expect(parseClaimCode(`  praktor-claim:v1:${CODE}\n`)).toBe(CODE);
  });

  it('refuses links, so a URL sent by someone else can never claim a computer', () => {
    expect(parseClaimCode(`praktor://claim?code=${CODE}`)).toBeUndefined();
    expect(parseClaimCode(`https://evil.example/praktor-claim:v1:${CODE}`)).toBeUndefined();
  });

  it('refuses anything malformed', () => {
    for (const bad of [
      CODE,
      `praktor-claim:v2:${CODE}`,
      `praktor-claim:v1:${CODE.toUpperCase()}`,
      `praktor-claim:v1:${CODE.slice(1)}`,
      `praktor-claim:v1:${CODE}0`,
      `praktor-claim:v1:${CODE.slice(1)}g`,
      '',
    ]) {
      expect(parseClaimCode(bad)).toBeUndefined();
    }
  });
});

describe('claimErrorMessage', () => {
  it('turns relay errors into something a person can act on', () => {
    expect(claimErrorMessage('invalid or expired code')).toMatch(/expired/);
    expect(claimErrorMessage('fetch failed')).toMatch(/connection/);
  });
});
