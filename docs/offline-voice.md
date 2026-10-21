# 离线 AI 朗读：Melo 与 Kokoro

依赖核对日期：2026-10-20；当前 iPhone 版本 0.8.2/build 10。Web/Android 使用系统语音，未集成本文的原生离线引擎。

在 iPhone「设置」中管理 Melo/Kokoro 声库，在阅读页的听书面板选择引擎、音色和语速。Melo 提供一个中文音色；Kokoro 提供三个女声与三个男声。两套声库都需首次联网下载，通过校验后可离线使用。

Melo 声库是可选下载。用户主动下载后，文字转语音在手机本地通过 ONNX Runtime CPU 推理，音频也在本地播放；合成不调用云端 API，不上传小说段落或生成音频。首次下载会访问 Hugging Face 的 HTTPS 文件服务。系统中文语音仍是独立选项。

## 固定引擎版本

使用官方仓库 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，不使用第三方 Swift 包装仓库。

- 标签：`v1.13.8`。
- Git revision：`11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`。
- SwiftPM product：`sherpa-onnx`；Swift 模块：`SherpaOnnx`。
- Swift tools：5.9；官方包最低 iOS 15，QingRead 最低 iOS 16。
- 间接依赖：`csukuangfj/onnxruntime-libs` `1.28.2`，本次解析 revision 为 `8ebc5ebf92190903c274a7621ba4c96a732335ec`。

以上均来自固定版本的 [Package.swift](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/Package.swift) 和本地 SwiftPM 的 `workspace-state.json`。`v1.13.8` 标签已经包含公开 Swift 接口，无须跟随 `master`。

```swift
.package(
    url: "https://github.com/k2-fsa/sherpa-onnx",
    revision: "11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf"
)
// target dependencies:
.product(name: "sherpa-onnx", package: "sherpa-onnx")
```

本次解析到的 iOS 静态包为：

| 包 | 官方下载 | ZIP SHA256 |
|---|---|---|
| SherpaOnnx 1.13.8 | [iOS static XCFramework](https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/sherpa-onnx-v1.13.8-ios-static.xcframework.zip) | `6b8e769cb153343270fdccbe92e3b3db0d1c421d67fa0989ab01fdf5b2fcf2de` |
| ONNX Runtime 1.28.2 | [iOS static XCFramework](https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.28.2/onnxruntime-ios-static-xcframework-1.28.2.xcframework.zip) | `2c2299acbb461d26d4bac4bc85985d40e7c7177ed6072703ae0846d88b0b4599` |

## 固定声库与下载清单

来源：[csukuangfj/vits-melo-tts-zh_en](https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/tree/a0d5c6a264c0ef92d70d8661d8cc502d79627cd6)，固定 revision：`a0d5c6a264c0ef92d70d8661d8cc502d79627cd6`。它是 MyShell.ai MeloTTS 中文模型的 ONNX 转换版，单一音色，支持中文和词典已收录的英文词。QingRead 选择 INT8 权重。

所有下载均使用以下不可变 URL 前缀，加表中的文件名：

```text
https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/a0d5c6a264c0ef92d70d8661d8cc502d79627cd6/
```

| 文件 | 字节数 | SHA256 |
|---|---:|---|
| `model.int8.onnx` | 53,517,430 | `f085f5079e05f039b800aeb542f5253c26a303211b0c6465d0d9387977855a63` |
| `lexicon.txt` | 6,837,671 | `7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528` |
| `tokens.txt` | 655 | `d18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d` |
| `date.fst` | 59,154 | `eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718` |
| `number.fst` | 64,482 | `743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd` |
| `LICENSE` | 1,053 | `88a50e5a02bbc2a5c2f084dc19da751aa97b1690f5fda76cd8005c8634d1ca70` |
| **总计** | **60,480,445** | **约 60.5 MB / 57.68 MiB** |

权重大小和 SHA256 来自该版本的 Hugging Face LFS 元数据；其余五项通过实际请求文件后计算。研究阶段没有为了计算校验值下载模型权重。

三个基础合成文件是权重、词典和 tokens；`date.fst`、`number.fst` 用于日期和数字规范化，配置与[官方 Melo 示例](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html#vits-melo-tts-zh-en-chinese-english-1-speaker)一致。旧模型目录中的 `dict/` 不需要下载：固定版本的 [VITS 配置实现](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/sherpa-onnx/csrc/offline-tts-vits-model-config.cc) 明确从 1.12.15 起忽略 `dictDir`。本版本也不使用额外的 `phone.fst` 或 `new_heteronym.fst`。

`App/AIModelManager.swift` 维护上述唯一下载清单。文件先进入临时目录，逐项检查字节数与 SHA256；全部通过后才移入 `Application Support/QingRead/VoiceModels/Melo-int8` 并写入清单标记。下载默认不使用蜂窝数据，可取消、重试或删除。声库不是 App 首次安装包的一部分；二进制引擎是构建依赖的一部分。

## 官方 Swift 配置

以下接口均公开于固定版本的 [SherpaOnnx.swift](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/swift-api-examples/SherpaOnnx.swift)。实际封装见 `App/OfflineSpeechEngine.swift`。

```swift
import SherpaOnnx

let vits = sherpaOnnxOfflineTtsVitsModelConfig(
    model: dir.appendingPathComponent("model.int8.onnx").path,
    lexicon: dir.appendingPathComponent("lexicon.txt").path,
    tokens: dir.appendingPathComponent("tokens.txt").path
)
let model = sherpaOnnxOfflineTtsModelConfig(
    vits: vits, numThreads: 2, debug: 0, provider: "cpu"
)
var config = sherpaOnnxOfflineTtsConfig(
    model: model,
    ruleFsts: ["date.fst", "number.fst"]
        .map { dir.appendingPathComponent($0).path }
        .joined(separator: ","),
    maxNumSentences: 1
)
let tts = SherpaOnnxOfflineTtsWrapper(config: &config)
guard tts.tts != nil else { return }
let audio = tts.generate(text: text, sid: 0, speed: speed)
guard audio.audio != nil, audio.n > 0 else { return }
let samples: [Float] = audio.samples
let sampleRate = Double(audio.sampleRate)
```

输出是单声道 Float PCM。模型创建、合成和销毁在后台串行队列执行，PCM 交给本地音频播放器；不在主线程进行推理。固定版本的生成结果保存了可能为空的底层指针，因此在读取 `n`、`samples` 前检查 `audio.audio`。`sid: 0` 对应该声库唯一音色。音质、发音与速度仍需要在目标 iPhone 上试听评估。

## 许可与实际预编译依赖

引擎仓库顶层 [LICENSE](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/LICENSE) 是 Apache-2.0；声库固定版本的 [LICENSE](https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/blob/a0d5c6a264c0ef92d70d8661d8cc502d79627cd6/LICENSE) 是 MIT，版权为 MyShell.ai。**这两项不能代替整个预编译引擎及其依赖的许可清单。**

本次检查对象是下载到以下目录的官方 iOS 静态产物：

```text
.build/xcode/SourcePackages/artifacts/sherpa-onnx/SherpaOnnxIOS/
  sherpa-onnx.xcframework/ios-arm64/SherpaOnnxC.framework/SherpaOnnxC
.build/xcode/SourcePackages/artifacts/onnxruntime-libs/OnnxruntimeIOS/
  onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime
```

这些 XCFramework 目录没有附带独立 `LICENSE`、`COPYING` 或 `NOTICE` 文件，不能据此认为不存在许可要求。对 `SherpaOnnxC` 使用 `ar -t` / `nm` 检查，确认实际归档包含 eSpeak NG 的 `espeak_api.c.o`、`synthesize.c.o`、`voices.c.o`、`translate.c.o`，Piper 的 `phonemize.cpp.o`、`phoneme_ids.cpp.o`、`shared.cpp.o`，以及 ucd 的 `case.c.o` 等对象。固定版本的 [build-ios.sh](https://github.com/k2-fsa/sherpa-onnx/blob/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf/build-ios.sh) 也明确用 `libtool -static` 合并相应静态库。因此这些是已下载产物的组成部分，不能仅凭 QingRead 使用 Melo 而从依赖记录中省略。

| 组件 | 固定版本或来源 | 上游许可及证据 |
|---|---|---|
| sherpa-onnx | 1.13.8，上述固定 revision | Apache-2.0；仓库顶层 LICENSE |
| Melo 中文 ONNX 模型 | 上述固定模型 revision | MIT；模型目录 LICENSE |
| ONNX Runtime | 1.28.2 | [MIT](https://github.com/microsoft/onnxruntime/blob/v1.28.2/LICENSE)，另有上游 [ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/v1.28.2/ThirdPartyNotices.txt) |
| eSpeak NG | `csukuangfj/espeak-ng` `ed530aa113046142eb5115cf2fc9157854d0ffe1` | [COPYING](https://github.com/csukuangfj/espeak-ng/blob/ed530aa113046142eb5115cf2fc9157854d0ffe1/COPYING) 为 GPLv3；源文件声明 GPL-3.0-or-later |
| ucd-tools | 随上述 eSpeak NG 源码 | [case.c 版权许可头](https://github.com/csukuangfj/espeak-ng/blob/ed530aa113046142eb5115cf2fc9157854d0ffe1/src/ucd-tools/src/case.c)，GPL-3.0-or-later |
| piper-phonemize | `f3ff95afc03640bc1399e113e83361192a2fafb4` | [MIT / Michael Hansen](https://github.com/csukuangfj/piper-phonemize/blob/f3ff95afc03640bc1399e113e83361192a2fafb4/LICENSE.md) |
| kaldi-native-fbank | 1.22.3 | [Apache-2.0](https://github.com/csukuangfj/kaldi-native-fbank/blob/v1.22.3/LICENSE) |
| Kiss FFT | `febd4caeed32e33ad8b2e0bb5ea77542c40f18ec`，由 fbank 构建脚本固定 | [BSD-3-Clause](https://github.com/mborgerding/kissfft/blob/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec/LICENSES/BSD-3-Clause) |
| kaldi-decoder | 0.3.0 | [Apache-2.0](https://github.com/k2-fsa/kaldi-decoder/blob/v0.3.0/LICENSE) |
| kaldifst | kaldi-decoder 固定到 1.8.0 | [Apache-2.0](https://github.com/k2-fsa/kaldifst/blob/v1.8.0/LICENSE) |
| OpenFst | `1.8.5-2026-07-09` | [COPYING](https://github.com/csukuangfj/openfst/blob/v1.8.5-2026-07-09/COPYING) 为 Apache-2.0，包含 Google 版权声明 |
| simple-sentencepiece | 0.7 | [Apache-2.0](https://github.com/pkufool/simple-sentencepiece/blob/v0.7/LICENSE) |
| hclust-cpp / fastcluster | `2026-02-25`，编入 `fast-clustering.cc.o` | [BSD 风格两条款许可](https://github.com/csukuangfj/hclust-cpp/blob/2026-02-25/LICENSE)，保留 Daniel Müllner 与 Christoph Dalitz 版权声明 |
| Eigen 头文件 | sherpa 构建脚本引用 5.0.1，kaldi-decoder 的构建脚本另引用 3.4.0 | [MPL-2.0](https://gitlab.com/libeigen/eigen/-/blob/5.0.1/COPYING.MPL2)，也应保留实际使用文件中的声明 |

上述组件版本来自固定 sherpa 源码的 `cmake/`、依赖项目的固定构建脚本与实际 archive 对象清单。Eigen 等头文件依赖也应结合构建源码记录；仅凭 archive 对象名不能确定每一段模板代码使用的头文件版本。上游 ONNX Runtime 完整第三方声明已一并保留，其中列出的所有组件并不等于它们都出现在本次 iOS 产物中。

已收集的许可全文、版权声明及对应上游来源放在 `App/Resources/ThirdPartyNotices.txt`。这份说明记录工程事实和来源，不作最终的法律或分发合规结论。当前是个人自用开发；若未来向他人分发安装包，应以届时实际链接的库、构建方式和模型版本为准，复核相应许可证，保留要求的版权与许可声明，并准备适用许可证所要求的对应源码及构建信息。更换为自行裁剪的引擎时也应重新记录产物组成，不能沿用未经核对的依赖清单。


## Kokoro 中文男、女声

官方引擎说明：[kokoro-multi-lang-v1_1](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)。选择官方维护者的 [INT8 转换声库](https://huggingface.co/csukuangfj/kokoro-int8-multi-lang-v1_1/tree/155831f1b4ba23b1f5c058be6a61df90cefb2a37)，固定 revision `155831f1b4ba23b1f5c058be6a61df90cefb2a37`。v1.1 的音色编号与 v1.0 不同：中文女声 3–57，男声 58–102；界面提供女声 3/16/46、男声 58/76/93，名称保留上游编号，不虚构真人声线名称。

声库清单是 `App/Resources/KokoroManifest.json`：17 个文件共 178,683,881 bytes。包括 INT8 权重、voices.bin、中英文词典、tokens、数字/日期 FST、LICENSE，以及中文/英文所需的 eSpeak 数据。每项有大小与 SHA256，使用与 Melo 相同的分阶段校验下载；失败文件不进入可选状态。

Kokoro 模型目录的 LICENSE 是 Apache-2.0，保留在下载目录。eSpeak 数据及引擎的许可仍应结合上文依赖说明，不能以模型许可替代。ZIPFoundation（MIT）负责 EPUB 读取，其许可也已加入应用的 ThirdPartyNotices.txt。

两套离线引擎现在把整章按短句切分，在串行推理队列提前准备后三句，开始播放前等待下一句准备好，避免跨段重新启动播放队列。WAV 按引擎、音色、文字缓存到本地（最多 128 MB），更改语速只调整播放器，不让当前句重读。暂停、停止、切章和换音色均保留原有取消边界。

2026-10-20 iPhone 17 模拟器（Mac CPU）实测：女声 46 冷载入短句 4.10 秒、男声 76 为 3.10 秒；随后约 9.70/9.08 秒的声音，热合成耗时 8.94/7.73 秒；相同音频缓存重读约 1 毫秒。模拟器数据不代表真机速度。以两段正文完成真实播放、语速调整不重置、暂停恢复和旧回调隔离等诊断。预缓冲降低句间等待，但首次仍需准备，高倍速或设备较慢时不能保证无等待。
