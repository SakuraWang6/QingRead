import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const ts = require('typescript')
async function load(name) {
  const source = await readFile(new URL(`../entry/src/main/ets/web/${name}.ets`, import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}
const { NativePolicy } = await load('NativePolicy')
const { NativeBootstrap } = await load('NativeBootstrap')
const request = (method, params = {}, id = 'test-1') => JSON.stringify({ id, method, params })

test('native requests accept only the finite operation and parameter whitelist', () => {
  for (const [method, params] of [
    ['battery.get', {}], ['credentials.load', { slot: 'cloud' }],
    ['credentials.save', { slot: 'connection', value: 'test' }],
    ['export.begin', { name: '清读备份-2026-10-23.json', size: 100 }],
    ['export.append', { exportID: 'test-export', content: '{}' }],
    ['speech.speak', { utteranceID: 'reader-1', text: '短句', rate: 1, voiceIdentifier: '' }],
  ]) assert.equal(NativePolicy.parse(request(method, params)).method, method)
  for (const raw of [request('shell.exec', { command: 'id' }), request('battery.get', { path: '/secret' }),
    request('credentials.load', { slot: 'cloud', url: 'https://example.com' }),
    request('speech.stop', {}, '__bad/id'), JSON.stringify({ id: 'ok', method: 'battery.get', params: {}, callback: 'eval' }),
    request('battery.get', []), 'null', '{}', 'x'.repeat(140001)]) {
    assert.throws(() => NativePolicy.parse(raw), raw.slice(0, 100))
  }
})

test('credential namespaces, filenames and speed cannot escape their narrow contracts', () => {
  assert.equal(NativePolicy.slot('cloud'), 'cloud')
  assert.equal(NativePolicy.slot('connection'), 'connection')
  for (const key of ['cloud/other', 'token', '__proto__', undefined]) assert.throws(() => NativePolicy.slot(key))
  assert.equal(NativePolicy.exportName('清读备份-2026-10-23.json'), '清读备份-2026-10-23.json')
  for (const name of ['../清读备份.json', '清读备份/other.json', '清读备份.exe', '清读备份\0.json', 'other.json']) {
    assert.throws(() => NativePolicy.exportName(name))
  }
  for (const rate of [0.5, 1, 2]) assert.equal(NativePolicy.rate(rate), rate)
  for (const rate of [0, 2.1, NaN, Infinity, '1', undefined]) assert.throws(() => NativePolicy.rate(rate))
})

function documentHarness({ frame = false, origin = 'https://localhost', pathname = '/', timerDelays } = {}) {
  const listeners = new Map()
  const events = []
  const window = {
    addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list) },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(x => x !== fn)) },
    dispatchEvent(event) { events.push(event) },
  }
  window.top = frame ? {} : window
  const context = vm.createContext({ window, location: { origin, pathname },
    setTimeout: (callback, delay) => { timerDelays?.push(delay); return setTimeout(callback, delay) }, clearTimeout,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } },
  })
  const metadata = { bridgeVersion: 2, version: '0.12.0', build: '2', capabilities: ['battery'] }
  vm.runInContext(NativeBootstrap.script(JSON.stringify(metadata), 'private-test-nonce'), context)
  return { window, events, emit: (type, event) => [...(listeners.get(type) ?? [])].forEach(fn => fn(event)) }
}

test('bootstrap never exposes a bridge to an iframe, external origin or asset document', () => {
  for (const options of [{ frame: true }, { origin: 'https://example.com' }, { pathname: '/assets/x.html' }]) {
    const { window } = documentHarness(options)
    assert.equal(window.QingReadNative, undefined)
    assert.equal(window.__QINGREAD_HARMONY__, undefined)
  }
  const { window } = documentHarness()
  assert.ok(Object.isFrozen(window.QingReadNative))
  assert.ok(Object.isFrozen(window.__QINGREAD_HARMONY__))
  assert.ok(Object.isFrozen(window.__QINGREAD_HARMONY__.capabilities))
  assert.equal(Object.getOwnPropertyDescriptor(window, 'QingReadNative').writable, false)
  assert.equal(Object.keys(window).some(key => /nonce|port/i.test(key)), false)
})

test('only the nonce-bound native message port settles requests; stale documents reject pending work', async () => {
  const harness = documentHarness()
  const sent = []
  const port = { postMessage: raw => sent.push(raw), start() {}, close() { this.closed = true } }
  harness.emit('message', { data: 'wrong-nonce', ports: [port], source: null })
  assert.equal(port.onmessage, undefined)
  harness.emit('message', { data: 'private-test-nonce', ports: [port], source: {}, origin: 'https://evil.example' })
  assert.equal(port.onmessage, undefined)
  harness.emit('message', { data: 'private-test-nonce', ports: [port], source: null })
  const promise = harness.window.QingReadNative.request(request('battery.get'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.length, 1)
  port.onmessage({ data: JSON.stringify({ id: 'another-request', ok: true, result: { level: 0 } }) })
  port.onmessage({ data: JSON.stringify({ id: 'test-1', ok: true, result: { level: 75 } }) })
  assert.equal(JSON.parse(await promise).result.level, 75)
  const pending = harness.window.QingReadNative.request(request('battery.get', {}, 'test-2'))
  await new Promise(resolve => setImmediate(resolve))
  harness.emit('pagehide', {})
  await assert.rejects(pending, /页面已关闭/)
  assert.equal(port.closed, true)
})

test('duplicate request identifiers cannot replace a pending native operation', async () => {
  const harness = documentHarness()
  const port = { postMessage() {}, start() {}, close() {} }
  harness.emit('message', { data: 'private-test-nonce', ports: [port], source: null })
  const first = harness.window.QingReadNative.request(request('battery.get'))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(harness.window.QingReadNative.request(request('battery.get')), /过于频繁/)
  harness.emit('pagehide', {})
  await assert.rejects(first, /页面已关闭/)
})

test('system notification permission grants users two minutes instead of an ordinary RPC deadline', async () => {
  const timerDelays = []
  const harness = documentHarness({ timerDelays })
  const port = { postMessage() {}, start() {}, close() {} }
  harness.emit('message', { data: 'private-test-nonce', ports: [port], source: null })
  const waiting = harness.window.QingReadNative.request(request('updates.requestPermission'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timerDelays.at(-1), 120000)
  port.onmessage({ data: JSON.stringify({ id: 'test-1', ok: true, result: { notifications: 'granted' } }) })
  assert.equal(JSON.parse(await waiting).result.notifications, 'granted')
})
