# adapter-telegram

Yunzai NG 的 Telegram 机器人适配器。经 Bot API 长轮询收消息，支持私聊与群聊、图片 / 语音 / 视频 /
文件、引用回复、内联按钮、群管理员判定。

## 安装

克隆到主目录的 `plugins/` 下，装依赖并编译：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-telegram.git
cd adapter-telegram
pnpm install --ignore-workspace
pnpm run build
```

然后在面板的插件页重载，或重启内核。`dist/` 不进 git，不编译就没有入口。

## 添加账号

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)：`/newbot` 创建机器人，得到 Token。
2. **关掉隐私模式**：`/mybots` → 选机器人 → Bot Settings → Group Privacy → Turn off。
   不关的话，群里只有 `/命令`、@机器人、回复机器人的消息会推给它 —— `#签到` 这类命令收不到。
   改完要把机器人移出群再拉回来才生效。
3. 面板 → 账号 → 添加账号 → 适配器选「Telegram」，粘贴 Token。国内网络在「连接」分组里填代理。

账号字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `token` | — | Bot Token，形如 `123456789:AAH…` |
| `proxy` | 空 | HTTP / HTTPS 代理，形如 `http://127.0.0.1:7890`；留空沿用全局代理 |
| `apiBase` | `https://api.telegram.org` | 反向代理或自建 Bot API 服务器的地址 |
| `timeout` | `60s` | 单次 API 调用超时（长轮询另有固定时长） |
| `photoMaxWidth` / `photoMaxHeight` | `1280` | 宽或高超过的图片改以文件发送，免得被压糊 |
| `adminCacheTtl` | `10m` | 群管理员列表的缓存时长 |

## 使用

- **id 带 `tg_` 前缀**：用户 `tg_<用户id>`，群 `tg_-100…`。`bot.masterQQ` 里填
  `tg_<你的用户 id>` 即成为主人。
- **消息 id 是 `会话id:消息id`**（如 `-1001234:56`），撤回与引用都靠它定位会话。
- **群管理员。** 群主为 `owner`，管理员为 `admin`，`e.isGroupAdmin` 可用；匿名管理员也算 admin。
- **收到的媒体是 file_id**（`kind: "id"`）。要内容时调 `bot.getFileUrl(id)` 取下载地址；
  原样发回 Telegram 时零传输。下载地址里含 Token，不要写进日志或发到别处。
- **@ 某人。** 对方有用户名时发 `@用户名`，没有时发名字并附提及 —— 都会通知到对方。
  机器人只认得给它发过消息的人。
- **按钮。** 键盘段编码为内联按钮，`callback` 与 `input` + `enter` 点击后作为该用户发言投递
  （`subType: "button"`，`e.quote` 指向按钮所在的消息）；`input` 不 `enter` 时弹窗提示用户手动发送；
  `link` 跳转链接。按钮总是挂在一次回复的最后一条消息上。
- **话题群。** 回复会落到对方所在的话题。
- **平台原生调用。** `seg.raw("telegram", "sendPoll", { question, options })` 在当前会话里调任意方法；
  `bot.callApi("getChatMemberCount", { chat_id })` 直接调 Bot API。

命令：`#TG账号` 列出各账号状态（Token 脱敏，仅主人）。`#TG设置` / `#TG代理` / `#TG反代`
改为指引到面板。

能力（`bot.caps`）：`recall`、`keyboard`、`getFileUrl`、`groupMute`、`groupWholeMute`、`groupKick`。
另实现了 `quitGroup`。

## 已知限制

- **没有好友列表与群列表接口。** `getFriendList()` / `getGroupList()` 返回机器人见过的私聊与群
  （记在账号的 KV 里，被踢、被拉黑时移除）。新加的账号在收到消息前两张表都是空的。
- **`getGroupMemberList()` 只返回管理员。** Bot API 不能枚举普通成员。
- **不能拉历史消息、不能按 id 取消息。** 引用的内容来自事件本身。
- **合并转发被摊平**成逐条消息；`markdown` 段按原文发出，不渲染；`@全体`、QQ 表情、戳一戳没有对应物，会被丢弃。
- **超过 20MB 的文件** 取不到下载地址，需要自建 Bot API 服务器（填进 `apiBase`）。
- **话题群里并发回复**：没有引用时按该群「最近一条消息所在的话题」发，两个话题同时有人用命令时可能落错。
- 一个 Token 同时只能被一个程序轮询；设置了 Webhook 的机器人连不上（需先 `deleteWebhook`）。

## 开发

依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`（`peerDependencies`）。框架发布到 npm 之前需先
链接本地框架 checkout，且框架要先 `pnpm run build`：

```powershell
pnpm install --ignore-workspace
pnpm run link:framework # 按 YZNG_FRAMEWORK → ../yunzai-ng → ../../yunzai-ng 查找
pnpm run verify         # build → typecheck:test → lint → test
```

插件直接放在框架仓库的 `plugins/` 下开发时，需显式指定框架位置：
`$env:YZNG_FRAMEWORK = "<框架仓库根>"`。`--ignore-workspace` 不能省：框架的工作区包含
`plugins/*`，不加的话 pnpm 会改写框架自己的 `pnpm-lock.yaml`。

## 许可

AGPL-3.0-or-later
