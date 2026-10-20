# 许可范围与切换记录

## 当前提供的许可

当前清读原创代码按仓库根目录的 **Polyform Strict License 1.0.0** 提供。`web/LICENSE` 是用于独立打包的相同副本。标准英文原文保持不变，说明文字不能替代许可正文。

该许可只授予条款列明的非商业用途，不授予商业用途、修改、创作衍生作品或再分发的许可。个人学习、测试、娱乐等用途及许可列明的非商业组织用途，以原文为准；不要把“非商业”简化成“只要没有直接收费”。商业服务、出售安装包、广告变现、商业产品整合或修改/再发布应先取得相应权利人的单独书面授权。本仓库未作这类普遍授权。

它属于 **source-available（源码可见）**，不是 OSI 定义的 Open Source。GPL/AGPL 本身允许商用，也不能简单在它们后面添加“禁止商用”来冒充标准 GPL/AGPL。

维护者作为其拥有版权内容的权利人，可继续开发与发布该内容；第三方不能据此推定自己获得同等权利。若要提交代码修改，请先取得单独书面许可，不默认接受未经授权的改版分发。

## 旧 MIT 授权不能追溯取消

2026-10-21，此项目曾按 MIT 公开；截至 `6524b2f` 的版本和本轮已生成的 0.6 安装包是在许可证切换前提供的。新的 LICENSE 不撤销已经授予的 MIT 权利，也不能保证阻止对旧版代码的合法商业使用。旧版授权条件仍按当时的许可判断；后续原创新增和修改按发布时标明的许可判断。

本次保留真实历史，不通过删除旧 LICENSE 记录或重写提交来暗示旧权利已失效。GitHub 平台对公开仓库的查看、fork 等平台权利也不因这里的说明被取消。

## 第三方依赖、模型和作品

Polyform Strict 只适用于本项目有权许可的原创内容。SwiftSoup、ZIPFoundation、React、Capacitor、PDF.js 等第三方组件，以及模型、字体、数据集和书籍，均保留原许可和版权；不能给他人的 MIT/Apache/GPL 作品追加本项目的限制。

现有预编译 iOS 语音运行时实际包含 eSpeak NG 等 GPL 组件，见 `docs/offline-voice.md`。本仓库没有公开分发包含它们的个人 iOS 安装包。不能将禁止商用条款当作 GPL 组合二进制的有效附加限制；公开分发这类组合前必须另行解决许可兼容性及对应源码义务。Web/Android 当前使用系统语音，不打包该 iOS 运行时。

## 标准文本与依据

- 官方固定发布文本：https://github.com/polyformproject/polyform-licenses/blob/Polyform-Strict-1.0.0/Polyform-Strict.md
- 官方对 Strict 的说明：https://polyformproject.org/why-adopt-polyform
- OSI 定义第 6 条：https://opensource.org/osd
- GitHub 许可切换说明：https://opensource.guide/legal/#what-if-i-want-to-change-the-license-of-my-project
