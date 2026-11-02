import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonicalJson, pyFloat, coinbaseJwt, robinhoodHeaders, ed25519FromBase64, makeTicket, checkTicket, verifySnaptradeSignature } from '../lib/keys.js';

const hasPython = (() => { try { execFileSync('python3', ['-c', 'print(1)']); return true; } catch { return false; } })();

test('canonical JSON equals Python json.dumps(sort_keys, compact)', { skip: !hasPython && 'python3 not installed' }, () => {
  for (const s of ['{"b": 1.0, "a": [1, 2.50, -3e5, true, null], "z": {"y": "héllo ✓ 😀", "x": "a\\nb\\t\\"q\\" /"}, "n": 12345678901234567890, "e": {}}',
    '{"ctrl":"\\u0001\\u001f\\u007f","sep":"\\u2028","f":1e-7,"g":1e16}']) {
    const py = execFileSync('python3', ['-c', 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, separators=(",",":")), end="")'], { input: s }).toString();
    assert.equal(canonicalJson(s), py);
  }
});

test('Python float repr', () => {
  assert.deepEqual([1, 2.5, -300000, 1e16, 1.5e-5, 0.0001, 0.1, 1e-7].map(pyFloat), ['1.0', '2.5', '-300000.0', '1e+16', '1.5e-05', '0.0001', '0.1', '1e-07']);
});

test('Coinbase ES256 JWT verifies; REST has uri, WebSocket does not', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' }).replace(/\n/g, '\\n'); // as pasted in env vars
  const jwt = coinbaseJwt({ keyName: 'organizations/o/apiKeys/k', secret: pem, uri: 'GET api.coinbase.com/api/v3/brokerage/accounts' });
  const [h, p, s] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  const head = JSON.parse(Buffer.from(h, 'base64url')), claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual([head.alg, head.kid, claims.iss, claims.sub, claims.exp - claims.nbf, claims.uri], ['ES256', 'organizations/o/apiKeys/k', 'cdp', 'organizations/o/apiKeys/k', 120, 'GET api.coinbase.com/api/v3/brokerage/accounts']);
  const ws = JSON.parse(Buffer.from(coinbaseJwt({ keyName: 'k', secret: pem }).split('.')[1], 'base64url'));
  assert.equal(ws.uri, undefined);
});

test('Robinhood Ed25519 signature over api_key + timestamp + path + method + body', () => {
  const kp = generateKeyPairSync('ed25519');
  const seed = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  const path = '/api/v1/crypto/trading/orders/?updated_at_start=2026-11-01T00%3A00%3A00.000Z';
  const h = robinhoodHeaders({ apiKey: 'rh-key', privateKey: ed25519FromBase64(seed), method: 'GET', path, now: 1793600000000 });
  assert.equal(h['x-timestamp'], '1793600000');
  assert.ok(verify(null, Buffer.from(`rh-key1793600000${path}GET`), kp.publicKey, Buffer.from(h['x-signature'], 'base64')));
  assert.throws(() => ed25519FromBase64(Buffer.alloc(10).toString('base64')));
});

test('SSE tickets expire and are bound to the secret; webhook signature rejects garbage', () => {
  const t = makeTicket('secret-one-123', 60);
  assert.ok(checkTicket('secret-one-123', t));
  assert.ok(!checkTicket('secret-two-123', t));
  assert.ok(!checkTicket('secret-one-123', t, Date.now() + 61_000));
  assert.ok(!verifySnaptradeSignature('{"a":1}', 'AAAA', 'k'));
  assert.ok(!verifySnaptradeSignature('{"a":1}', '', 'k'));
});
