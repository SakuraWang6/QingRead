import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, statSync, fstatSync, appendFileSync, unlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const ts = require('typescript')
const util = {
  TextEncoder: class { encodeInto(value) { return new TextEncoder().encode(value) } },
  TextDecoder: { create: () => ({ decodeToString: value => new TextDecoder('utf-8', { fatal: true }).decode(value) }) },
  generateRandomUUID: () => crypto.randomUUID(),
}
function load(name, modules = {}) {
  const source = readFileSync(new URL(`../entry/src/main/ets/web/${name}.ets`, import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  vm.runInNewContext(javascript, { exports, setTimeout, clearTimeout,
    require: name => {
      if (name === './NativePolicy') return load('NativePolicy')
      if (name === '@kit.ArkTS') return { util }
      if (name in modules) return modules[name]
      throw new Error(`Unexpected native dependency ${name}`)
    },
  })
  return exports
}

test('system credential replacement failures cannot restore the previous account', async () => {
  const rows = new Map()
  let failAdd = false
  const asset = {
    Tag: { ALIAS: 1, SECRET: 2, RETURN_TYPE: 3, ACCESSIBILITY: 4, IS_PERSISTENT: 5 },
    ReturnType: { ALL: 0 }, Accessibility: { DEVICE_UNLOCKED: 2 },
    async query(query) { const key = String(query.get(1)); if (!rows.has(key)) throw { code: 24000002 }; return [rows.get(key)] },
    async remove(query) { rows.delete(String(query.get(1))) },
    async add(attributes) {
      // Even IS_PERSISTENT=false requires a privileged permission; ordinary apps omit the tag.
      if (attributes.has(5)) throw { code: 201 }
      if (failAdd) throw { code: 24000009 }
      rows.set(String(attributes.get(1)), attributes)
    },
  }
  const { NativeCredentials } = load('NativeCredentials', { '@kit.AssetStoreKit': { asset } })
  const credentials = new NativeCredentials()
  assert.equal(await credentials.available(), true)
  await credentials.save('cloud', 'synthetic-account-a')
  assert.equal(await credentials.load('cloud'), 'synthetic-account-a')
  failAdd = true
  await assert.rejects(credentials.save('cloud', 'synthetic-account-b'))
  assert.equal(await credentials.load('cloud'), null)
  failAdd = false
  await assert.rejects(credentials.save('cloud', '测'.repeat(342)), /系统安全存储限制/)
  await credentials.save('connection', 'synthetic-connection')
  await credentials.clear('connection')
  assert.equal(await credentials.load('connection'), null)
  assert.equal(rows.size, 0)
})

test('a document reload during either ASSET await cannot leave a stale saved login', async () => {
  for (const pauseAt of ['remove', 'add']) {
    const rows = new Map()
    let release, entered
    const paused = new Promise(resolve => { entered = resolve })
    const proceed = new Promise(resolve => { release = resolve })
    let firstPause = true
    const asset = {
      Tag: { ALIAS: 1, SECRET: 2, RETURN_TYPE: 3, ACCESSIBILITY: 4, IS_PERSISTENT: 5 },
      ReturnType: { ALL: 0 }, Accessibility: { DEVICE_UNLOCKED: 2 },
      async query(query) { const key = String(query.get(1)); if (!rows.has(key)) throw { code: 24000002 }; return [rows.get(key)] },
      async remove(query) {
        if (pauseAt === 'remove' && firstPause) { firstPause = false; entered(); await proceed }
        rows.delete(String(query.get(1)))
      },
      async add(attributes) {
        if (pauseAt === 'add' && firstPause) { firstPause = false; entered(); await proceed }
        rows.set(String(attributes.get(1)), attributes)
      },
    }
    const { NativeCredentials } = load('NativeCredentials', { '@kit.AssetStoreKit': { asset } })
    const credentials = new NativeCredentials()
    let activeDocument = true
    const saving = credentials.save('cloud', 'synthetic-stale-account', () => activeDocument)
    await paused
    activeDocument = false
    release()
    await assert.rejects(saving, /页面已关闭/)
    assert.equal(await credentials.load('cloud'), null, pauseAt)
    assert.equal(rows.size, 0, pauseAt)
  }
})

function exportHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'qingread-native-export-'))
  let selected = []
  let failCopy = false
  let pickerCalls = 0
  const fileIo = {
    OpenMode: { CREATE: 64, READ_WRITE: 2, WRITE_ONLY: 1, APPEND: 1024 },
    openSync(path, mode) { return { fd: openSync(path, mode & 64 ? 'w+' : mode & 1024 ? 'a' : 'r+') } },
    closeSync(file) { closeSync(file.fd) },
    writeSync(fd, buffer) { appendFileSync(fd, Buffer.from(buffer)); return buffer.byteLength },
    unlinkSync, statSync: value => typeof value === 'number' ? fstatSync(value) : statSync(value),
    readTextSync: path => readFileSync(path, 'utf8'),
    async copyFile(path, target) {
      if (failCopy) { writeFileSync(target, 'partial'); throw new Error('synthetic write failure') }
      writeFileSync(target, readFileSync(path))
    },
  }
  const picker = { DocumentSaveOptions: class {}, DocumentViewPicker: class {
    async save() { pickerCalls++; return selected }
  } }
  const { NativeExport } = load('NativeExport', { '@kit.CoreFileKit': { fileIo, picker } })
  const exporter = new NativeExport({ cacheDir: directory })
  const payload = JSON.stringify({ format: 'qingread-backup', version: 1, shelf: [{ title: '自制测试文本' }] })
  const size = Buffer.byteLength(payload)
  return { directory, exporter, payload, size,
    select(path) { selected = path ? [path] : [] },
    failCopy() { failCopy = true },
    pickerCalls: () => pickerCalls,
    cleanup() { exporter.dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}

test('backup export requires complete JSON and a user-picked new file; stale documents do not write', async () => {
  const fixture = exportHarness()
  try {
    let id = fixture.exporter.begin('清读备份-test.json', fixture.size)
    fixture.exporter.append(id, fixture.payload.slice(0, 5))
    await assert.rejects(fixture.exporter.commit(id, () => true), /完整传输/)
    assert.equal(fixture.pickerCalls(), 0)
    id = fixture.exporter.begin('清读备份-test.json', 2)
    fixture.exporter.append(id, '{}')
    await assert.rejects(fixture.exporter.commit(id, () => true), /格式/)
    assert.equal(fixture.pickerCalls(), 0)
    id = fixture.exporter.begin('清读备份-test.json', fixture.size)
    fixture.exporter.append(id, fixture.payload)
    assert.equal(await fixture.exporter.commit(id, () => false), false)
    assert.equal(fixture.pickerCalls(), 0)
    id = fixture.exporter.begin('清读备份-test.json', fixture.size)
    fixture.exporter.append(id, fixture.payload)
    const selected = join(fixture.directory, 'selected.json')
    writeFileSync(selected, '')
    fixture.select(selected)
    assert.equal(await fixture.exporter.commit(id, () => true), true)
    assert.equal(readFileSync(selected, 'utf8'), fixture.payload)
  } finally { fixture.cleanup() }
})

test('partial export failure removes only the chosen empty destination and keeps existing data', async () => {
  const fixture = exportHarness()
  try {
    const existing = join(fixture.directory, 'existing.json')
    writeFileSync(existing, 'previous user data')
    fixture.select(existing)
    let id = fixture.exporter.begin('清读备份-test.json', fixture.size)
    fixture.exporter.append(id, fixture.payload)
    await assert.rejects(fixture.exporter.commit(id, () => true), /新的备份文件名/)
    assert.equal(readFileSync(existing, 'utf8'), 'previous user data')
    const selected = join(fixture.directory, 'new.json')
    writeFileSync(selected, '')
    fixture.select(selected); fixture.failCopy()
    id = fixture.exporter.begin('清读备份-test.json', fixture.size)
    fixture.exporter.append(id, fixture.payload)
    await assert.rejects(fixture.exporter.commit(id, () => true))
    assert.equal(existsSync(selected), false)
  } finally { fixture.cleanup() }
})

test('native speech reports playback completion once and speed changes never stop the current sentence', async () => {
  let listener
  const calls = []
  const engine = {
    setListener(value) { listener = value },
    async listVoices() { return [
      { language: 'zh-CN', person: 21, status: 'GA' },
      { language: 'en-US', person: 8, status: 'INSTALLED' },
    ] },
    speak(text, params) { calls.push({ text, params }) },
    stop() { calls.push({ stop: true }) }, shutdown() {},
  }
  const events = []
  const { NativeSpeech } = load('NativeSpeech', {
    '@kit.CoreSpeechKit': { textToSpeech: { createEngine: async () => engine } },
    '@kit.BasicServicesKit': { deviceInfo: { sdkApiVersion: 26 } },
  })
  const speech = new NativeSpeech(event => events.push(event))
  assert.equal(await speech.initialize(), true)
  assert.equal(speech.list().some(voice => voice.id === 'harmony:zh-CN:21'), false)
  assert.equal(speech.list().some(voice => voice.id === 'harmony:en-US:8'), true)
  await speech.speak('reader-1', '第一段测试。', 1, '')
  const current = calls.find(call => call.text)
  const stops = calls.filter(call => call.stop).length
  speech.rate(1.5)
  assert.equal(calls.filter(call => call.stop).length, stops)
  listener.onStart(current.params.requestId, {})
  listener.onComplete(current.params.requestId, { type: 0 })
  assert.equal(events.some(event => event.type === 'end'), false)
  listener.onComplete(current.params.requestId, { type: 1 })
  listener.onComplete(current.params.requestId, { type: 1 })
  assert.equal(events.filter(event => event.type === 'end').length, 1)
  assert.equal(events.find(event => event.type === 'end').charIndex, 6)
  speech.dispose()
})
