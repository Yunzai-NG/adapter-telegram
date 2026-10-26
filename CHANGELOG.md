# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.1.0 — 未发布

### 新增

- Bot API 长轮询：offset 持久化（重连、重启不重复投递），偶发失败自行退避，token 失效 / 409 冲突
  经 `setStatus("offline")` 交给内核退避重连。连接时检查 Webhook。
- HTTP 一律走 `ctx.http`，每个账号可单独设代理与 API 基址；只对 429 等待重试一次，其余不重试以免重复发送。
- 收：文字 / 图片 / 贴纸 / GIF / 视频 / 语音 / 音乐 / 文件 / 位置 / 骰子 / 引用；`@用户名` 与
  `text_mention` 成 at 段，群里 `/命令@本机器人` 去掉后缀。成员进出为 `group.increase` / `group.decrease`。
- 发：文字（entities，不用 parse_mode）、@、链接、图片（超尺寸改文件、GIF 走 animation）、语音、视频、
  文件、位置、骰子、内联按钮、引用、话题群；长文按 4096 码元切分且不切开实体。
- 按钮回调还原为消息；长数据存 KV，`callback_data` 不超过 64 字节。
- 群角色：群主 → owner，管理员 → admin（管理员表带缓存）。
- 撤回、禁言 / 全员禁言 / 踢人 / 退群、`getFileUrl`、`callApi`。
- `#TG账号` 列出账号状态（Token 脱敏）；`#TG设置` / `#TG代理` / `#TG反代` 指引到面板。

### 注意

- 错误信息里的 Token 一律替换为 `[REDACTED]`（Bot API 把 Token 放在 URL 路径里，内核的打码管不到）。
- 收到的媒体只给 file_id，不给下载地址：下载地址里含 Token。机器人自己的头像由 `getSelfInfo()`
  经账号代理下载后以 `data:` URL 给出（缓存一小时）。

57 条用例。
