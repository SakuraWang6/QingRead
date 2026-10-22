# Third-party notices

QingRead's current independently authored code offering uses Polyform Strict License 1.0.0; see LICENSE and docs/licensing.md. Third-party components below retain their original licenses, without additional QingRead restrictions.
The following projects are dependencies or remote content sources, not copied competing applications.

## SwiftSoup

- Project: https://github.com/scinfu/SwiftSoup
- License: MIT, as distributed with the resolved Swift package.
- Usage: HTML parsing and CSS selectors in `ReadingCore`.
- Its original license file remains in the dependency package. `Package.resolved` pins the version used for verification.

## chinese-novel

- Project: https://github.com/luoxuhai/chinese-novel
- Original license: https://github.com/luoxuhai/chinese-novel/blob/master/LICENSE
- Usage: requests the original `info.json` and numbered HTML chapter files for the built-in classical catalog. No cover images or modern summaries are copied into this repository.
- The dataset repository's license declaration is reproduced below. It does not replace the copyright status or terms applicable to each text or edition.

MIT License

Copyright (c) 2019 Darkce

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Wikisource

- Source: https://zh.wikisource.org/
- Content terms: https://zh.wikisource.org/wiki/Wikisource:版权信息
- API: https://www.mediawiki.org/wiki/API:Main_page
- Usage: remote search, page links, and parsed text. The original work's URL and source name are retained in the app. Attribution and copyright status depend on the original work and edition; no Wikisource article is bundled in the repository.

## Local sample

`App/` contains the classical text 《桃花源记》 by 陶渊明 as an offline reading sample. It is explicitly labelled a local sample and never inserted into network search results.


## ZIPFoundation

- Project: https://github.com/weichsel/ZIPFoundation/tree/0.9.20
- License: MIT; full text bundled in `App/Resources/ThirdPartyNotices.txt`.
- Usage: bounded EPUB text reading and validated local original-layout resources.

## Offline speech and Kokoro

- Official runtime: https://github.com/k2-fsa/sherpa-onnx
- Kokoro model: https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_1/tree/155831f1b4ba23b1f5c058be6a61df90cefb2a37
- Model LICENSE: Apache-2.0, downloaded with the model and also bundled in the app notices.
- Runtime and eSpeak dependency versions, licenses, source links and actual linked archive inventory: `docs/offline-voice.md` and `App/Resources/ThirdPartyNotices.txt`.

## Whole-book sources

Search and file downloads are fetched from Project Gutenberg, Standard Ebooks, and OpenStax. Original book URLs and source names are retained. No downloaded book files or covers are committed; each edition retains its source terms and notices.

## web-push

- Project: https://github.com/web-push-libs/web-push
- Version: 3.6.7, fixed in `web/package-lock.json`.
- License: MPL-2.0; the unmodified package and its full license remain in the server dependency installation.
- Usage: standard VAPID authentication and Web Push payload encryption for optional, account-authorized update notifications. It is a server dependency, not a telemetry SDK or native push service.

## Web and Android reader dependencies

The exact npm dependency versions are recorded in `web/package-lock.json`; upstream license files remain in the installed packages. This inventory supplements, rather than replaces, those license and copyright texts. QingRead's own license does not apply to these components.

| Component | Upstream license | Use |
| --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) | MIT | Web and Android interface |
| [Capacitor](https://github.com/ionic-team/capacitor), [App plugin](https://github.com/ionic-team/capacitor-plugins) | MIT | Android host and system integration |
| [PDF.js](https://github.com/mozilla/pdf.js/blob/master/LICENSE) | Apache-2.0 | Local PDF rendering and text search |
| [fflate](https://github.com/101arrowz/fflate/blob/master/LICENSE) | MIT | Bounded EPUB extraction |
| [Lucide](https://github.com/lucide-icons/lucide) | ISC, with retained upstream notices | Interface icons |
| [idb](https://github.com/jakearchibald/idb) | ISC | Account-scoped IndexedDB |
| [noble-hashes](https://github.com/paulmillr/noble-hashes) | MIT | Local file hashes |
| [Workbox](https://github.com/GoogleChrome/workbox) | MIT | PWA offline resources and worker integration |
| [Fastify](https://github.com/fastify/fastify), [static](https://github.com/fastify/fastify-static), [rate-limit](https://github.com/fastify/fastify-rate-limit) | MIT | HTTP routes, static resources and request limits |
| [Cheerio](https://github.com/cheeriojs/cheerio), [iconv-lite](https://github.com/pillarjs/iconv-lite) | MIT | Source parsing and character encoding |
| [OpenCC-js](https://github.com/nk2028/opencc-js) | MIT AND Apache-2.0 | Simplified/traditional Chinese search conversion |
| [tsx](https://github.com/privatenumber/tsx) | MIT | TypeScript server execution |
| [AndroidX WorkManager](https://github.com/androidx/androidx/tree/androidx-main/work) | Apache-2.0 | Optional Android background update checks; `work-runtime:2.12.0` |

PDF.js also supplies CMaps, standard fonts and WASM components with their own notices. `web/scripts/copy-pdf-assets.mjs` copies the original resource directories, including their license files, into `public/pdfjs/` for Web and Android packaging; these notices must remain with those resources. PDF text stays local; no OCR or external document-analysis SDK is added.
