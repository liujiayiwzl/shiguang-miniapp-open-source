# 拾光 · Shiguang Mini Program

一个由两位独立开发者共同制作的微信小程序项目，包含灵感卡片、AI 创作、收藏分享以及英语单词学习和打卡。

> **开源演示版**：这份代码与正在运营的线上服务分离。默认使用示例词库（每个词库 12 条），不包含生产环境 AppID、云环境 ID、账号数据或历史提交。示例词库用于调试和体验交互，并非完整正式词库。

## 主要功能

- 灵感卡片库：按主题抽取、收藏与分享
- AI 灵感卡片创作：中英双语、主题输入、安全审核、每日调用限制
- 英语学习：翻卡、四选一、初中／高中／CET4／CET6 四个入口
- 学习打卡：每日目标、日历、正确率和云端同步
- 英式、美式单词发音（依赖外部音频服务）

## 本地运行

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。
2. 使用自己的 AppID 创建或导入项目；将 `project.config.json` 中的 `touristappid` 改为你自己的 AppID（体验代码可先使用测试号）。
3. 申请自己的微信云开发环境，将 `app.js` 中的 `YOUR_CLOUDBASE_ENV_ID` 改为你的环境 ID。**不要提交真实线上配置或密钥。**
4. 在自己的云开发环境中创建集合：`cards`、`favorites`、`ai_usage`、`wordProfiles`、`wordDaily`、`wordRecords`。数据库权限建议遵循最小权限原则，通过云函数操作用户数据。
5. 在微信开发者工具中分别部署 `cloudfunctions/` 下面需要的云函数（上传并部署：云端安装依赖）。
6. 如需使用 AI 创作，自行申请、配置合法可用的云开发 AI 模型服务和相关权限，且遵守所在地区的内容安全与合规规则。
7. 运行并编译。初中、高中、四级、六级四个演示词库均包含 12 个示例单词。

**注意**：由于云服务、AppID 和模型权限需自行配置，下载源码不等于能直接连接原有线上数据库或使用原应用的 AI 配额。

## 项目结构

```text
pages/                首页、收藏、我的
packageWords/         背单词分包（含少量演示词条）
components/           导航组件
cloudfunctions/       云函数（卡片、收藏、AI、学习进度）
utils/                数据与共享工具
scripts/              原始数据构建与自动化测试脚本
```

## 词库说明与第三方版权

公开包**不包含生产使用的 14,286 条词库数据**。原项目的正式词库基于 ECDICT、english-vocabulary、ipa-dict 等资料处理生成。某些上游英语英式音标数据存在独立的第三方授权要求，因此为避免未经核实地再分发衍生数据，公开包仅提供演示词条。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。`scripts/` 中的下载和构建脚本仅用于研发，请自行检查原始数据授权后使用。

## 安全和隐私

- 不要上传 `project.private.config.json`、`.env`、私钥或云开发凭据
- 微信用户 OpenID 等生产环境信息不包含在这个仓库中
- 通过云函数校验用户身份，不要把云数据库设置为所有人可写
- AI 用户生成内容是否能公开入库需要单独的同意和内容审核流程
- 若你部署为公开服务，需自行满足相关主体、隐私与生成内容标识要求

## 贡献

欢迎通过 Issues 提交问题、建议，并使用 Pull Request 贡献代码。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。漏洞问题不要在公开 Issue 中披露密钥或用户隐私，请阅读 [SECURITY.md](SECURITY.md)。

## 开源协议

项目团队自有源代码采用 [MIT License](LICENSE) 发布（需两位共同开发者确认授权）。第三方数据、服务与素材适用各自的授权条款。
