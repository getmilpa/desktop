// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchNetwork, localListeners, requireLocalBackend, requireLocalFrankenPHP } = require('../backend-network')
const cid = 'a'.repeat(64)
const row = ['tcp', '0100007F', 8899, true]
const host = [cid, '/test', true, 'host', {}, 123, '2026-11-22T00:00:00Z', '']
function check (data, rows = [row], after = data) {
  let reads = 0
  return () => requireLocalBackend((cmd, args) => JSON.stringify(args[0] === 'inspect' ? (++reads === 1 ? data : after) : rows), cid, 'test', '8899')
}
test('invalid ports are rejected before launch', () => {
  for (const port of ['0', '-1', '65536', '8899:80', ' 80', '080', '', 'abc']) assert.throws(() => launchNetwork('linux', port), { code: 'backend.invalidPort' })
})
test('Linux local listener is IPv4 only; non-Linux publishes both loopbacks', () => {
  assert.equal(launchNetwork('linux', '8899').listen, '127.0.0.1:8899')
  assert.deepEqual(launchNetwork('linux', '8899').args, ['--network', 'host', '--security-opt', 'no-new-privileges=true', '-e', 'MILPA_HTTP_BIND_CONFIG=bind 127.0.0.1'])
  assert.deepEqual(launchNetwork('darwin', '8899').args, ['-p', '127.0.0.1:8899:8899', '-p', '[::1]:8899:8899'])
})
test('no listener, foreign ownership, malformed rows and wildcard siblings cannot pass', () => {
  assert.ok(localListeners([row], '8899'))
  assert.ok(localListeners([['tcp6', '00000000000000000000000001000000', 8899, true]], '8899'))
  for (const rows of [[], [[...row.slice(0, 3), false]], [row, ['tcp6', '00000000000000000000000000000000', 8899, false]], [row, null], [row, ['udp', '0100007F', 8899, true]]]) assert.equal(localListeners(rows, '8899'), false)
})
test('retained instance restart, rename, stop or shared PID namespace is refused', () => {
  assert.doesNotThrow(check(host))
  for (const [index, value] of [[0, 'b'.repeat(64)], [1, '/other'], [2, false], [5, 234], [6, '2026-11-23T00:00:00Z']]) {
    const after = [...host]; after[index] = value
    assert.throws(check(host, [row], after), { code: 'backend.bindUnverified' })
  }
  for (const mode of ['host', 'container:other']) { const data = [...host]; data[7] = mode; assert.throws(check(data), { code: 'backend.bindUnverified' }) }
})
test('every published family and service must use loopback; requested host port must match', () => {
  const data = [...host]; data[3] = 'default'
  for (const ip of ['127.0.0.1', '::1']) { data[4] = { '8899/tcp': [{ HostIp: ip, HostPort: '8899' }] }; assert.doesNotThrow(check(data)) }
  for (const ip of ['', '0.0.0.0', '::', '192.0.2.1', 'fe80::1', 'localhost']) {
    data[4] = { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '8899' }, { HostIp: ip, HostPort: '8899' }] }
    assert.throws(check(data), { code: 'backend.bindUnverified' })
  }
  data[4] = { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] }; assert.throws(check(data))
  data[4] = { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '8899' }], '2019/tcp': [{ HostIp: '::', HostPort: '2019' }] }; assert.throws(check(data))
})
test('preflight rejects ignored bind, extra server and enabled admin or automatic HTTPS', () => {
  const good = { admin: { disabled: true }, apps: { http: { servers: { srv0: { listen: ['127.0.0.1:8899'], automatic_https: { disable: true } } } } } }
  const run = config => () => requireLocalFrankenPHP(() => JSON.stringify(config), 'sha256:' + cid, '8899')
  assert.doesNotThrow(run(good))
  for (const mutate of [c => { c.admin.disabled = false }, c => { c.apps.http.servers.srv0.listen.push('[::]:8899') }, c => { c.apps.http.servers.srv0.automatic_https.disable = false }, c => { c.apps.http.servers.extra = {} }]) {
    const c = structuredClone(good); mutate(c); assert.throws(run(c), { code: 'backend.imageBindUnsupported' })
  }
})
