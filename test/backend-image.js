// Execute the real main-process lifecycle with isolated Electron/Docker boundaries.
// No production test switch, real keyring, container mutation or model is used.
// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ROOT = path.join(__dirname, '..')
const SOURCES = process.env.MILPA_TEST_SOURCE_ROOT || ROOT
const source = fs.readFileSync(process.env.MILPA_TEST_MAIN || path.join(SOURCES, 'main.js'), 'utf8')
const CONTAINER = 'a'.repeat(64)
const STARTED = 'b'.repeat(64)
const OLD_ID = 'sha256:' + '1'.repeat(64)
const NEW_ID = 'sha256:' + '2'.repeat(64)

function house (options = {}) {
  const calls = []; const handlers = new Map(); let choices = 0; let signers = 0
  const config = { keep: true, present: true, name: 'milpa-desktop-backend', ref: 'example/kept:old', imageId: OLD_ID, ...options }
  function docker (cmd, args) {
    calls.push([cmd, ...args])
    assert.equal(cmd, 'docker')
    if (args[0] === 'ps') {
      if (config.psError) throw new Error('Docker lookup failed')
      const pattern = args[args.indexOf('--filter') + 1].slice(5)
      const rows = config.containers || [{ id: CONTAINER, name: config.name }]
      return config.present ? rows.filter(row => new RegExp(pattern).test('/' + row.name) || new RegExp(pattern).test(row.name)).map(row => args.includes('{{.Names}}') ? row.name : row.id).join('\n') : ''
    }
    if (args[0] === 'inspect') {
      if (args.some(arg => arg.includes('{{json .HostConfig.NetworkMode}}'))) {
        if (config.networkError) throw new Error('Network inspection unavailable')
        const mode = config.platform === 'darwin' ? 'default' : 'host'
        const bindings = config.bindings || { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '8899' }, { HostIp: '::1', HostPort: '8899' }] }
        return JSON.stringify([args.at(-1), '/' + config.name, true, config.mode || mode, bindings, 100, '2026-11-22T00:00:00Z', ''])
      }
      if (config.inspectError) throw new Error('Container vanished')
      if (args.includes('{{.Config.Image}}')) return config.ref
      assert.ok([CONTAINER, STARTED].includes(args.at(-1)), 'Inspect must bind an exact container ID')
      const data = [config.ref, config.imageId]
      if (args.some(arg => arg.includes('{{json .Name}}'))) data.push('/' + (config.observedName || config.name))
      return config.raw === undefined ? JSON.stringify(data) : config.raw
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (args.includes('{{.Id}}')) return NEW_ID
      if (config.serverError) throw new Error('Image unavailable')
      // The requested tag now points at a different image; the retained ID has not changed.
      return JSON.stringify([args.at(-1) === OLD_ID || config.plain ? 'milpa-dev' : 'milpa-frankenphp'])
    }
    if (args[0] === 'run' && args.includes('adapt')) return JSON.stringify({ admin: { disabled: true }, apps: { http: { servers: { srv0: { automatic_https: { disable: true }, listen: [config.oldFranken ? ':8899' : '127.0.0.1:8899'] } } } } })
    if (args[0] === 'run' && args.includes('--rm')) return '{}'
    if (args[0] === 'run' && args.includes('-d')) return STARTED
    if (args[0] === 'rm') return ''
    if (args[0] === 'exec') {
      if (args.includes(require('../backend-network.js').LISTENERS)) return JSON.stringify(config.listeners || [['tcp', '0100007F', 8899, true]])
      return 'no'
    }
    throw new Error('Unexpected Docker call: ' + args.join(' '))
  }
  const fakeFs = { mkdirSync () {}, writeFileSync () {} }
  const context = vm.createContext({
    console, URL, AbortSignal, __dirname: ROOT,
    process: { env: { MILPA_IMAGE: 'example/requested:new', MILPA_BACKEND: config.name, MILPA_KEEP_BACKEND: config.keep ? '1' : '0' }, platform: config.platform || 'linux' },
    fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
    setTimeout: (fn) => { fn(); return 1 }, clearTimeout () {}, Buffer,
    require (name) {
      if (name === 'electron') return {
        app: { getPath: () => '/isolated-test', whenReady: () => ({ then () {} }), on () {}, commandLine: { appendSwitch () {} } },
        ipcMain: { handle: (n, fn) => handlers.set(n, fn) }
      }
      if (name === 'node:child_process') return { execFileSync: docker, execFile: () => { throw new Error('Unexpected asynchronous subprocess') } }
      if (name === 'node:fs') return fakeFs
      if (name === 'node:os') return { homedir: () => '/isolated-test' }
      if (name === './choose-image.js') return { IMAGE_PREFERRED: 'example/preferred:new', chooseImage: () => { choices++; return 'example/requested:new' } }
      if (name === './host-signer.js') return { serve: () => {
        signers++
        if (config.signerError) throw new Error('Signer unavailable')
        return { once: (event, fn) => { if (event === 'listening') fn() }, close () {} }
      } }
      if (name === './host-approve.js') return { makeApprover: () => () => {} }
      if (name === './sign-wiring.js') return { hostSocketPath: () => '/isolated-test/socket', containerSignArgs: () => [], provisionPublicKeyring: () => ({ secret: 0 }) }
      if (name === './security-key/desk.js') return { attach () {} }
      return require(name.startsWith('./') ? path.join(ROOT, name) : name)
    }
  })
  vm.runInContext(source, context, { filename: 'main.js' })
  const own = { senderFrame: { url: 'file:///desktop/renderer/boot.html' } }
  return {
    stop: () => vm.runInContext('stopBackend()', context),
    config, calls, choices: () => choices, signers: () => signers,
    start: async () => { await vm.runInContext('startBackend()', context); vm.runInContext("BOOT.phase = 'up'", context) },
    state: async () => ({ status: await handlers.get('milpa:status')(own), boot: await handlers.get('milpa:boot')(own) })
  }
}

function kept (h) {
  assert.equal(h.choices(), 0)
  assert.equal(h.calls.filter(c => c[1] === 'rm' || c[1] === 'run').length, 0, 'Retained backend must not be recreated')
}

test('before launch, configured image is not presented as an observation', async () => {
  const { status } = await house().state()
  assert.equal(status.image, null)
  assert.equal(status.imageId, null)
})
test('reuse reports exact container reference and immutable image ID through both IPC surfaces', async () => {
  const h = house(); await h.start(); const { status, boot } = await h.state()
  for (const s of [status, boot]) {
    assert.equal(s.image, 'example/kept:old'); assert.equal(s.imageId, OLD_ID); assert.equal(s.server, 'php-s')
  }
  kept(h)
})
test('a retagged reference does not change the retained image ID or its server classification', async () => {
  const h = house({ ref: 'example/requested:new' }); await h.start()
  const { status } = await h.state()
  assert.equal(status.image, 'example/requested:new'); assert.equal(status.imageId, OLD_ID); assert.equal(status.server, 'php-s'); kept(h)
})
test('a dotted backend name selects only its literal container beside a regex decoy', async () => {
  const h = house({ name: 'milpa.test', containers: [{ id: STARTED, name: 'milpaXtest' }, { id: CONTAINER, name: 'milpa.test' }] })
  await h.start(); assert.equal(h.calls.find(c => c[1] === 'inspect').at(-1), CONTAINER); kept(h)
})
test('a regex decoy alone is not an existing backend with the requested literal name', async () => {
  const h = house({ name: 'milpa.test', containers: [{ id: CONTAINER, name: 'milpaXtest' }] })
  await h.start(); assert.equal(h.choices(), 1)
  assert.equal(h.calls.find(c => c[1] === 'inspect').at(-1), STARTED)
})
test('a container renamed between lookup and inspect is not attributed to the requested backend', async () => {
  const h = house({ observedName: 'someone-else' }); await h.start()
  const { status } = await h.state(); assert.equal(status.image, null); assert.equal(status.imageId, null); kept(h)
})
for (const options of [{ inspectError: true }, { raw: 'broken' }, { raw: '{}' }, { raw: '["", "sha256:no"]' }, { imageId: null }]) {
  test('unreadable or incomplete observation stays unknown: ' + JSON.stringify(options), async () => {
    const h = house(options); await h.start()
    for (const s of Object.values(await h.state())) {
      assert.equal(s.image, null); assert.equal(s.imageId, null); assert.equal(s.server, 'unknown')
    }
    kept(h)
  })
}
test('failure after a previous observation cannot retain its old identity', async () => {
  const h = house(); await h.start(); h.config.inspectError = true; await h.start()
  const { status } = await h.state(); assert.equal(status.image, null); assert.equal(status.imageId, null); kept(h)
})
for (const options of [{ psError: true }, { signerError: true }]) {
  test('reuse preparation failure never falls through to removing the backend: ' + JSON.stringify(options), async () => {
    const h = house(options); await assert.rejects(h.start()); kept(h)
  })
}
test('failed image inspection preserves known identity but marks server unknown', async () => {
  const h = house({ serverError: true }); await h.start(); const { status } = await h.state()
  assert.equal(status.imageId, OLD_ID); assert.equal(status.server, 'unknown'); kept(h)
})
for (const keep of [false, true]) {
  test('fresh start observes the created container, including when no retained backend exists: ' + keep, async () => {
    const h = house({ keep, present: false, ref: 'example/actually-started:current', imageId: NEW_ID }); await h.start()
    assert.equal(h.choices(), 1)
    assert.equal(h.calls.filter(c => c[1] === 'run' && c.includes('-d')).length, 1)
    const { status } = await h.state(); assert.equal(status.image, 'example/actually-started:current'); assert.equal(status.imageId, NEW_ID)
    assert.equal(h.calls.find(c => c[1] === 'inspect').at(-1), STARTED)
  })
}

// The actual renderer and translation catalog, with only DOM primitives replaced.
for (const locale of ['en', 'es']) {
  test('boot renderer shows observed identity and explicit unknown in ' + locale, async () => {
    const elements = new Map(); const listeners = new Map(); let next
    const element = (s) => {
      if (!elements.has(s)) elements.set(s, { value: '', dataset: {}, textContent: '', title: '', classList: { toggle () {} }, setAttribute () {}, addEventListener () {} })
      return elements.get(s)
    }
    const state = { phase: 'up', container: 'kept', image: 'observed:old', imageId: OLD_ID, server: 'php-s', commands: { run: '', panel: '' } }
    const window = { milpa: { boot: async () => state }, addEventListener: (n, fn) => listeners.set(n, fn), dispatchEvent: (e) => listeners.get(e.type)?.() }
    const context = vm.createContext({ window, document: { querySelector: element, querySelectorAll: () => [], documentElement: {}, addEventListener () {} }, navigator: { language: locale }, localStorage: { getItem: () => locale, setItem () {} }, CustomEvent: class { constructor (type) { this.type = type } }, setTimeout: (fn) => { next = fn }, URL })
    vm.runInContext(fs.readFileSync(path.join(SOURCES, 'renderer/i18n.js'), 'utf8'), context)
    vm.runInContext(fs.readFileSync(path.join(SOURCES, 'renderer/boot.js'), 'utf8'), context)
    await new Promise(resolve => setImmediate(resolve))
    assert.match(element('#boot-container').textContent, /observed:old/)
    assert.ok(element('#boot-container').textContent.includes(OLD_ID.slice(0, 19)))
    assert.equal(element('#boot-container').title, OLD_ID)
    Object.assign(state, { image: null, imageId: null, server: 'unknown' }); await next()
    assert.match(element('#boot-container').textContent, locale === 'en' ? /unknown/ : /desconocida/)
    assert.doesNotMatch(element('#boot-container').textContent, /observed:old|null|undefined/)
    assert.equal(element('#boot-container').title, '')
    Object.assign(state, { phase: 'failed', errorKey: 'backend.bindUnverified', error: 'untranslated' }); await next()
    assert.match(element('#boot-error-text').textContent, locale === 'en' ? /Desktop did not attach/ : /Desktop no se conectó/)
    assert.doesNotMatch(element('#boot-error-text').textContent, /backend.bindUnverified|untranslated/)
  })
}

for (const platform of ['linux', 'darwin']) {
  test('local launch arguments preserve outbound model configuration on ' + platform, async () => {
    const h = house({ keep: false, present: false, platform }); await h.start()
    const run = h.calls.find(c => c[1] === 'run' && c.includes('-d'))
    assert.ok(run.includes('MILPA_AGENT_BASE_URL=http://model.example:11438'))
    assert.ok(run.includes(NEW_ID), 'Launch uses the immutable image checked during preflight')
    if (platform === 'linux') { assert.ok(run.includes('host')); assert.ok(run.includes('MILPA_HTTP_BIND_CONFIG=bind 127.0.0.1')) }
    else { assert.ok(run.includes('127.0.0.1:8899:8899')); assert.ok(run.includes('[::1]:8899:8899')); assert.ok(!run.includes('MILPA_HTTP_BIND_CONFIG=bind 127.0.0.1')) }
  })
}
for (const options of [
  { networkError: true }, { mode: 'container:other' },
  { listeners: [['tcp', '00000000', 8899, true]] },
  { listeners: [['tcp', '0100007F', 8899, true], ['tcp6', '00000000000000000000000000000000', 8899, true]] },
  { listeners: [['tcp', '0100007F', 8899, false]] },
  { platform: 'darwin', bindings: { '8899/tcp': [{ HostIp: '0.0.0.0', HostPort: '8899' }] } },
  { platform: 'darwin', bindings: { '8899/tcp': [{ HostIp: '127.0.0.1', HostPort: '8899' }, { HostIp: '::', HostPort: '8899' }] } }
]) test('unverified retained backend stays running without signer: ' + JSON.stringify(options), async () => {
  const h = house(options); await assert.rejects(h.start(), { code: 'backend.bindUnverified' }); kept(h); assert.equal(h.signers(), 0)
})
test('old FrankenPHP image is rejected before removing a container or creating a signer', async () => {
  const h = house({ keep: false, oldFranken: true })
  await assert.rejects(h.start(), { code: 'backend.imageBindUnsupported' })
  assert.ok(!h.calls.some(c => c[1] === 'rm' || c.includes('-d')))
  assert.equal(h.signers(), 0)
  h.stop(); assert.ok(!h.calls.some(c => c[1] === 'rm'))
})

for (const platform of ['linux', 'darwin']) test('plain PHP listens at the correct side of the network boundary on ' + platform, async () => {
  const h = house({ keep: false, present: false, plain: true, platform }); await h.start()
  const run = h.calls.find(c => c[1] === 'run' && c.includes('-d'))
  assert.equal(run[run.indexOf('-S') + 1], platform === 'linux' ? '127.0.0.1:8899' : '0.0.0.0:8899')
})

test('quit removes only the immutable container this process started', async () => {
  const h = house({ keep: false, present: false }); await h.start(); h.stop()
  assert.deepEqual(h.calls.filter(c => c[1] === 'rm').at(-1).slice(1), ['rm', '-f', STARTED])
})
