import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, statSync, writeSync, readSync, renameSync, unlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const ts = require('typescript')
const util = {
  TextEncoder: class { encodeInto(value) { return new TextEncoder().encode(value) } },
  Base64Helper: class { encodeToStringSync(value) { return Buffer.from(value).toString('base64') } },
  generateRandomUUID: () => randomUUID(),
}
function load(name, modules = {}) {
  const source = readFileSync(new URL(`../entry/src/main/ets/web/${name}.ets`, import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  vm.runInNewContext(javascript, { exports,
    require: name => {
      if (name === './NativeDownloadPolicy') return load('NativeDownloadPolicy')
      if (name === '@kit.ArkTS') return { util, url: { URL } }
      if (name in modules) return modules[name]
      throw new Error(`Unexpected native dependency ${name}`)
    },
  })
  return exports
}

const base = 'https://example.invalid/api'
const profile = 'qingread-cloud-' + base + '|00000000-0000-0000-0000-000000000001'
const configuration = { profile, apiBase: base, authToken: 'T'.repeat(43) }
const prepared = { profile, id: '00000000-0000-0000-0000-000000000002', bookID: 'book-1',
  sourceID: 'test-source', sourceURL: 'https://books.example.invalid/fiction/1',
  revision: '2026-10-23T00:00:00.000Z', bytes: 100 }

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'qingread-agent-test-'))
  const tasks = new Map()
  const creates = []
  let sequence = 0
  let delayCreate
  const agent = {
    Action: { DOWNLOAD: 0 }, Mode: { BACKGROUND: 0 },
    State: { COMPLETED: 64, PAUSED: 48, STOPPED: 49, FAILED: 65, REMOVED: 80 },
    async search() { return [...tasks.keys()] },
    async create(context, config) {
      if (delayCreate) await delayCreate
      creates.push(config)
      const tid = String(++sequence)
      const task = { tid, config, state: 0, processed: 0,
        on() {}, async start() { this.state = 32 }, async pause() { this.state = 48 },
      }
      tasks.set(tid, task)
      return task
    },
    async getTask(context, tid, token) { const task = tasks.get(tid); if (!task || token !== task.config.token) throw new Error('task unavailable'); return task },
    async touch(tid, token) {
      const task = tasks.get(tid)
      if (!task || token !== task.config.token) throw new Error('task unavailable')
      return { progress: { state: task.state, processed: task.processed, sizes: [-1] } }
    },
    async remove(tid) { tasks.delete(tid) },
  }
  const fileIo = {
    OpenMode: { CREATE: 64, READ_ONLY: 0, READ_WRITE: 2, WRITE_ONLY: 1, TRUNC: 512 },
    openSync(path, mode) { return { fd: openSync(path, mode & 64 ? 'w+' : mode === 0 ? 'r' : 'r+') } },
    closeSync(file) { closeSync(file.fd) },
    writeSync(fd, buffer) { return writeSync(fd, Buffer.from(buffer)) },
    readSync(fd, buffer, options) { return readSync(fd, Buffer.from(buffer), 0, options.length, options.offset) },
    statSync: value => typeof value === 'number' ? fstatSync(value) : statSync(value),
    readTextSync: path => readFileSync(path, 'utf8'), renameSync, unlinkSync,
  }
  const cryptoFramework = { createMd() {
    const digest = createHash('sha256')
    return { async update(value) { digest.update(value.data) }, async digest() { return { data: new Uint8Array(digest.digest()) } } }
  } }
  const { NativeDownloads } = load('NativeDownloads', {
    '@kit.BasicServicesKit': { request: { agent } },
    '@kit.CoreFileKit': { fileIo, hash: { async hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase() } } },
    '@kit.CryptoArchitectureKit': { cryptoFramework },
  })
  const downloader = new NativeDownloads({ filesDir: directory })
  return { directory, downloader, tasks, creates,
    restart() { return new NativeDownloads({ filesDir: directory }) },
    deferCreate(promise) { delayCreate = promise },
    complete(content = 'synthetic\n章节\n') {
      const task = [...tasks.values()].at(-1)
      writeFileSync(task.config.saveas, content)
      task.state = 64; task.processed = Buffer.byteLength(content)
      return task.config.saveas
    },
    cleanup() { rmSync(directory, { recursive: true, force: true }) },
  }
}

test('background transfer policy rejects credentials, local hosts, unexpected API paths and task injection', () => {
  const { NativeDownloadPolicy: policy } = load('NativeDownloadPolicy')
  assert.equal(policy.base(base), base)
  for (const value of ['http://example.invalid/api', 'https://localhost/api', 'https://user:pass@example.invalid/api',
    base + '?token=secret', 'https://example.invalid/arbitrary', 'https://example.invalid/api/../api']) {
    if (value.endsWith('/api/../api')) continue // URL canonicalizes it to the same fixed API origin.
    assert.throws(() => policy.base(value))
  }
  for (const value of ['../file', 'id?token=x', '', undefined]) assert.throws(() => policy.id(value))
  for (const value of ['Bearer token', 'T'.repeat(44), undefined]) assert.throws(() => policy.token(value))
})

test('completed OS transfers survive restart and expose only verified bytes before acknowledgement', async () => {
  const fixture = harness()
  try {
    await fixture.downloader.configure(configuration)
    await fixture.downloader.enqueue(prepared)
    const config = fixture.creates[0]
    assert.equal(config.url, base + '/offline/jobs/' + prepared.id + '/content')
    assert.equal(config.mode, 0); assert.equal(config.redirect, false)
    assert.equal(config.begins, undefined); assert.equal(config.ends, undefined)
    assert.deepEqual(Object.keys(config.headers), ['Authorization'])
    assert.ok(config.saveas.startsWith(fixture.directory + '/'))
    const path = fixture.complete()
    assert.equal((await fixture.downloader.list(profile))[0].status, 'completed')
    const restarted = fixture.restart()
    await restarted.configure(configuration)
    assert.equal(fixture.tasks.size, 1)
    const result = await restarted.read({ profile, id: prepared.id, revision: prepared.revision, offset: 0, limit: 49152 })
    assert.deepEqual(Buffer.from(result.base64, 'base64'), readFileSync(path))
    assert.equal(result.sha256, createHash('sha256').update(readFileSync(path)).digest('hex'))
    await assert.rejects(restarted.read({ profile: 'other-account', id: prepared.id, revision: prepared.revision, offset: 0, limit: 49152 }), /账号已切换/)
    await assert.rejects(restarted.acknowledge({ profile, id: prepared.id, revision: 'old' }), /尚未保存完成/)
    assert.equal(existsSync(path), true)
    await restarted.acknowledge({ profile, id: prepared.id, revision: prepared.revision })
    assert.equal(existsSync(path), false); assert.equal(fixture.tasks.size, 0)
  } finally { fixture.cleanup() }
})

test('resuming NDJSON always uses a fresh system task and file; source and revision changes are rejected', async () => {
  const fixture = harness()
  try {
    await fixture.downloader.configure(configuration)
    await fixture.downloader.enqueue(prepared)
    const previous = fixture.creates[0]
    writeFileSync(previous.saveas, 'incomplete-prefix')
    await fixture.downloader.action(profile, prepared.id, 'pause')
    await fixture.downloader.action(profile, prepared.id, 'resume')
    assert.notEqual(fixture.creates[1].saveas, previous.saveas)
    assert.notEqual(fixture.creates[1].token, previous.token)
    assert.equal(existsSync(previous.saveas), false)
    assert.equal(fixture.tasks.size, 1)
    await assert.rejects(fixture.downloader.enqueue({ ...prepared, sourceURL: 'https://other.invalid/book' }), /来源已变更/)
    await assert.rejects(fixture.downloader.enqueue({ ...prepared, revision: '2026-10-24T00:00:00.000Z' }), /来源已变更/)
  } finally { fixture.cleanup() }
})

test('account switch removes old transfers and late system task creation cannot revive them', async () => {
  const fixture = harness()
  try {
    await fixture.downloader.configure(configuration)
    let release
    fixture.deferCreate(new Promise(resolve => { release = resolve }))
    const enqueuing = fixture.downloader.enqueue(prepared)
    await fixture.downloader.configure({ profile: null })
    release()
    await assert.rejects(enqueuing, /账号已切换/)
    assert.equal(fixture.tasks.size, 0)
    await assert.rejects(fixture.downloader.list(profile), /账号已切换/)
  } finally { fixture.cleanup() }
})

test('queued configurations revoke immediately and only the newest account can become active', async () => {
  const fixture = harness()
  try {
    const nextProfile = 'qingread-cloud-' + base + '|00000000-0000-0000-0000-000000000003'
    const first = fixture.downloader.configure(configuration)
    const second = fixture.downloader.configure({ ...configuration, profile: nextProfile, authToken: 'N'.repeat(43) })
    await assert.rejects(first, /账号已切换/)
    await second
    await assert.rejects(fixture.downloader.list(profile), /账号已切换/)
    assert.equal((await fixture.downloader.list(nextProfile)).length, 0)
  } finally { fixture.cleanup() }
})

test('same-size staging corruption is detected before its bytes reach the Web reader', async () => {
  const fixture = harness()
  try {
    await fixture.downloader.configure(configuration)
    await fixture.downloader.enqueue(prepared)
    const path = fixture.complete('original-data')
    await fixture.downloader.list(profile)
    writeFileSync(path, 'replaced-data')
    await assert.rejects(fixture.downloader.read({ profile, id: prepared.id, revision: prepared.revision, offset: 0, limit: 49152 }), /校验失败/)
    assert.equal(existsSync(path), false)
  } finally { fixture.cleanup() }
})
