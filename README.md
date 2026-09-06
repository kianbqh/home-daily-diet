<img src="assets/app-avatar.png" alt="今天想吃啥：一碗家常饭" width="88" height="88">

# 今天想吃啥

把家里做过的菜留下来，今天吃什么不再从头想。

一个可以自行部署的家庭微信小程序：记录做过的菜、照片和制作经验，让家人从自己的菜品库里点菜，再把每次做饭的经验慢慢积累成家庭菜谱。

**当前版本：`0.3.0`，开发预览。** 使用前需要配置自己的微信小程序和 CloudBase 环境。

[部署指南](docs/cloudbase-phase-two-setup.md) · [产品说明](SPEC.md) · [真机验收](docs/qa/phase-two-dual-account-checklist.md)

## 从一顿家常饭开始

1. **把菜留下来。** 记录菜名、照片、标签和特点，建立家里自己的菜品库；没有照片也能保存。
2. **让家人一起点菜。** 用 6 位短邀请码加入家庭，从已有菜品中提交想吃的菜，再确认这一餐的菜单。
3. **记住这次做得怎么样。** 给同一道菜追加制作日期、餐次和照片，家人可以针对这一次制作留下评分和评价。
4. **把经验变成菜谱。** 手动填写做法，或口述食材、步骤和小技巧，确认后保存本次做法，也可以更新家庭主菜谱。

先有菜品库，再有点菜。过去做过的菜、某次特别成功的做法，以及家人的评价，都能在同一道菜里找到。

| 日常需要 | 小程序里的做法 |
| --- | --- |
| 想不起还会做什么菜 | 搜索菜名，用分类标签和特点筛选菜品 |
| 家人分头想吃什么 | 家庭共享菜品库、点菜意向和已确认菜单 |
| 同一道菜每次做法不同 | 分别保存制作记录、本次做法与家庭主菜谱 |
| 想保留家人口述的经验 | 普通话录音转写，检查后整理成菜谱草稿 |
| 想看看以前怎么做的 | 查看只读菜谱历史版本 |
| 不小心删了菜 | 从回收站恢复，或选择彻底删除 |

## 口述做法，自己确认

家庭菜谱助手的流程是：

```text
多段普通话录音 / 文字补充
         ↓
检查并修改转写文本
         ↓
AI 整理食材、步骤、技巧与失败经验
         ↓
家人编辑、确认，保存为菜谱版本
```

AI 整理的结果是待确认草稿，不能自动覆盖正式菜谱。整理规则要求保留来源中的信息，对缺失或不确定的内容留空或作出标记；保存前仍需家人检查。

也可以直接手动填写菜谱。语音转写按普通话处理，当前没有方言模式。基础菜品、点菜、评价和手动菜谱不依赖 ASR 或 TokenHub Key；云端菜谱操作仍需要可用的 CloudBase 环境。

## 部署给自己的家庭使用

### 准备

- 微信开发者工具和自己的微信小程序 AppID。
- 腾讯云 CloudBase 环境，用于数据库、云函数和文件存储。
- Node.js 24，用于本地测试；云函数运行环境另按部署指南配置为 Node.js 20.19。
- 可选：腾讯云录音文件识别服务、TokenHub API Key，用于语音转写和 AI 整理。

### 导入和配置

1. 下载或克隆仓库，在微信开发者工具中导入**仓库根目录**。
2. 将 [project.config.json](project.config.json) 的 `appid` 改为自己的 AppID。
3. 将 [cloudbase.config.js](cloudbase.config.js) 的 `envId` 改为自己的环境 ID，并核对区域设置。
4. 创建下表中的数据库集合，部署 `cloudfunctions/` 下的 **`family-access` 和 `recipe-assistant` 两个云函数**，部署时安装各自依赖。
5. 按部署指南设置权限、索引和存储规则，再配置可选的 ASR 与 TokenHub。真实凭据只放在云函数环境中。
6. 在自己的体验版里完成双账号真机验收，再让家人使用。

仓库中的 AppID 和环境 ID 是项目配置示例，部署自己的版本时必须替换。

| CloudBase 资源 | 名称 |
| --- | --- |
| 基础家庭数据集合 | `family_states`、`family_states_events`、`family_members`、`family_invites` |
| 菜谱集合 | `recipe_recordings`、`recipe_drafts`、`family_recipes`、`recipe_versions`、`recipe_usage_daily` |
| 云函数 | `family-access`、`recipe-assistant` |

菜谱集合只允许管理端和云函数访问。详细的索引、音频上传规则、云函数环境变量、费用限制、隐私配置与回滚步骤见[第二阶段 CloudBase 部署清单](docs/cloudbase-phase-two-setup.md)。其中的项目环境和历史记录需要按自己的部署情况核对。

## 数据放在哪里

- 基础数据保存在当前设备，并通过 CloudBase 在家庭成员之间同步；云端暂时不可用时，可以继续查看已有本地基础数据。
- 云函数使用微信调用上下文中的 `OPENID` 和家庭成员关系检查访问权限。
- 家庭图片和原始录音按私有存储配置，通过云函数申请短时访问地址。
- 语音转写需要将录音交给腾讯云 ASR；AI 整理需要将转写文本交给 TokenHub 及所选模型处理。
- 正式菜谱必须由家庭成员确认，历史版本可只读查看。

跨设备同步、文件访问权限与录音处理依赖实际云端配置，部署后需要用不同账号验证。

## 开发与验收

项目使用原生微信小程序的 WXML、WXSS 和 JavaScript，后端采用 CloudBase 云函数。

```text
pages/                         菜品、点菜、家庭、回收站与菜谱页面
components/                    菜品卡片、菜谱编辑器、录音工作区
services/                      本地状态、家庭同步与菜谱服务
cloudfunctions/family-access/  家庭成员、邀请码、共享数据与图片访问
cloudfunctions/recipe-assistant/  录音、转写、草稿与菜谱版本
tests/                         领域逻辑、云函数与页面回归测试
```

在仓库根目录运行：

```sh
npm test
node scripts/smoke-check.js
```

自动化测试使用假服务，不会调用真实 ASR 或 TokenHub。它们不能代替微信设备、双账号同步和云端服务验收。

发布门槛状态：`待执行`

真实环境的验收步骤和证据表见[第二阶段双账号真机验收表](docs/qa/phase-two-dual-account-checklist.md)。

如需检查菜谱模型评测流程，可使用仓库中的脱敏样例：

```sh
node scripts/evaluate-recipe-models.js --fixture tests/fixtures/recipe-transcripts.sample.json --models hy3,deepseek-v4-flash --dry-run --out tests/fixtures/private/recipe-eval.json
```

`--dry-run` 不联网、不产生模型费用，也不代表真实模型效果。显式使用 `--live` 才会调用 TokenHub。真实家庭转写和评测结果应留在已被 Git 忽略的 `tests/fixtures/private/` 中。

## 继续了解

- [产品规格与数据边界](SPEC.md)
- [语音家庭菜谱助手设计](docs/superpowers/specs/2026-08-13-voice-recipe-assistant-design.md)

欢迎通过 Issue 反馈具体的做饭场景、操作问题和改进建议。请不要附上家庭成员信息、私密照片、录音或服务凭据。
