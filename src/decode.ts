/**
 * 模块职责：接收侧 —— Telegram 消息 → 通用消息段
 * 依赖方向：依赖 platform / types 与类型包、内核的 `textOf`
 * 生命周期：纯函数（用户名 → id 的反查经注入的 `DecodeContext` 完成）
 * 注意事项：**一、实体（entities）按 UTF-16 码元计偏移。** JS 字符串的下标恰好也是 UTF-16 码元，
 *          直接 `slice` 即可，不必像别的语言那样换算 —— 但不能先把文本转成码点数组再切。
 *
 *          **二、@ 有两种。** `text_mention` 带完整的用户对象（对方没有用户名时），直接成 at 段；
 *          `mention` 只有 `@用户名` 文本，Bot API 没有"按用户名查 id"的接口，只能靠见过的人
 *          反查：机器人自己必中（`atMe` 靠它），其余命中缓存才成 at 段，否则保留为原文。
 *
 *          **三、群里的 `/命令@机器人名` 去掉后缀。** 群里有多个机器人时客户端会自动补上后缀，
 *          不去掉的话 `/help@MyBot` 撞不上 `/help`。补的是别的机器人的命令则整条原样保留。
 *
 *          **四、媒体一律给 `kind: "id"`（file_id）。** 下载地址里含 token，不能放进消息段 ——
 *          消息段会被写进日志、存进数据库、转发给别的平台。需要内容的插件调
 *          `bot.getFileUrl(id)`；原样转发回 Telegram 时 file_id 零传输。
 */
import type { MediaRef, QuoteInfo, Segment, UserInfo } from "@yunzai-ng/types"
import { textOf } from "@yunzai-ng/core"
import { encodeMessageId, toId } from "./platform.js"
import type { TgChat, TgEntity, TgMessage, TgUser } from "./types.js"

/** 解码时需要的上下文 */
export interface DecodeContext {
  /** 机器人自己的 id（原始） */
  readonly selfId: number
  /** 机器人自己的用户名（不含 @，小写比较） */
  readonly selfUsername: string
  /**
   * 由用户名反查用户 id
   * @param username 用户名（不含 @）
   * @returns 原始用户 id；没见过时 undefined
   */
  idOfUsername(username: string): number | undefined
}

/**
 * 用户的展示名：`名 姓`，都没有时退回用户名
 * @param user 用户或私聊会话
 * @returns 展示名；全都没有时 undefined
 */
export function displayName(user: Pick<TgUser, "first_name" | "last_name" | "username"> | undefined): string | undefined {
  const name = [user?.first_name, user?.last_name].filter(s => s !== undefined && s !== "").join(" ")
  if (name !== "") return name
  return user?.username !== undefined && user.username !== "" ? user.username : undefined
}

/**
 * Telegram 用户 → 通用用户信息
 *
 * 不填 `avatar`：头像只能经 `getFile` 拿到一个含 token 的地址（见文件头第四点）。
 * @param user 用户
 * @returns 用户信息
 */
export function toUser(user: TgUser): UserInfo {
  const info: UserInfo = { uid: toId(user.id) }
  const name = displayName(user)
  if (name !== undefined) info.name = name
  return info
}

/**
 * 会话 → 用户信息（匿名管理员、关联频道以会话身份发言时用）
 * @param chat 会话
 * @returns 用户信息
 */
export function chatAsUser(chat: TgChat): UserInfo {
  const info: UserInfo = { uid: toId(chat.id) }
  const name = chat.title ?? displayName(chat)
  if (name !== undefined) info.name = name
  return info
}

/**
 * 把一段文字追加到段序列末尾，与前一个文本段合并
 * @param out 段序列
 * @param text 文字
 */
function pushText(out: Segment[], text: string): void {
  if (text === "") return
  const last = out[out.length - 1]
  if (last?.type === "text") last.text += text
  else out.push({ type: "text", text })
}

/**
 * 解析带实体的文字
 * @param text 文字
 * @param entities 实体
 * @param ctx 上下文
 * @returns 段序列
 */
export function decodeText(text: string, entities: readonly TgEntity[] | undefined, ctx: DecodeContext): Segment[] {
  const out: Segment[] = []
  const wanted = (entities ?? [])
    .filter(e => e.type === "mention" || e.type === "text_mention" || e.type === "bot_command")
    .sort((a, b) => a.offset - b.offset)
  let cursor = 0
  for (const entity of wanted) {
    // 三类实体互不嵌套；真遇上重叠（平台侧的问题）就跳过后一个
    if (entity.offset < cursor) continue
    const piece = text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === "bot_command") {
      // 见文件头第三点：只去掉指向自己的后缀
      const at = piece.indexOf("@")
      if (at === -1 || piece.slice(at + 1).toLowerCase() !== ctx.selfUsername.toLowerCase()) continue
      pushText(out, text.slice(cursor, entity.offset) + piece.slice(0, at))
      cursor = entity.offset + entity.length
      continue
    }
    let uid: number | undefined
    let name: string | undefined
    if (entity.type === "text_mention" && entity.user !== undefined) {
      uid = entity.user.id
      name = displayName(entity.user)
    } else if (entity.type === "mention") {
      const username = piece.replace(/^@/, "")
      uid = username.toLowerCase() === ctx.selfUsername.toLowerCase() ? ctx.selfId : ctx.idOfUsername(username)
      name = username
    }
    if (uid === undefined) continue
    pushText(out, text.slice(cursor, entity.offset))
    out.push(name === undefined ? { type: "at", uid: toId(uid) } : { type: "at", uid: toId(uid), name })
    cursor = entity.offset + entity.length
  }
  pushText(out, text.slice(cursor))
  return out
}

/**
 * file_id → 媒体引用
 * @param fileId file_id
 * @returns 媒体引用
 */
function idRef(fileId: string): MediaRef {
  return { kind: "id", id: fileId }
}

/**
 * 解析消息正文（媒体 + 文字 / 说明文字）
 *
 * 媒体在前、说明文字在后，与客户端里的观感一致。认不出的消息种类（游戏、发票、Story……）
 * 返回空数组，由调用方决定不投递。
 * @param msg 消息
 * @param ctx 上下文
 * @returns 段序列
 */
export function decodeMessage(msg: TgMessage, ctx: DecodeContext): Segment[] {
  const out: Segment[] = []

  if (msg.photo !== undefined && msg.photo.length > 0) {
    // 多个尺寸按升序给出，取最大的那张
    const best = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    out.push({ type: "image", file: idRef(best.file_id), width: best.width, height: best.height })
  } else if (msg.sticker !== undefined) {
    const st = msg.sticker
    if (st.is_video === true) out.push({ type: "video", file: idRef(st.file_id) })
    // TGS 动画贴纸是 Lottie JSON，当图片发给别处谁也打不开，退化成它的 emoji
    else if (st.is_animated === true) pushText(out, st.emoji ?? "[贴纸]")
    else out.push({ type: "image", file: idRef(st.file_id), subType: 1, summary: st.emoji ?? "[贴纸]" })
  } else if (msg.animation !== undefined) {
    // GIF 同时带 animation 与 document 两个字段，animation 优先
    out.push({ type: "video", file: idRef(msg.animation.file_id) })
  } else if (msg.video !== undefined) {
    out.push({ type: "video", file: idRef(msg.video.file_id) })
  } else if (msg.video_note !== undefined) {
    out.push({ type: "video", file: idRef(msg.video_note.file_id) })
  } else if (msg.voice !== undefined) {
    out.push(
      msg.voice.duration === undefined
        ? { type: "record", file: idRef(msg.voice.file_id) }
        : { type: "record", file: idRef(msg.voice.file_id), duration: msg.voice.duration }
    )
  } else if (msg.audio !== undefined) {
    const name = msg.audio.file_name ?? (msg.audio.title === undefined ? undefined : `${msg.audio.title}.mp3`)
    out.push({
      type: "file",
      file: idRef(msg.audio.file_id),
      ...(name === undefined ? {} : { name }),
      ...(msg.audio.file_size === undefined ? {} : { size: msg.audio.file_size })
    })
  } else if (msg.document !== undefined) {
    const doc = msg.document
    // "以文件发送"的图片仍是图片：识图类插件要能拿到它
    if (doc.mime_type?.startsWith("image/") === true && doc.mime_type !== "image/svg+xml") {
      out.push({ type: "image", file: idRef(doc.file_id) })
    } else {
      out.push({
        type: "file",
        file: idRef(doc.file_id),
        ...(doc.file_name === undefined ? {} : { name: doc.file_name }),
        ...(doc.file_size === undefined ? {} : { size: doc.file_size })
      })
    }
  } else if (msg.venue !== undefined) {
    out.push({
      type: "location",
      lat: msg.venue.location.latitude,
      lon: msg.venue.location.longitude,
      ...(msg.venue.title === undefined ? {} : { title: msg.venue.title }),
      ...(msg.venue.address === undefined ? {} : { content: msg.venue.address })
    })
  } else if (msg.location !== undefined) {
    out.push({ type: "location", lat: msg.location.latitude, lon: msg.location.longitude })
  } else if (msg.dice !== undefined) {
    if (msg.dice.emoji === "🎲") out.push({ type: "dice", result: msg.dice.value })
    else pushText(out, `${msg.dice.emoji}${msg.dice.value}`)
  } else if (msg.contact !== undefined) {
    // 不带电话号码：那是个人信息，进日志就收不回来了
    pushText(out, `[名片] ${displayName(msg.contact) ?? ""}`.trim())
  } else if (msg.poll !== undefined) {
    pushText(out, `[投票] ${msg.poll.question ?? ""}`.trim())
  }

  const text = msg.text ?? msg.caption
  if (text !== undefined && text !== "") {
    for (const seg of decodeText(text, msg.text === undefined ? msg.caption_entities : msg.entities, ctx)) {
      if (seg.type === "text") pushText(out, seg.text)
      else out.push(seg)
    }
  }
  return out
}

/**
 * 解码被回复的消息
 *
 * 事件里直接带了被回复消息的全文，故就地填上 `message` —— 识图类指令拿 `e.images`
 * 就能取到被引用的图，不必再查一次（Bot API 也没有按 id 取消息的接口）。
 * @param msg 当前消息
 * @param ctx 上下文
 * @returns 引用信息；没有回复时 undefined
 */
export function decodeQuote(msg: TgMessage, ctx: DecodeContext): QuoteInfo | undefined {
  const quoted = msg.reply_to_message
  if (quoted === undefined) return undefined
  // 话题里的每条消息都"回复"了话题的创建消息：那不是用户的回复
  if (quoted.forum_topic_created !== undefined) return undefined
  const info: QuoteInfo = { messageId: encodeMessageId(quoted.chat.id, quoted.message_id) }
  if (quoted.sender_chat !== undefined) info.sender = chatAsUser(quoted.sender_chat)
  else if (quoted.from !== undefined) info.sender = toUser(quoted.from)
  if (quoted.date > 0) info.time = quoted.date * 1000
  const message = decodeMessage(quoted, ctx)
  if (message.length > 0) {
    info.message = message
    info.text = textOf(message)
  }
  return info
}
