# 第二阶段 CloudBase 部署清单

本文用于把开发分支中的“制作过程录音、普通话转写、AI 整理和家庭菜谱版本”部署到测试环境。它不是已完成部署或真机验收的证明；完成本文后仍需执行双账号真机验收表。

目标配置：

```text
AppID: wx6e247df29f902c68
CloudBase 环境: home-daily-diet-d8f5e7d6907dd53a
区域: ap-shanghai
云函数: recipe-assistant
运行时: Node.js 20.19
入口: index.main
```

截至 2026-08-19，测试环境已完成：五个集合创建、`ADMINONLY` 权限、五个业务复合索引、`recipe-assistant` 部署，以及四个非敏感默认环境变量。仍待完成的是 `TOKENHUB_API_KEY`、外部服务启用/权限确认和双账号真机验收。

## 0. 部署前检查

- [ ] 确认当前操作的是测试环境，并导出或备份现有 `family_states` 数据。
- [ ] 确认 `npm test` 与 `node scripts/smoke-check.js` 在本地通过。
- [ ] 不把真实 Key 写入 `.env.example`、截图、Git、聊天记录或小程序代码。
- [ ] 不把 `cloudfunctions/recipe-assistant/node_modules` 提交到 Git；部署包必须严格依据 `package-lock.json` 安装或打包依赖。

## 1. 创建五个服务端集合

在 CloudBase 控制台的“数据库 → 集合管理”中创建：

```text
recipe_recordings
recipe_drafts
family_recipes
recipe_versions
recipe_usage_daily
```

每个集合都选择“仅管理端可读写／无客户端权限”。如使用自定义安全规则，数据库规则保持：

```json
{
  "read": false,
  "write": false
}
```

这样小程序不能绕过 `recipe-assistant` 直接枚举家庭菜谱、转写或用量记录；云函数和控制台仍可管理数据。

### 建议索引

按控制台的索引建议创建下列升序复合索引，字段名称必须与代码一致：

- `recipe_recordings`: `familyId + dishId + recordId + sequence`
- `recipe_recordings`: `sourceType + draftExpiresAt`（机会式清理查询）
- `recipe_drafts`: `familyId + dishId + recordId`
- `recipe_drafts`: `draftExpiresAt`
- `recipe_versions`: `familyId + dishId + versionNumber`

`family_recipes` 和 `recipe_usage_daily` 主要通过确定性 `_id` 读取。若控制台在测试日志中给出新的索引建议，先核对查询字段，再创建索引；不要通过放宽数据权限规避索引错误。

## 2. 创建或更新云函数

1. 创建普通事件云函数 `recipe-assistant`，不要创建 HTTP 云函数。
2. 运行环境选择 `Node.js 20.19`，执行入口填写 `index.main`。
3. 上传整个 `cloudfunctions/recipe-assistant/` 目录。
4. 微信开发者工具部署时选择“上传并部署：云端安装依赖”；自动化部署也可以按 `package-lock.json` 预装依赖后上传，并关闭远程安装。当前测试环境采用后一种方式。
5. 确认函数详情页能看到 `$LATEST` 部署成功，再进行调用测试。
6. 云函数调用权限只允许已登录、非匿名用户；业务层仍会使用微信调用上下文中的 `OPENID` 再校验家庭成员身份。

## 3. 配置环境变量

在云函数控制台配置以下变量。真实值只保存在云函数环境中：

```text
TOKENHUB_API_KEY=<TokenHub API Key>
RECIPE_MODEL=hy3
RECIPE_PROMPT_VERSION=v1
ASR_REGION=ap-shanghai
ASR_ENGINE=16k_zh

# 仅当 SCF 内置临时凭据不可用时配置以下备用项
ASR_SECRET_ID=<最小权限凭据 ID>
ASR_SECRET_KEY=<最小权限凭据 Key>
ASR_SESSION_TOKEN=<使用临时凭据时填写；长期凭据留空>
```

`TOKENHUB_API_KEY` 是 AI 整理必需的私密项。其余四个非敏感值已有代码默认值，但建议在云函数环境中显式配置。SCF 运行时会注入临时腾讯云凭据，代码优先使用它们；只有运行身份不可用时才成对配置 `ASR_SECRET_ID` 与 `ASR_SECRET_KEY`，临时备用凭据再附带 `ASR_SESSION_TOKEN`。代码只识别普通话 `16k_zh`，不尝试识别温州话或自动选择方言模型。

## 4. 开通外部服务

### 腾讯云录音文件识别

- [ ] 开通语音识别服务。
- [ ] 云函数运行身份仅允许录音文件识别所需的 `CreateRecTask` 和 `DescribeTaskStatus`；如改用备用凭据，也保持同样的最小权限。
- [ ] 固定区域 `ap-shanghai`、引擎 `16k_zh`。
- [ ] 不启用实时转写、说话人分离、情绪识别等额外能力。

代码使用异步录音文件识别：先创建任务，再轮询结果；ASR `TaskId` 只作为短期查询标识，不作为业务主键。

### TokenHub

- [ ] 开通 TokenHub 并创建独立 API Key。
- [ ] 默认模型保持 `hy3`，接口为 OpenAI 兼容的 Chat Completions。
- [ ] 首次上线不配置 Kimi，也不自动切换到 DeepSeek。
- [ ] 如人工改成其他下游模型，先同步更新隐私说明，再重新做模型评测和真机验收。

## 5. 最小权限与文件边界

- [ ] 云函数运行身份只读访问 `family_members` 和 `family_states`，用于校验家庭成员、菜品与制作记录；读写上述五个第二阶段集合。它不需要改写两个既有家庭集合。
- [ ] 录音上传遵循“服务端预留、小程序上传、服务端确认”：`reserveRecording` 返回唯一目标路径，小程序随后调用 `wx.cloud.uploadFile`，最后由 `submitRecording` 校验 `fileId`、预留记录、MP3 类型和文件元数据。
- [ ] 存储规则对已登录小程序客户端仅允许上传（含同一路径失败重试）到 `families/*/recipe-audio/*.mp3`；客户端不能列举、读取或删除该目录。播放短时 URL 与删除都由云函数完成。
- [ ] 路径规则只是第一道边界，不能代替业务授权；部署后必须真机验证未预留路径、其他家庭路径和非 MP3 文件均无法通过 `submitRecording`。
- [ ] 用伪造的另一家庭 `fileId` 调用时必须得到 `FILE_ACCESS_DENIED`，不能返回路径或短时 URL。
- [ ] 日志中只能出现 action、错误码、requestId、耗时和用量，不出现完整转写、菜谱正文、OpenID、Key 或短时 URL。

如果账号体系或 CloudBase 套餐不支持细分运行角色，五个数据库集合仍保持客户端拒绝；存储只开放上述受限上传路径，其余授权检查全部经过云函数。不要为了调试把数据库或音频改成公开读写。

## 6. 预算与硬限制

- [ ] 在 CloudBase、语音识别和 TokenHub 分别设置月预算。
- [ ] 设置 50%、80%、100% 三档费用告警。
- [ ] 确认服务端仍限制每段 3 分钟、每次制作 10 段/15 分钟、每家庭每日 ASR 60 分钟和 AI 整理 20 次。
- [ ] 达到硬限制时请求应被应用拒绝，不进行隐藏重试或自动切换付费模型。

## 7. 更新微信隐私保护指引

在小程序后台更新隐私保护指引和对应隐私弹窗，至少说明：

- 使用麦克风记录家庭做菜过程；拒绝授权时仍可手动输入。
- 原始语音会上传到家庭私有云存储并默认保留。
- 腾讯云语音识别会处理语音并生成普通话转写。
- TokenHub 及当前下游模型会处理转写文本并生成待确认草稿。
- AI 结果不会自动覆盖正式菜谱，必须由家庭成员确认。
- 用户可以删除单段原始语音；菜品彻底删除后会清理菜谱附件，用量审计记录按既定规则保留。

完成后台配置后，用首次录音场景验证：先展示用途说明，再请求麦克风权限；未同意时不能静默开始录音。

## 8. 降级与回滚验证

依次在测试环境验证：

1. 缺少 `TOKENHUB_API_KEY`：基础菜品、点菜、评价和手动菜谱可用；AI 整理显示未配置且不丢文本。
2. 缺少 ASR 凭据：文字片段和手动菜谱可用；录音转写显示未配置。
3. 临时断网：已有本地基础数据可继续查看；云端菜谱操作明确提示需要联网。
4. 回滚小程序版本时不删除五个集合或音频；先恢复上一稳定代码，再保留数据供后续迁移。

## 9. 部署后验证

- [ ] 运行 `npm test`、`node scripts/smoke-check.js` 和全部 JavaScript 语法检查。
- [ ] 上传测试体验版，不直接标记为正式发布。
- [ ] 按 `docs/qa/phase-two-dual-account-checklist.md` 使用两个微信账号真机验收。
- [ ] 所有 P0/P1 用例通过前，README 继续标记第二阶段为“开发分支、未发布”。

## 官方参考

- [CloudBase：在微信小程序中调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)
- [CloudBase：数据库基础权限](https://docs.cloudbase.net/database/data-permission)
- [CloudBase：安全规则示例](https://docs.cloudbase.net/rule/rule-example)
- [CloudBase：云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)
- [腾讯云 ASR：API 概览](https://cloud.tencent.com/document/product/1093/134682)
- [腾讯云 ASR：任务数据结构](https://cloud.tencent.com/document/product/1093/37824)
- [腾讯云 TokenHub：迁移与接入地址](https://cloud.tencent.com/document/product/1823/131382)
