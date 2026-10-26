/**
 * 模块职责：`BotDriver` 实现 —— 把一个 Telegram 机器人接成内核的一个账号
 * 依赖方向：依赖 api / poller / encode / events / media / platform 与类型包、内核的公开入口
 * 生命周期：一次连接一个实例；`connect()` 与 `disconnect()` 各调用一次（重连由内核新建实例）
 * 注意事项：**一、拆除挂两条路。** `host.signal` 一 abort 轮询就停（插件卸载走同步的
 *          `detachAdapter()`，`disconnect()` 要稍后才被调用）；`disconnect()` 再停一次，幂等。
 *
 *          **二、轮询在 `connect()` 末尾启动。** 宿主在 Bot 门面就绪前收到的事件一律丢弃，而积压的更新
 *          会在第一次 `getUpdates` 里立刻回来。`connect()` 解析到门面就绪之间没有任何 await，
 *          第一次请求的回包必然晚于它 —— 但若把启动挪到某个 await 之后，积压的消息就会被丢掉。
 *
 *          **三、Bot API 没有"好友列表"与"群列表"。** 机器人只能知道给它发过消息的人、拉它进过的群。
 *          故把见过的会话记进账号的 KV（`chats:` 下），被踢、被拉黑时删掉；`getFriendList()` /
 *          `getGroupList()` 返回这张表 —— 按群广播的插件（推送、签到提醒）才有目标可发。
 *
 *          **四、话题群（forum）。** 发在话题里的消息要带 `message_thread_id`，否则落到"General"。
 *          内核的发送目标里只有群 id，故记下"每条消息在哪个话题"与"每个群最近一次在哪个话题"：
 *          引用回复时用被引用消息的话题，否则用该群最近的话题。并发时可能落错话题，见 README。
 */
import type {
  AdapterHost,
  BotCapability,
  BotDriver,
  GroupInfo,
  GroupRole,
  HttpClient,
  MemberInfo,
  MemberListOptions,
  MessageContent,
  Segment,
  SendOptions,
  SendResult,
  SendTarget,
  UserInfo
} from "@yunzai-ng/types"
import { readFile } from "node:fs/promises"
import { parseDuration, seg, toSegments } from "@yunzai-ng/core"
import { createTelegramApi, TelegramApiError } from "./api.js"
import type { TelegramApi } from "./api.js"
import type { ButtonAction } from "./callback.js"
import { encodeCallback } from "./callback.js"
import type { TelegramAccount } from "./config.js"
import { displayName, toUser } from "./decode.js"
import { encodeMessage } from "./encode.js"
import type { EncodeDeps, InlineButton, MentionTarget, OutgoingOp } from "./encode.js"
import { chatTitle, decodeUpdate, isGroupChat, toGroup, usersOf } from "./events.js"
import type { EventContext } from "./events.js"
import { imageSize, loadMedia, sniffMime } from "./media.js"
import type { UploadFile } from "./media.js"
import { Poller } from "./poller.js"
import type { PollerTimings } from "./poller.js"
import { PLATFORM, decodeMessageId, encodeMessageId, fromId, toId } from "./platform.js"
import type { TgChat, TgChatMember, TgChatPermissions, TgFileInfo, TgMessage, TgPhotoSize, TgUpdate, TgUser } from "./types.js"

/**
 * 本适配器声明的可选能力
 *
 * 不给 `forward`：Telegram 没有合并转发，转发段在发送时被摊平（见 encode.ts）。不给 `markdown`：
 * `markdown` 段按原文发出，不渲染（见 encode.ts 文件头第一点）。不给 `groupCard`：Telegram 没有
 * 群名片，只有管理员头衔。不给 `fetchHistory`：Bot API 不能拉历史消息。
 */
const CAPS: readonly BotCapability[] = ["recall", "keyboard", "getFileUrl", "groupMute", "groupKick", "groupWholeMute"]

/** sendPhoto 的字节上限 */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024

/** sendPhoto 的宽高之和上限 */
const PHOTO_MAX_SUM = 10_000

/** sendPhoto 的长宽比上限 */
const PHOTO_MAX_RATIO = 20

/**
 * offset 的保存期
 *
 * Telegram 只保留 24 小时内未取走的更新，且机器人闲置约一周后 update_id 会重新随机起号 ——
 * 那时一个旧的大 offset 会让新更新永远取不到。存六天，过期即从头取，丢不了什么。
 */
const OFFSET_TTL = "6d"

/** 按钮长数据的保存期 */
const CALLBACK_TTL = "30d"

/** 自己的头像缓存多久 */
const AVATAR_TTL = 3_600_000

/** 头像取哪一档：不小于这个宽度的最小一档 */
const AVATAR_SIZE = 160

/** 只有按钮、没有正文时补的占位文字 */
const KEYBOARD_PLACEHOLDER = "请选择"

/** 能发成语音条的 MIME；其余音频以文件发送 */
const VOICE_MIMES = new Set(["audio/ogg", "audio/mpeg", "audio/mp4"])

/** 驱动的外部依赖 */
export interface TelegramBotDeps {
  /** 适配器 id */
  adapterId: string
  /** 插件的 HTTP 客户端（`ctx.http`） */
  http: HttpClient
  /** 轮询时间参数；测试里调小 */
  timings?: Partial<PollerTimings>
}

/** KV 里记下的一个会话 */
interface KnownChat {
  /** 会话类型 */
  type: string
  /** 群名或对方名字 */
  title: string
}

/** 群管理员表：用户原始 id → 角色 */
type AdminTable = Record<string, GroupRole>

/** 全部开放的群权限（解除禁言、无从恢复原设置时用） */
const ALL_ALLOWED: TgChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true
}

/** 禁止发言的群权限：只关发送类，改群信息、邀请这几项不在禁言的语义里 */
const ALL_DENIED: TgChatPermissions = Object.fromEntries(Object.keys(ALL_ALLOWED).map(key => [key, false]))

/**
 * Bot API 的文件类型名 → 发送方法与字段
 *
 * 用 file_id 发送时，类型必须对得上（拿贴纸的 id 调 sendPhoto 会被拒）。平台的报错里会说出
 * 实际类型（"can't use file of type Sticker as Photo"），据此换一个方法再发一次。
 */
const METHOD_BY_FILE_TYPE: Readonly<Record<string, readonly [string, string]>> = {
  Photo: ["sendPhoto", "photo"],
  Document: ["sendDocument", "document"],
  Audio: ["sendAudio", "audio"],
  Voice: ["sendVoice", "voice"],
  Video: ["sendVideo", "video"],
  Animation: ["sendAnimation", "animation"],
  Sticker: ["sendSticker", "sticker"],
  VideoNote: ["sendVideoNote", "video_note"]
}

/**
 * 发送目标 → chat_id
 * @param target 发送目标
 * @returns 原始 chat_id
 */
export function chatIdOf(target: SendTarget): string {
  switch (target.scene) {
    case "group":
      return fromId(target.gid)
    case "private":
      return fromId(target.uid)
    case "guild":
      return fromId(target.channelId)
  }
}

/**
 * 成员状态 → 角色
 * @param status ChatMember.status
 * @returns 角色
 */
export function roleOfStatus(status: string): GroupRole {
  if (status === "creator") return "owner"
  if (status === "administrator") return "admin"
  return "member"
}

/**
 * 取错误文案
 * @param err 错误
 * @returns 文案
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 是否 Bot API 返回的一条消息
 * @param value 返回值
 * @returns 是否带 message_id
 */
function isMessage(value: unknown): value is TgMessage {
  return typeof value === "object" && value !== null && typeof (value as { message_id?: unknown }).message_id === "number"
}

/**
 * 能否以 sendPhoto 发出（否则改以文件发送，见 config.ts 的 photoMaxWidth）
 * @param file 文件
 * @param maxWidth 配置的宽上限
 * @param maxHeight 配置的高上限
 * @returns 是否发成图片
 */
export function fitsPhoto(file: UploadFile, maxWidth: number, maxHeight: number): boolean {
  if (file.data.byteLength > PHOTO_MAX_BYTES) return false
  const size = imageSize(file.data)
  // 认不出尺寸就先按图片发，被拒再退成文件（见 sendMedia）
  if (size === undefined) return true
  if (size.width > maxWidth || size.height > maxHeight) return false
  if (size.width + size.height > PHOTO_MAX_SUM) return false
  const ratio = Math.max(size.width, size.height) / Math.max(1, Math.min(size.width, size.height))
  return ratio <= PHOTO_MAX_RATIO
}

/**
 * 成员状态 → 成员信息
 * @param member 成员状态
 * @param chatId 群原始 id
 * @returns 成员信息；已退群 / 被踢时 undefined
 */
function toMember(member: TgChatMember, chatId: string): MemberInfo | undefined {
  if (member.status === "left" || member.status === "kicked") return undefined
  const info: MemberInfo = { ...toUser(member.user), gid: toId(chatId), role: roleOfStatus(member.status) }
  if (member.custom_title !== undefined && member.custom_title !== "") info.title = member.custom_title
  return info
}

/**
 * 私聊会话 → 用户对象（`text_mention` 实体要一个 User）
 * @param chat 私聊会话
 * @returns 用户
 */
function chatToUser(chat: TgChat): TgUser {
  return { id: chat.id, is_bot: false, first_name: chat.first_name ?? chat.username ?? String(chat.id), last_name: chat.last_name, username: chat.username }
}

/**
 * 创建一个 Telegram 账号驱动
 * @param account 已校验的账号配置
 * @param host 内核提供的宿主能力
 * @param deps 外部依赖
 * @returns 账号驱动（尚未连接）
 */
export function createTelegramBot(account: TelegramAccount, host: AdapterHost, deps: TelegramBotDeps): BotDriver {
  const timeout = parseDuration(account.timeout, 60_000)
  const api: TelegramApi = createTelegramApi({
    http: deps.http,
    base: account.apiBase,
    token: account.token,
    proxy: account.proxy,
    timeout,
    signal: host.signal,
    logger: host.logger
  })

  /** 群管理员表 */
  const admins = host.createCache<AdminTable>({ max: 500, ttl: parseDuration(account.adminCacheTtl, 600_000) })
  /** 群成员 */
  const members = host.createCache<MemberInfo>({ max: 2000, ttl: "5m" })
  /** 见过的用户：原始 id → 用户 */
  const users = host.createCache<TgUser>({ max: 5000, ttl: "1d" })
  /** 用户名（小写）→ 原始 id */
  const usernames = host.createCache<number>({ max: 5000, ttl: "1d" })
  /** 已写进 KV 的会话标题：免得每条消息都写一次 */
  const knownTitles = host.createCache<string>({ max: 5000, ttl: "1h" })
  /** 群最近一次所在的话题；0 为 General */
  const chatThreads = host.createCache<number>({ max: 2000, ttl: "1h" })
  /** 每条消息所在的话题（见文件头第四点） */
  const msgThreads = host.createCache<number>({ max: 5000, ttl: "1h" })

  const chatsKv = host.kv.sub("chats")
  const callbackKv = host.kv.sub("cb")

  let self: TgUser | undefined
  let selfId = host.account.selfId ?? ""
  let nickname = ""
  let poller: Poller | undefined
  /** `disconnect()` 已调用 */
  let stopped = false

  /**
   * 取群管理员表（带缓存）
   * @param chatId 群原始 id
   * @returns 管理员表；查不到时为空表（同样缓存，免得每条消息都重查）
   */
  const adminTable = async (chatId: number | string): Promise<AdminTable> =>
    (await admins.fetch(String(chatId), async () => {
      try {
        const list = await api.call<TgChatMember[]>("getChatAdministrators", { chat_id: chatId })
        return Object.fromEntries(list.map(m => [String(m.user.id), roleOfStatus(m.status)]))
      } catch (err) {
        host.logger.debug(`查询群 ${chatId} 的管理员失败：${errText(err)}`)
        return {}
      }
    })) ?? {}

  /**
   * 记下一个会话（见文件头第三点）
   * @param chat 会话
   */
  const rememberChat = (chat: TgChat): void => {
    if (chat.type === "channel") return
    const key = String(chat.id)
    const title = chatTitle(chat)
    if (knownTitles.get(key) === title) return
    knownTitles.set(key, title)
    const value: KnownChat = { type: chat.type, title }
    chatsKv.set(key, value).catch((err: unknown) => host.logger.debug(`记录会话 ${key} 失败：${errText(err)}`))
  }

  /**
   * 忘掉一个会话（被踢、被拉黑）
   * @param chatId 会话原始 id
   */
  const forgetChat = (chatId: number): void => {
    const key = String(chatId)
    knownTitles.delete(key)
    admins.delete(key)
    chatsKv.del(key).catch((err: unknown) => host.logger.debug(`删除会话 ${key} 失败：${errText(err)}`))
  }

  /**
   * 记下见过的用户
   * @param user 用户
   */
  const rememberUser = (user: TgUser): void => {
    users.set(String(user.id), user)
    if (user.username !== undefined && user.username !== "") usernames.set(user.username.toLowerCase(), user.id)
  }

  const eventCtx: EventContext = {
    get selfId(): number {
      return self?.id ?? 0
    },
    get selfUsername(): string {
      return self?.username ?? ""
    },
    idOfUsername: username => usernames.get(username.toLowerCase()),
    roleOf: async (chatId, userId) => (await adminTable(chatId))[String(userId)] ?? "member",
    loadCallback: key => callbackKv.get<ButtonAction>(key)
  }

  /**
   * 处理一个更新（轮询器串行调用）
   * @param update 更新
   */
  const onUpdate = async (update: TgUpdate): Promise<void> => {
    if (host.signal.aborted || stopped) return
    for (const user of usersOf(update)) rememberUser(user)

    const msg = update.message
    if (msg !== undefined) {
      rememberChat(msg.chat)
      if (msg.chat.is_forum === true) {
        const thread = msg.is_topic_message === true ? (msg.message_thread_id ?? 0) : 0
        chatThreads.set(String(msg.chat.id), thread)
        msgThreads.set(encodeMessageId(msg.chat.id, msg.message_id), thread)
      }
      const left = msg.left_chat_member
      if (left !== undefined) {
        members.delete(`${msg.chat.id}:${left.id}`)
        if (left.id === self?.id) forgetChat(msg.chat.id)
      }
      for (const user of msg.new_chat_members ?? []) members.delete(`${msg.chat.id}:${user.id}`)
    }

    const mine = update.my_chat_member
    if (mine !== undefined) {
      const status = mine.new_chat_member.status
      if (status === "left" || status === "kicked") forgetChat(mine.chat.id)
      else rememberChat(mine.chat)
      // 机器人自己被任免管理员：管理员表随之失效
      admins.delete(String(mine.chat.id))
    }

    const decoded = await decodeUpdate(update, eventCtx)
    if (decoded.answer !== undefined) {
      api.call("answerCallbackQuery", { ...decoded.answer }).catch((err: unknown) => host.logger.debug(`应答按钮回调失败：${errText(err)}`))
    }
    if (host.signal.aborted || stopped) return
    for (const event of decoded.events) host.submit(event)
  }
  /**
   * 解析 @ 的目标（见 encode.ts 文件头第二点）
   * @param uid 框架用户 id
   * @param name at 段自带的展示名
   * @returns 正文与实体
   */
  const mention = async (uid: string, name: string | undefined): Promise<MentionTarget> => {
    const raw = fromId(uid)
    if (!/^\d+$/.test(raw)) return { text: `@${name ?? raw}` }
    let user = users.get(raw)
    if (user === undefined) {
      // 没见过的人：查一次。只有对方私聊过机器人才查得到，查不到就只写名字
      try {
        const chat = await api.call<TgChat>("getChat", { chat_id: raw })
        if (chat.type === "private") {
          user = chatToUser(chat)
          rememberUser(user)
        }
      } catch (err) {
        host.logger.debug(`查询用户 ${uid} 失败：${errText(err)}`)
      }
    }
    if (user?.username !== undefined && user.username !== "") return { text: `@${user.username}`, entity: { type: "mention" } }
    const text = name ?? displayName(user) ?? raw
    return { text, entity: { type: "text_mention", user: user ?? { id: Number(raw), is_bot: false, first_name: text } } }
  }

  const encodeDeps: EncodeDeps = {
    mention,
    callback: action => encodeCallback(action, (key, value) => callbackKv.set(key, value, { ttl: CALLBACK_TTL }))
  }

  /**
   * 下载外链
   *
   * 一般走全局代理而不是账号的 Telegram 代理：外链多半是国内的图床。例外是 `getFileUrl()` 给出的
   * Telegram 文件地址被插件原样传回来 —— 那只有经账号代理才连得上。
   * @param url 地址
   * @param headers 额外请求头
   * @returns 字节
   */
  const download = (url: string, headers?: Record<string, string>): Promise<Uint8Array> =>
    deps.http.buffer(url, {
      timeout: Math.max(timeout, 30_000),
      signal: host.signal,
      ...(headers === undefined ? {} : { headers }),
      ...(account.proxy !== "" && url.startsWith(`${account.apiBase}/`) ? { proxy: account.proxy } : {})
    })

  /**
   * 以 file_id 发送；类型对不上时按平台报出的类型换方法重发一次
   * @param method 首选方法
   * @param field 首选字段
   * @param id file_id（或 http 地址）
   * @param base 公共参数
   * @returns 平台返回
   */
  const sendById = async (method: string, field: string, id: string, base: Record<string, unknown>): Promise<unknown> => {
    try {
      return await api.call(method, { ...base, [field]: id })
    } catch (err) {
      const type = err instanceof TelegramApiError && err.code === 400 ? /of type (\w+)/.exec(err.message)?.[1] : undefined
      const alt = type === undefined ? undefined : METHOD_BY_FILE_TYPE[type]
      if (alt === undefined || alt[0] === method) throw err
      return api.call(alt[0], { ...base, [alt[1]]: id })
    }
  }

  /**
   * 发一个媒体
   * @param op 媒体调用
   * @param base 公共参数（chat_id、引用、按钮）
   * @returns 平台返回
   */
  const sendMedia = async (op: Extract<OutgoingOp, { kind: "media" }>, base: Record<string, unknown>): Promise<unknown> => {
    const loaded = await loadMedia(op.ref, op.media, op.name, download)
    if (loaded.kind === "id") {
      const [method, field] =
        op.media === "image" ? ["sendPhoto", "photo"] : op.media === "video" ? ["sendVideo", "video"] : op.media === "audio" ? ["sendVoice", "voice"] : ["sendDocument", "document"]
      return sendById(method, field, loaded.id, base)
    }
    const file = loaded.file
    switch (op.media) {
      case "image": {
        // GIF 走 sendPhoto 会变成静态图
        if (file.mime === "image/gif") return api.call("sendAnimation", base, { animation: file })
        if (!fitsPhoto(file, account.photoMaxWidth, account.photoMaxHeight)) return api.call("sendDocument", base, { document: file })
        try {
          return await api.call("sendPhoto", base, { photo: file })
        } catch (err) {
          // 尺寸认不出、或平台另有限制（PHOTO_INVALID_DIMENSIONS）：退成文件。被拒的请求没有发出去，重发不会重复
          if (!(err instanceof TelegramApiError) || err.code !== 400) throw err
          host.logger.debug(`图片被拒（${err.message}），改以文件发送`)
          return api.call("sendDocument", base, { document: file })
        }
      }
      case "audio":
        // 语音条只认 OGG/OPUS、MP3、M4A；SILK、AMR 这类 QQ 格式只能当文件发
        return VOICE_MIMES.has(file.mime) ? api.call("sendVoice", base, { voice: file }) : api.call("sendDocument", base, { document: file })
      case "video":
        return api.call("sendVideo", base, { video: file })
      case "file":
        return api.call("sendDocument", base, { document: file })
    }
  }

  /**
   * 执行一次调用
   * @param op 调用
   * @param base 公共参数
   * @returns 平台返回
   */
  const execute = (op: OutgoingOp, base: Record<string, unknown>): Promise<unknown> => {
    switch (op.kind) {
      case "text":
        return api.call("sendMessage", { ...base, text: op.text, ...(op.entities.length > 0 ? { entities: op.entities } : {}) })
      case "media":
        return sendMedia(op, base)
      case "call":
        // 插件给的参数优先：`seg.raw` 是兼容出口，插件可能就是要发到别处
        return api.call(op.method, { ...base, ...op.params })
    }
  }

  /**
   * 编码并发送
   * @param target 发送目标
   * @param segments 段序列
   * @returns 发送结果
   */
  const send = async (target: SendTarget, segments: Segment[]): Promise<SendResult> => {
    const chatId = chatIdOf(target)
    const encoded = await encodeMessage(segments, encodeDeps)
    if (encoded.dropped.length > 0) {
      host.logger.debug(`以下消息段在 Telegram 上没有对应表达，已丢弃：${[...new Set(encoded.dropped)].join("、")}`)
    }
    const ops = [...encoded.ops]
    // 见 encode.ts 文件头第三点：按钮要有一条消息可挂
    if (encoded.keyboard !== undefined && !ops.some(op => op.kind !== "call")) ops.push({ kind: "text", text: KEYBOARD_PLACEHOLDER, entities: [] })
    if (ops.length === 0) throw new Error("消息为空，没有可发送的内容")

    const shared: Record<string, unknown> = { chat_id: chatId }
    let reply: Record<string, unknown> | undefined
    const quote = encoded.quote === undefined ? undefined : decodeMessageId(encoded.quote)
    if (encoded.quote !== undefined && quote === undefined) host.logger.debug(`引用的消息 id ${encoded.quote} 认不出，已忽略`)
    if (quote !== undefined) {
      // 允许被引用的消息已删除；跨会话引用要带上它所在的会话
      reply = { message_id: quote.messageId, allow_sending_without_reply: true }
      if (quote.chatId !== undefined && quote.chatId !== chatId) reply["chat_id"] = quote.chatId
    }
    if (target.scene === "group") {
      const quoted = encoded.quote === undefined ? undefined : msgThreads.get(encoded.quote)
      const thread = quoted ?? chatThreads.get(chatId)
      if (thread !== undefined && thread > 0) shared["message_thread_id"] = thread
    }

    // 按钮挂在最后一条非 `call` 的消息上
    let keyboardAt = -1
    if (encoded.keyboard !== undefined) for (let i = ops.length - 1; i >= 0 && keyboardAt === -1; i--) if (ops[i]!.kind !== "call") keyboardAt = i
    const markup: { inline_keyboard: InlineButton[][] } | undefined = encoded.keyboard === undefined ? undefined : { inline_keyboard: encoded.keyboard }

    const ids: string[] = []
    const results: unknown[] = []
    for (const [i, op] of ops.entries()) {
      const base: Record<string, unknown> = { ...shared }
      if (i === 0 && reply !== undefined) base["reply_parameters"] = reply
      if (i === keyboardAt && markup !== undefined) base["reply_markup"] = markup
      let ret: unknown
      try {
        ret = await execute(op, base)
      } catch (err) {
        if (ids.length === 0 && results.length === 0) throw err
        // 已经发出去一部分：不重发（会重复），也不吞掉 —— 记一条并以部分成功返回
        host.logger.error(`消息已发出 ${results.length} 条后失败，其余未发送：${errText(err)}`)
        break
      }
      results.push(ret)
      if (isMessage(ret)) {
        const id = encodeMessageId(ret.chat.id, ret.message_id)
        ids.push(id)
        if (ret.message_thread_id !== undefined) msgThreads.set(id, ret.message_thread_id)
      }
    }
    return { ok: true, messageId: ids[0] ?? "", time: Date.now(), raw: { ids, results } }
  }

  /**
   * 列出 KV 里记下的会话
   * @param group true 取群，false 取私聊
   * @returns 原始 id 与记录
   */
  const knownChats = async (group: boolean): Promise<[string, KnownChat][]> => {
    const out: [string, KnownChat][] = []
    for await (const [key, chat] of chatsKv.entries<KnownChat>()) {
      if ((chat.type === "private") !== group) out.push([key, chat])
    }
    return out
  }

  /**
   * file_id → 下载地址或本机绝对路径
   * @param fileId file_id
   * @returns 地址（含 token）或路径
   */
  const resolveFile = async (fileId: string): Promise<string> => {
    const file = await api.call<TgFileInfo>("getFile", { file_id: fileId })
    if (file.file_path === undefined || file.file_path === "") {
      throw new Error("Telegram 没有给出下载路径：官方 Bot API 只能下载 20MB 以内的文件，更大的需自建 Bot API 服务器")
    }
    // 自建 Bot API 服务器开了 --local 时，file_path 是那台机器上的绝对路径
    if (/^(\/|[A-Za-z]:[\\/])/.test(file.file_path)) return file.file_path
    return api.fileUrl(file.file_path)
  }

  /** 头像的 `data:` URL；空串表示查过、没设头像 */
  let avatarCache: { value: string; at: number } | undefined

  /**
   * 取机器人自己的头像，转成 `data:` URL
   *
   * 不交出下载地址：地址里含 token，调用方（状态图之类）会把它写进日志、交给浏览器去拉。
   * 在这里经账号代理下载好再交出去，token 不出适配器，调用方也不必能连上 api.telegram.org。
   * 结果缓存一小时；失败不缓存，下次再试。
   * @returns `data:` URL；没设头像或取不到时 undefined
   */
  const selfAvatar = async (): Promise<string | undefined> => {
    if (avatarCache !== undefined && Date.now() - avatarCache.at < AVATAR_TTL) return avatarCache.value || undefined
    if (self === undefined) return undefined
    try {
      const photos = await api.call<{ photos?: TgPhotoSize[][] }>("getUserProfilePhotos", { user_id: self.id, limit: 1 })
      const sizes = photos.photos?.[0] ?? []
      // 状态图里只有 100px 见方：取不小于 AVATAR_SIZE 的最小一档，都不够就取最大的
      const pick = [...sizes].sort((a, b) => a.width - b.width).find(p => p.width >= AVATAR_SIZE) ?? sizes.at(-1)
      if (pick === undefined) {
        avatarCache = { value: "", at: Date.now() }
        return undefined
      }
      const where = await resolveFile(pick.file_id)
      const data = where.startsWith("/") || /^[A-Za-z]:[\\/]/.test(where) ? await readFile(where) : await download(where)
      const value = `data:${sniffMime(data) ?? "image/jpeg"};base64,${Buffer.from(data).toString("base64")}`
      avatarCache = { value, at: Date.now() }
      return value
    } catch (err) {
      host.logger.debug(`获取头像失败：${api.redact(errText(err))}`)
      return undefined
    }
  }

  const driver: BotDriver = {
    platform: PLATFORM,
    adapterId: deps.adapterId,
    caps: new Set(CAPS),

    get selfId(): string {
      return selfId
    },
    get nickname(): string {
      return nickname
    },
    get online(): boolean {
      return poller?.running === true
    },

    async connect(): Promise<void> {
      // 先查自己：既拿到 selfId（内核要回填账号记录），也验证了 token 与代理 —— 比轮询的报错好懂
      const me = await api.call<TgUser>("getMe")
      self = me
      selfId = toId(me.id)
      nickname = displayName(me) ?? ""

      // Webhook 与长轮询互斥（getUpdates 回 409）。不替用户删：那个 Webhook 可能是另一套程序在用
      const hook = await api.call<{ url?: string }>("getWebhookInfo")
      if (hook.url !== undefined && hook.url !== "") {
        throw new Error(
          "该机器人设置了 Webhook，与长轮询互斥。确认不再需要后，访问 " +
            "https://api.telegram.org/bot<你的Token>/deleteWebhook 删除即可"
        )
      }

      // offset 跟机器人 id 一起存：同一个账号记录换了 token 就是另一个机器人，旧 offset 不能用
      const saved = await host.kv.get<{ botId: number; offset: number }>("offset").catch(() => undefined)
      const p = new Poller({
        api,
        logger: host.logger,
        offset: saved?.botId === me.id ? saved.offset : 0,
        saveOffset: offset => host.kv.set("offset", { botId: me.id, offset }, { ttl: OFFSET_TTL }),
        onUpdate,
        onClosed: reason => {
          if (!stopped && !host.signal.aborted) host.setStatus("offline", { error: reason })
        },
        ...(deps.timings === undefined ? {} : { timings: deps.timings })
      })
      poller = p
      if (host.signal.aborted) return
      host.signal.addEventListener("abort", () => void p.stop(), { once: true })
      // 见文件头第二点：这一行之后到 connect() 解析之间不能再有 await
      p.start()
      host.logger.mark(`${nickname || selfId}(@${me.username ?? ""}) 已连接 Telegram`)
    },

    async disconnect(): Promise<void> {
      stopped = true
      await poller?.stop()
      poller = undefined
      admins.clear()
      members.clear()
    },

    async sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult> {
      const segments = toSegments(content)
      // 引用走 reply 段：编码器只把它挂到拆出来的第一条上
      if (opts?.quote !== undefined && !segments.some(s => s.type === "reply")) segments.unshift(seg.reply(opts.quote))
      return send(target, segments)
    },

    async recallMessage(messageId: string): Promise<boolean> {
      const id = decodeMessageId(messageId)
      if (id?.chatId === undefined) throw new Error(`消息 id ${messageId} 不是 会话id:消息id 的形式，无法撤回`)
      return api.call<boolean>("deleteMessage", { chat_id: id.chatId, message_id: id.messageId })
    },

    async getSelfInfo(): Promise<UserInfo> {
      const info = toUser(await api.call<TgUser>("getMe"))
      const avatar = await selfAvatar()
      if (avatar !== undefined) info.avatar = avatar
      return info
    },

    async getFriend(uid: string): Promise<UserInfo | undefined> {
      // Telegram 没有好友关系：私聊过机器人的人就是能私聊的"好友"，getChat 查得到即是
      try {
        const chat = await api.call<TgChat>("getChat", { chat_id: fromId(uid) })
        return chat.type === "private" ? toUser(chatToUser(chat)) : undefined
      } catch (err) {
        host.logger.debug(`查询用户 ${uid} 失败：${errText(err)}`)
        return undefined
      }
    },

    async getFriendList(): Promise<UserInfo[]> {
      // 见文件头第三点
      return (await knownChats(false)).map(([id, chat]) => ({ uid: toId(id), name: chat.title }))
    },

    async getGroup(gid: string): Promise<GroupInfo | undefined> {
      const chatId = fromId(gid)
      let chat: TgChat
      try {
        chat = await api.call<TgChat>("getChat", { chat_id: chatId })
      } catch (err) {
        host.logger.debug(`查询群 ${gid} 失败：${errText(err)}`)
        return undefined
      }
      if (!isGroupChat(chat)) return undefined
      const info = toGroup(chat)
      const [count, table] = await Promise.all([
        api.call<number>("getChatMemberCount", { chat_id: chatId }).catch(() => undefined),
        adminTable(chatId)
      ])
      if (count !== undefined) info.memberCount = count
      const owner = Object.entries(table).find(([, role]) => role === "owner")?.[0]
      if (owner !== undefined) info.owner = toId(owner)
      if (self !== undefined) info.selfRole = table[String(self.id)] ?? "member"
      return info
    },

    async getGroupList(): Promise<GroupInfo[]> {
      return (await knownChats(true)).map(([id, chat]) => ({ gid: toId(id), name: chat.title }))
    },

    async getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined> {
      const chatId = fromId(gid)
      const userId = fromId(uid)
      return members.fetch(`${chatId}:${userId}`, async () => {
        try {
          return toMember(await api.call<TgChatMember>("getChatMember", { chat_id: chatId, user_id: userId }), chatId)
        } catch (err) {
          host.logger.debug(`查询成员 ${uid}@${gid} 失败：${errText(err)}`)
          return undefined
        }
      })
    },

    async getGroupMemberList(gid: string, opts?: MemberListOptions): Promise<MemberInfo[]> {
      // Bot API 只给得出管理员列表；普通成员无从枚举（见 README「已知限制」）
      const chatId = fromId(gid)
      const list = await api.call<TgChatMember[]>("getChatAdministrators", { chat_id: chatId })
      const out = list.map(m => toMember(m, chatId)).filter((m): m is MemberInfo => m !== undefined)
      return opts?.limit === undefined ? out : out.slice(0, opts.limit)
    },

    async muteGroupMember(gid: string, uid: string, seconds: number): Promise<void> {
      const chatId = fromId(gid)
      let permissions: TgChatPermissions = ALL_DENIED
      if (seconds <= 0) {
        // 解除：恢复成群的默认权限，而不是全部放开（群主可能本就关了发图）
        const chat = await api.call<TgChat>("getChat", { chat_id: chatId }).catch(() => undefined)
        permissions = chat?.permissions ?? ALL_ALLOWED
      }
      const params: Record<string, unknown> = { chat_id: chatId, user_id: fromId(uid), permissions, use_independent_chat_permissions: true }
      // 不足 30 秒或超过 366 天平台都视为永久；向上取到 30 秒，免得"禁言 10 秒"变成永久
      if (seconds > 0 && seconds <= 366 * 86_400) params["until_date"] = Math.floor(Date.now() / 1000) + Math.max(30, Math.floor(seconds))
      await api.call("restrictChatMember", params)
      members.delete(`${chatId}:${fromId(uid)}`)
    },

    async muteGroupAll(gid: string, enable: boolean): Promise<void> {
      const chatId = fromId(gid)
      const key = `perm:${chatId}`
      let permissions: TgChatPermissions
      if (enable) {
        // 先记下原来的权限，解除时原样恢复；已经是全员禁言时不覆盖，免得记下的是"全关"
        const chat = await api.call<TgChat>("getChat", { chat_id: chatId })
        if (chat.permissions?.can_send_messages !== false) await host.kv.set(key, chat.permissions ?? ALL_ALLOWED)
        permissions = ALL_DENIED
      } else {
        permissions = (await host.kv.get<TgChatPermissions>(key)) ?? ALL_ALLOWED
      }
      await api.call("setChatPermissions", { chat_id: chatId, permissions, use_independent_chat_permissions: true })
      if (!enable) await host.kv.del(key)
    },

    async kickGroupMember(gid: string, uid: string, rejectAddAgain = false): Promise<void> {
      const chatId = fromId(gid)
      const userId = fromId(uid)
      await api.call("banChatMember", { chat_id: chatId, user_id: userId })
      // Telegram 的"踢"就是封禁；不拒绝再加群时立即解封，效果即为移出
      if (!rejectAddAgain) await api.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true })
      members.delete(`${chatId}:${userId}`)
    },

    async quitGroup(gid: string): Promise<void> {
      const chatId = fromId(gid)
      await api.call("leaveChat", { chat_id: chatId })
      if (/^-?\d+$/.test(chatId)) forgetChat(Number(chatId))
    },

    getFileUrl: resolveFile,

    async callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
      return api.call<T>(action, params ?? {})
    }
  }

  return driver
}
