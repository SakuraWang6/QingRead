import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(new URL('../../web/package.json', import.meta.url))
const ts = require('typescript')
const source = await readFile(new URL('../entry/src/main/ets/web/LocalOrigin.ets', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
const { LocalOrigin } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

test('packaged origin maps root and preserves only safe resource paths', () => {
  assert.equal(LocalOrigin.assetPath('https://localhost/'), '/index.html')
  assert.equal(LocalOrigin.assetPath('https://localhost:443/assets/main.js?v=2'), '/assets/main.js')
  assert.equal(LocalOrigin.assetPath('https://localhost/index.html#reader'), '/index.html')
  assert.equal(LocalOrigin.isAppPage('https://localhost/assets/main.js'), false)
})

test('traversal, ambiguous separators and double encoding cannot become rawfile paths', () => {
  for (const path of ['/../secret', '/assets/../index.html', '/%2e%2e/secret', '/%252e%252e/secret',
    '/assets//main.js', '//index.html', '/assets%5cmain.js', '/assets/%00x', '/assets/%3fother', '/%GG']) {
    assert.equal(LocalOrigin.assetPath(`https://localhost${path}`), undefined, path)
  }
})

test('alternate local schemes, ports, credentials and loopback aliases never receive asset paths', () => {
  for (const address of ['http://localhost/', 'https://localhost:3000/', 'https://user@localhost/',
    'https://localhost./', 'https://127.0.0.1/', 'https://[::1]/', 'https://%6cocalhost/']) {
    assert.equal(LocalOrigin.isLoopbackRequest(address), true, address)
    assert.equal(LocalOrigin.assetPath(address), undefined, address)
    assert.equal(LocalOrigin.isExternalHttps(address), false, address)
  }
})

test('external navigation permits HTTPS and rejects opaque or privileged schemes', () => {
  assert.equal(LocalOrigin.isExternalHttps('https://example.org/books?id=1'), true)
  assert.equal(LocalOrigin.isExternalHttps('https://example.org?feedback'), true)
  assert.equal(LocalOrigin.isLoopbackRequest('https://localhost.example.org/'), false)
  for (const address of ['javascript:alert(1)', 'file:///data/local', 'http://example.org/',
    'data:text/html,test', 'https://user@example.org/', 'https://example.org/has space']) {
    assert.equal(LocalOrigin.isExternalHttps(address), false, address)
    assert.equal(LocalOrigin.assetPath(address), undefined, address)
  }
})
