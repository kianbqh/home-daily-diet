# 今天想吃啥 · 微信小程序

这是一个面向家庭使用的菜品记录与选餐小程序。家人先把做过的菜记录到菜品库，再从已有菜品中提交今天想吃什么；不包含公开社区或内置聊天。

## 0.1.1 更新

- 修复 CloudBase 初始化失败时家庭页空白、人数缺失和保存按钮不可用的问题。
- 云端不可用时自动保留本地模式，家庭名称、称呼和菜品记录仍可使用。
- 增加“正在连接、已连接、连接失败、本地模式”四种同步状态。
- 修复首次保存只有事件、没有主文档时无法重新读取家庭状态的问题。
- 自动修复旧版本遗留的不完整本地状态，无需清缓存或重新录入已有数据。
- 家庭页显示统一为“家庭名称 + N 位家庭成员”，输入框可正常编辑。
- “记录一道菜”仍只要求菜名，图片可选，不显示评价或备注输入。

## 项目配置

- 项目目录：`G:\home_daily_diet`
- AppID：`wx6e247df29f902c68`
- CloudBase 环境：`home-daily-diet-d8f5e7d6907dd53a`
- 状态集合：`family_states`
- 事件集合：`family_states_events`
- 图片目录前缀：`family-meals/`

## CloudBase 控制台

如果这个环境最初是在腾讯云 CloudBase 网页端创建的，必须先在 CloudBase 账号中心绑定当前微信小程序账号，再回到微信开发者工具选择或转换该环境；仅有 EnvId 不代表 `wx.cloud` 已经获得访问资格。

在当前环境的“数据库”中确认存在以下两个集合：

1. `family_states`
2. `family_states_events`

云存储不需要预先创建 `family-meals/` 目录，首次上传菜品图片时会自动产生对应路径。

开发联调时，集合规则必须允许小程序客户端完成读取、写入和新增事件。不要把“所有用户可读写”作为正式长期规则；当前客户端直连模式还不能严格证明访问者属于某个家庭。正式扩大使用范围前，应把家庭状态读写迁移到校验微信 OpenID 和家庭成员关系的云函数中。

官方参考：[创建并绑定云开发环境](https://docs.cloudbase.net/quick-start/create-env)、[数据库集合与权限](https://docs.cloudbase.net/database/introduce)、[数据库安全规则](https://docs.cloudbase.net/database/security-rules)。

## 本地验证

在项目根目录运行：

```powershell
npm test
node scripts/smoke-check.js
node --check app.js
node --check services/app-bootstrap.js
node --check services/cloudbase-sync.js
node --check services/app-store.js
node --check pages/family/family.js
```

## 上传 0.1.1

1. 用微信开发者工具打开 `G:\home_daily_diet`。
2. 确认工具中的 AppID 和 CloudBase 环境与上方配置一致。
3. 编译后检查家庭页：显示家庭名称、`1 位家庭成员`，名称与称呼都可输入和保存。
4. 在控制台确认同步状态为“已连接家庭云端”；若显示失败，先检查两个集合及权限。
5. 点击“上传”，版本号填写 `0.1.1`。
6. 版本说明填写：`修复 CloudBase 初始化失败导致家庭页空白，完善云端同步状态与首次保存。`

备案与 CloudBase 是否连接是两件事。未完成备案不会让家庭页自动进入本地模式；页面的同步状态由小程序运行时能否初始化并访问 CloudBase 决定。
