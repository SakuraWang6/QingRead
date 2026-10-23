import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const ts = require('typescript')
const base = 'https://reading.example/api'
const profile = 'qingread-web-v1'
const book = n => ({ id: `source|https://source.example/book/${n}`, title: `Private title ${n}`,
  sourceID: 'source', sourceName: 'Synthetic source', url: `https://source.example/book/${n}` })
const chapters = (...ids) => ids.map(id => ({ id, title: `Chapter ${id}` }))
const watch = n => ({ book: book(n), baseline: { knownChapterCount: 1, lastKnownChapterID: 'c1', lastKnownChapterTitle: 'Chapter c1' } })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function harness() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'qingread-updates-'))
  const locks = new Map(), modules = new Map(), requests = [], notices = new Map(), scheduled = new Map(), permissions = []
  let allowed = false, remembered = null, credentialError = false, destroyError = false
  let response = async () => ({ responseCode: 200, result: JSON.stringify(chapters('c1', 'c2')) })
  let publishHook = async () => {}
  const sdk = { sdkApiVersion: 26 }
  const timers = new Set(), timerCallbacks = new Map()
  const fileIo = {
    OpenMode: { CREATE: 64, READ_WRITE: 2, WRITE_ONLY: 1 },
    openSync(path) {
      const fd = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w+')
      return { fd, path,
        tryLock() { if (locks.has(path) && locks.get(path) !== fd) throw new Error('locked'); locks.set(path, fd) },
        unlock() { if (locks.get(path) === fd) locks.delete(path) },
      }
    },
    closeSync(file) { if (locks.get(file.path) === file.fd) locks.delete(file.path); fs.closeSync(file.fd) },
    accessSync: fs.existsSync, statSync: fs.statSync,
    readTextSync: path => fs.readFileSync(path, 'utf8'),
    writeSync: (fd, data) => fs.writeSync(fd, Buffer.from(data)),
    fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
  }
  const notificationManager = {
    SlotType: { CONTENT_INFORMATION: 3 }, ContentType: { NOTIFICATION_CONTENT_BASIC_TEXT: 0 },
    async isNotificationEnabled() { return allowed },
    async requestEnableNotification() { permissions.push('requested'); allowed = true },
    async cancel(id) { notices.delete(id) },
    async publish(value) { await publishHook(value); notices.set(value.id, value) },
  }
  const workScheduler = {
    NetworkType: { NETWORK_TYPE_ANY: 0 },
    async obtainAllWorks() { return [...scheduled.values()] },
    startWork(work) { scheduled.set(work.workId, work) },
    stopWork(work, clear) { if (clear) scheduled.delete(work.workId) },
  }
  const kits = {
    '@kit.AbilityKit': {}, '@kit.BasicServicesKit': { deviceInfo: sdk },
    '@kit.CoreFileKit': { fileIo }, '@kit.BackgroundTasksKit': { workScheduler, WorkSchedulerExtensionAbility: class {} },
    '@kit.NotificationKit': { notificationManager },
    '@kit.ArkTS': { util: { TextEncoder: class { encodeInto(value) { return new TextEncoder().encode(value) } }, generateRandomUUID: randomUUID } },
    '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd() {
      const hash = createHash('sha256')
      return { async update(blob) { hash.update(blob.data) }, async digest() { return { data: Uint8Array.from(hash.digest()) } } }
    } } },
    '@kit.NetworkKit': { http: {
      RequestMethod: { POST: 'POST' }, HttpDataType: { STRING: 0 },
      createHttp() {
        const item = { destroyed: false, destroyCount: 0,
          async request(url, options) { item.url = url; item.options = options; requests.push(item); return response(item) },
          destroy() { item.destroyed = true; item.destroyCount++; if (destroyError) throw new Error('already destroyed') },
        }
        return item
      },
    } },
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    if (name === 'NativeCredentials') return { NativeCredentials: class { async load(slot) {
      assert.equal(slot, 'connection')
      if (credentialError) throw new Error('synthetic locked ASSET')
      return remembered
    } } }
    const directory = name === 'QingReadUpdateExtension' ? 'updates' : 'web'
    const source = fs.readFileSync(new URL(`../entry/src/main/ets/${directory}/${name}.ets`, import.meta.url), 'utf8')
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const exports = {}; modules.set(name, exports)
    vm.runInNewContext(javascript, { exports, console,
      setTimeout(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); timerCallbacks.delete(timer); callback() }, delay); timers.add(timer); timerCallbacks.set(timer, { callback, delay }); return timer },
      clearTimeout(timer) { timers.delete(timer); timerCallbacks.delete(timer); clearTimeout(timer) },
      require: name => name.startsWith('.') ? load(name.slice(name.lastIndexOf('/') + 1)) : kits[name] ?? (() => { throw new Error(`Unexpected dependency: ${name}`) })(),
    })
    return exports
  }
  const { NativeUpdates, NativeUpdateRunner } = load('NativeUpdates')
  const { UpdatePolicy } = load('UpdatePolicy')
  const manager = new NativeUpdates({ filesDir: directory })
  return { manager, UpdatePolicy, directory, requests, notices, scheduled, permissions, sdk,
    runner: () => new NativeUpdateRunner({ filesDir: directory }),
    extension: () => { const extension = new (load('QingReadUpdateExtension').default)(); extension.context = { filesDir: directory }; return extension },
    managerAgain: () => new NativeUpdates({ filesDir: directory }),
    setResponse(value) { response = value }, setPublishHook(value) { publishHook = value },
    setRemembered(value) { remembered = value ? JSON.stringify(value) : null },
    lockCredentials() { credentialError = true },
    failDestroy() { destroyError = true },
    fireTimer(delay) {
      const entry = [...timerCallbacks].find(([, value]) => value.delay === delay)
      assert.ok(entry, `Missing timer ${delay}`)
      const [timer, value] = entry; timers.delete(timer); timerCallbacks.delete(timer); clearTimeout(timer); value.callback()
    },
    async enable(books = [watch(1)], owner = profile, token = '') {
      await manager.configureProfile(owner, base, token)
      await manager.requestNotificationPermission({})
      await manager.replaceWatchedBooks(owner, true, books)
    },
    state: () => JSON.parse(fs.readFileSync(join(directory, 'qingread-updates-v1.json'), 'utf8')),
    cleanup() { for (const timer of timers) clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }) },
  }
}

test('default off, explicit permission, API23 gate and a genuine two-hour deferred registration', async () => {
  const h = harness()
  try {
    await h.manager.configureProfile(profile, base)
    let state = await h.manager.snapshot(profile)
    assert.equal(state.enabled, false); assert.equal(state.notifications, 'prompt')
    assert.equal(h.permissions.length, 0); assert.equal(h.scheduled.size, 0)
    await assert.rejects(h.manager.replaceWatchedBooks(profile, true, [watch(1)]), /允许清读通知/)
    await h.enable()
    const registered = [...h.scheduled.values()][0]
    assert.equal(registered.repeatCycleTime, 7200000); assert.equal(registered.isPersisted, true)
    assert.equal(registered.abilityName, 'QingReadUpdateExtension'); assert.equal(registered.networkType, 0)
    h.sdk.sdkApiVersion = 22
    assert.equal(await h.manager.available(), false)
    await h.runner().run(); assert.equal(h.requests.length, 0)
    assert.equal(h.UpdatePolicy.RUN_BUDGET, 80000); assert.equal(h.UpdatePolicy.REQUEST_BUDGET, 20000)
  } finally { h.cleanup() }
})

test('first observation establishes a baseline; unique old tail only announces appended unread chapters', async () => {
  const h = harness()
  try {
    await h.enable([{ book: book(1) }])
    await h.runner().run()
    assert.equal(h.notices.size, 0)
    let result = await h.manager.snapshot(profile)
    assert.equal(result.updates[book(1).id].knownChapterCount, 2)
    h.setResponse(async () => ({ responseCode: 200, result: JSON.stringify(chapters('c1', 'c2', 'c3')) }))
    await h.runner().run()
    result = await h.manager.snapshot(profile)
    assert.deepEqual(Array.from(result.updates[book(1).id].unreadChapterIDs), ['c3'])
    assert.equal(h.notices.size, 1)
    const notice = JSON.stringify([...h.notices.values()][0])
    assert.match(notice, /书架有新章节/); assert.doesNotMatch(notice, /Private title|source\.example|qingread-web/)
    await h.runner().run(); assert.equal(h.notices.size, 1)
    const request = h.requests[0]
    assert.equal(request.url, `${base}/chapters`); assert.equal(request.options.maxRedirects, 0)
    assert.equal(request.options.maxLimit, 2 * 1024 * 1024)
    assert.equal(request.options.method, 'POST'); assert.equal(request.options.header.Authorization, undefined)
  } finally { h.cleanup() }
})

test('ambiguous or missing anchors never mark an entire directory as new; read progress filters new IDs', () => {
  const h = harness()
  try {
    const policy = h.UpdatePolicy
    assert.equal(policy.appended({}, chapters('c1', 'c2')).length, 0)
    const duplicatedTitles = [{ id: 'a', title: 'Chapter 1' }, { id: 'b', title: 'Chapter 1' }, { id: 'c', title: 'Chapter 2' }]
    assert.equal(policy.appended({ lastKnownChapterTitle: 'Chapter 1' }, duplicatedTitles).length, 0)
    assert.deepEqual(Array.from(policy.appended({ lastKnownChapterTitle: 'Ｃｈａｐｔｅｒ １' }, chapters('1', '2'))), ['2'])
    const updated = policy.updated({ ...watch(1), readChapterID: 'c2' }, chapters('c1', 'c2', 'c3'), Date.now())
    assert.deepEqual(Array.from(updated.unreadChapterIDs), ['c3'])
    assert.throws(() => policy.chapters([{ id: 'a', title: 'a' }, { id: 'a', title: 'b' }]), /目录暂不可用/)
    for (const value of ['http://reading.example/api', 'https://user:pass@reading.example/api', 'https://reading.example/api?q=x', 'https://localhost/api', 'https://reading.example/../api']) {
      assert.throws(() => policy.apiBase(value), /HTTPS/)
    }
  } finally { h.cleanup() }
})

test('account ABA replacement invalidates an old Extension even when the profile string returns', async () => {
  const h = harness(), entered = deferred(), response = deferred()
  try {
    await h.enable()
    h.setResponse(async () => { entered.resolve(); return response.promise })
    const running = h.runner().run(); await entered.promise
    const other = h.managerAgain()
    await other.configureProfile('qingread-cloud-https://reading.example/api|user-b', base)
    await other.configureProfile(profile, base)
    await other.replaceWatchedBooks(profile, true, [watch(1)])
    response.resolve({ responseCode: 200, result: JSON.stringify(chapters('c1', 'c2')) })
    await running
    assert.equal(h.notices.size, 0)
    assert.equal((await other.snapshot(profile)).updates[book(1).id].knownChapterCount, 1)
  } finally { h.cleanup() }
})

test('source switch and disabling reminders both reject late catalog writes and notifications', async () => {
  for (const change of ['source', 'disable']) {
    const h = harness(), entered = deferred(), response = deferred()
    try {
      await h.enable()
      h.setResponse(async () => { entered.resolve(); return response.promise })
      const running = h.runner().run(); await entered.promise
      const replacement = change === 'source' ? [{ ...watch(1), book: { ...book(1), sourceID: 'new-source', url: 'https://another.example/book/1' } }] : []
      await h.managerAgain().replaceWatchedBooks(profile, change === 'source', replacement)
      response.resolve({ responseCode: 200, result: JSON.stringify(chapters('c1', 'c2')) }); await running
      assert.equal(h.notices.size, 0)
      const state = h.state()
      assert.equal(state.enabled, change === 'source')
      if (change === 'source') assert.equal(state.watches[0].baseline.knownChapterCount, 1)
      else { assert.equal(state.watches.length, 0); assert.equal(h.scheduled.size, 0) }
    } finally { h.cleanup() }
  }
})

test('onWorkStop-style cancellation destroys the request and settles without writing its late result', async () => {
  const h = harness(), entered = deferred(), response = deferred()
  try {
    await h.enable(); h.setResponse(async () => { entered.resolve(); return response.promise })
    const runner = h.runner(), running = runner.run(); await entered.promise
    runner.stop(); await running
    assert.equal(h.requests[0].destroyed, true)
    response.resolve({ responseCode: 200, result: JSON.stringify(chapters('c1', 'c2')) })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.state().watches[0].baseline.knownChapterCount, 1); assert.equal(h.notices.size, 0)
  } finally { h.cleanup() }
})

test('both request and whole-run hard deadlines destroy transport without waiting in real time', async () => {
  for (const delay of [20000, 80000]) {
    const h = harness(), entered = deferred(), response = deferred()
    try {
      await h.enable(); h.setResponse(async () => { entered.resolve(); return response.promise })
      const running = h.runner().run(); await entered.promise
      h.fireTimer(delay); await running
      assert.equal(h.requests[0].destroyed, true)
      assert.equal(h.state().watches[0].baseline.knownChapterCount, 1); assert.equal(h.notices.size, 0)
    } finally { h.cleanup() }
  }
})

test('a native destroy error cannot prevent stop from rejecting the pending HTTP promise', async () => {
  const h = harness(), entered = deferred(), response = deferred()
  try {
    await h.enable(); h.setResponse(async () => { entered.resolve(); return response.promise })
    const runner = h.runner(), running = runner.run(); await entered.promise
    h.failDestroy(); runner.stop(); await running
    assert.equal(h.requests[0].destroyed, true); assert.equal(h.notices.size, 0)
    assert.equal(h.state().watches[0].baseline.knownChapterCount, 1)
  } finally { h.cleanup() }
})

test('the actual Extension lifecycle only runs its registered work and onWorkStop cancels its runner', async () => {
  const h = harness(), entered = deferred(), response = deferred()
  try {
    await h.enable(); h.setResponse(async () => { entered.resolve(); return response.promise })
    const extension = h.extension()
    extension.onWorkStart({ workId: 1 }); assert.equal(h.requests.length, 0)
    extension.onWorkStart({ workId: h.UpdatePolicy.WORK_ID }); await entered.promise
    extension.onWorkStop({ workId: h.UpdatePolicy.WORK_ID })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.requests[0].destroyed, true); assert.equal(h.state().watches[0].baseline.knownChapterCount, 1)
    assert.equal(h.notices.size, 0)
  } finally { h.cleanup() }
})

test('three-request budget rotates by durable attempt time; unauthorized/rate-limited responses end the round', async () => {
  const h = harness()
  try {
    await h.enable(Array.from({ length: 8 }, (_, index) => watch(index)))
    await h.runner().run(); assert.equal(h.requests.length, 3)
    const first = h.requests.slice().map(value => JSON.parse(value.options.extraData).book.id)
    await h.runner().run(); assert.equal(h.requests.length, 6)
    const second = h.requests.slice(3).map(value => JSON.parse(value.options.extraData).book.id)
    assert.equal(second.some(id => first.includes(id)), false)
    h.setResponse(async () => ({ responseCode: 429, result: '' }))
    await h.runner().run(); assert.equal(h.requests.length, 7)
  } finally { h.cleanup() }
})

test('only exact current ASSET credentials can authorize; tokens never enter durable state', async () => {
  const h = harness()
  try {
    const token = 'synthetic-private-access-token'
    await h.enable([watch(1)], profile, token)
    h.setRemembered({ address: base, token: 'old-token' })
    await h.runner().run(); assert.equal(h.requests.length, 0)
    h.setRemembered({ address: 'https://other.example/api', token })
    await h.runner().run(); assert.equal(h.requests.length, 0)
    h.setRemembered({ address: base, token })
    await h.runner().run(); assert.equal(h.requests[0].options.header['X-QingRead-Token'], token)
    assert.doesNotMatch(fs.readFileSync(join(h.directory, 'qingread-updates-v1.json'), 'utf8'), /synthetic-private-access-token|old-token/)
    h.lockCredentials(); await h.runner().run(); assert.equal(h.requests.length, 1)
  } finally { h.cleanup() }
})

test('a profile replacement waits for an in-flight publish then clears it before returning', async () => {
  const h = harness(), publishing = deferred(), release = deferred()
  try {
    await h.enable()
    h.setPublishHook(async () => { publishing.resolve(); await release.promise })
    const running = h.runner().run(); await publishing.promise
    let switched = false
    const switching = h.managerAgain().configureProfile('qingread-cloud-https://reading.example/api|other', base).then(() => { switched = true })
    await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(switched, false)
    release.resolve(); await Promise.all([running, switching])
    assert.equal(switched, true); assert.equal(h.notices.size, 0); assert.equal(h.state().enabled, false)
  } finally { h.cleanup() }
})

test('old document configuration cannot write after awaiting credential hashing or state lock', async () => {
  const h = harness()
  try {
    await h.enable()
    const before = fs.readFileSync(join(h.directory, 'qingread-updates-v1.json'), 'utf8')
    await assert.rejects(h.manager.configureProfile(null, '', '', () => false), /页面已关闭/)
    await assert.rejects(h.manager.replaceWatchedBooks(profile, false, [], () => false), /账号已切换/)
    assert.equal(fs.readFileSync(join(h.directory, 'qingread-updates-v1.json'), 'utf8'), before)
  } finally { h.cleanup() }
})
