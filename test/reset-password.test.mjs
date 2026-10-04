import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/reset-password.mjs';
import { handle } from '../web/api/auth.mjs';
import { AUTH_VAR, verifyHash } from '../web/api/_lib/auth.mjs';
import { fakeGitHub } from './helpers/github.mjs';

const NOW = Date.parse('2026-10-04T00:00:00Z');
const PASSWORD = /^ {2}([A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3})$/m;
const token = { TRACKERS_GITHUB_TOKEN: 'ghp_x', TRACKERS_REPO: 'me/repo' };
const run = async (argv, { env = {}, gh = fakeGitHub() } = {}) => {
  const lines = [];
  const code = await main(argv, { env, fetchImpl: gh.fetchImpl, now: NOW, log: (l) => lines.push(l) });
  const out = lines.join('\n');
  return { code, out, password: PASSWORD.exec(out)?.[1], gh };
};

test('without --apply nothing is written; it prints the password and the entry to paste', async () => {
  const { code, out, password, gh } = await run(['usera']);
  assert.equal(code, 0);
  assert.ok(password, 'a password is shown');
  assert.equal(gh.store.calls.length, 0, 'no network at all');
  const entry = JSON.parse(/"usera": (\{.*\})/.exec(out)[1]);
  assert.equal(entry.temp, true);
  assert.equal(entry.at, '2026-10-04T00:00:00.000Z');
  assert.equal(await verifyHash(password, entry.hash), true);
  assert.ok(!out.replace(PASSWORD, '').includes(password), 'the password appears once');
});

test('--apply stores only a temp hash, keeps everyone else, and the printed password signs in', async () => {
  const userb = { hash: 'scrypt$keep$me', at: 'earlier' };
  const gh = fakeGitHub({ [AUTH_VAR]: JSON.stringify({ userb }) });
  const { code, out, password } = await run(['USERA', '--apply'], { env: token, gh });
  assert.equal(code, 0);
  assert.match(out, /me\/repo/);
  const stored = JSON.parse(gh.store.vars[AUTH_VAR]);
  assert.deepEqual(stored.userb, userb);
  assert.equal(stored.usera.temp, true);
  assert.ok(!gh.store.vars[AUTH_VAR].includes(password));
  assert.ok(gh.store.calls.every((c) => c.auth === 'Bearer ghp_x'));

  const env = { PASSWORD_USERA: 'usera-initial-pass-1', PASSWORD_USERB: 'userb-initial-pass-2', SESSION_SECRET: 's'.repeat(40), ...token };
  const res = await handle(new Request('https://app.example/api/auth', {
    method: 'POST', headers: { origin: 'https://app.example', host: 'app.example', 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  }), { env, now: NOW, delayMs: 0, fetchImpl: gh.fetchImpl });
  assert.deepEqual(await res.json(), { user: { name: 'usera', mustChange: true } });
});

test('bad input and failures: exit 1, nothing printed that works', async () => {
  for (const argv of [[], ['admin'], ['usera', 'userb'], ['usera', '--apply', '--force'], ['user1'], ['--apply']]) {
    const r = await run(argv, { env: token });
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.match(r.out, /usage/);
    assert.equal(r.password, undefined);
  }
  const noToken = await run(['usera', '--apply']);
  assert.equal(noToken.code, 1);
  assert.match(noToken.out, /TRACKERS_GITHUB_TOKEN/);
  assert.equal(noToken.password, undefined);
  const gh = fakeGitHub();
  gh.store.down = true;
  const down = await run(['usera', '--apply'], { env: token, gh });
  assert.equal(down.code, 1);
  assert.match(down.out, /Could not write/);
  assert.equal(down.password, undefined, 'a password that was not stored is never shown');
});
