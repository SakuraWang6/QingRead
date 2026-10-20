# Third-party notices

QingRead's current independently authored code offering uses Polyform Strict License 1.0.0; see LICENSE and docs/licensing.md. This does not revoke earlier MIT grants. Third-party components below retain their original licenses, without additional QingRead restrictions.
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
- Usage: bounded in-memory EPUB entry reading.

## Offline speech and Kokoro

- Official runtime: https://github.com/k2-fsa/sherpa-onnx
- Kokoro model: https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_1/tree/155831f1b4ba23b1f5c058be6a61df90cefb2a37
- Model LICENSE: Apache-2.0, downloaded with the model and also bundled in the app notices.
- Runtime and eSpeak dependency versions, licenses, source links and actual linked archive inventory: `docs/offline-voice.md` and `App/Resources/ThirdPartyNotices.txt`.

## Whole-book sources

Search and file downloads are fetched from Project Gutenberg, Standard Ebooks, and OpenStax. Original book URLs and source names are retained. No downloaded book files or covers are committed; each edition retains its source terms and notices.
