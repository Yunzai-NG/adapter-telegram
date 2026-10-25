/**
 * 模块职责：发送侧 —— 通用消息段 → 一串 Bot API 调用
 * 依赖方向：依赖 callback / platform / types 与类型包
 * 生命周期：纯函数（@ 的展示名、按钮长数据的存储经注入的 `EncodeDeps` 完成）
 * 注意事项：**一、不用 parse_mode，一律用 entities。** MarkdownV2 要求转义 18 个字符，任何一个漏掉
 *          整条消息就被拒（"can't parse entities"）—— 插件的回复里满是 `#` `.` `-` `(`。entities
 *          只标注区间、正文原样发送，不存在转义问题。代价是 `markdown` 段只能按原文发出
 *          （见 bot.ts 的 caps，不声明 `markdown`）。
 *
 *          **二、@ 写成实体。** 有用户名时发 `@用户名` + `mention` 实体；没有用户名时发展示名 +
 *          `text_mention` 实体 —— 只拼 `@用户名` 的话，对方没设用户名时发出去的是 `@undefined`。
 *
 *          **三、按钮挂在最后一条上。** Telegram 的键盘只能附在一条消息上，没有"单独一条按钮"。
 *          文字、图片、按钮的相对顺序因此只保留到"按钮在末尾"这一层；只有按钮时补一句占位文字。
 *
 *          **四、一条文字最多 4096 个 UTF-16 码元。** 超出时优先在换行处切，不切开代理对，
 *          也不把实体切成两半（切开的 `mention` 实体会被平台整条拒收）。
 */
import type { KeyboardButton, MediaRef, Segment } from "@yunzai-ng/types"
import type { ButtonAction } from "./callback.js"
import { PLATFORM } from "./platform.js"
import type { TgEntity } from "./types.js"

/** 一条文字消息的长度上限（UTF-16 码元） */
export const MAX_TEXT = 4096

/** 一行按钮的上限 */
const MAX_ROW = 8

/** 内联按钮（`InlineKeyboardButton`，只用到的字段） */
export interface InlineButton {
  /** 按钮文字 */
  text: string
  /** 跳转地址 */
  url?: string
  /** 回调数据 */
  callback_data?: string
}

/** @ 某人时写进正文的内容 */
export interface MentionTarget {
  /** 写进正文的文字，如 `@alice` 或 `Alice` */
  text: string
  /** 覆盖这段文字的实体（offset / length 由编码器填）；缺省时按纯文字写入 */
  entity?: Omit<TgEntity, "offset" | "length">
}

/** 编码时需要的外部能力 */
export interface EncodeDeps {
  /**
   * 解析 @ 的目标
   * @param uid 框架用户 id
   * @param name at 段自带的展示名
   * @returns 正文与实体
   */
  mention(uid: string, name: string | undefined): Promise<MentionTarget>
  /**
   * 把按钮动作编码成 callback_data
   * @param action 动作
   * @returns callback_data（≤ 64 字节）
   */
  callback(action: ButtonAction): Promise<string>
}

/** 一次待执行的 Bot API 调用 */
export type OutgoingOp =
  | {
      /** 文字消息 */
      kind: "text"
      /** 正文 */
      text: string
      /** 实体 */
      entities: TgEntity[]
    }
  | {
      /** 媒体消息；具体用哪个方法要等拿到字节才知道（见 bot.ts） */
      kind: "media"
      /** 种类 */
      media: "image" | "video" | "audio" | "file"
      /** 来源 */
      ref: MediaRef
      /** 文件名 */
      name?: string
    }
  | {
      /** 任意方法（位置、骰子、`seg.raw("telegram", 方法, 参数)`） */
      kind: "call"
      /** 方法名 */
      method: string
      /** 参数（chat_id 由发送方补） */
      params: Record<string, unknown>
    }

/** 编码结果 */
export interface Encoded {
  /** 按顺序执行的调用 */
  ops: OutgoingOp[]
  /** 引用回复的消息 id（框架形态） */
  quote?: string
  /** 内联键盘 */
  keyboard?: InlineButton[][]
  /** 在 Telegram 上没有对应表达、被丢弃的段类型 */
  dropped: string[]
}

/** 正文缓冲：连续的文字、@、链接攒成一条再发 */
class TextRun {
  /** 正文 */
  text = ""
  /** 实体 */
  entities: TgEntity[] = []

  /**
   * 追加纯文字
   * @param text 文字
   */
  plain(text: string): void {
    this.text += text
  }

  /**
   * 追加一段带实体的文字
   * @param text 文字
   * @param entity 实体（不含区间）
   */
  marked(text: string, entity: Omit<TgEntity, "offset" | "length">): void {
    if (text === "") return
    this.entities.push({ ...entity, offset: this.text.length, length: text.length })
    this.text += text
  }

  /**
   * 取出内容并清空
   * @returns 内容；只有空白时 undefined（Telegram 拒收空消息）
   */
  take(): { text: string; entities: TgEntity[] } | undefined {
    const out = { text: this.text, entities: this.entities }
    this.text = ""
    this.entities = []
    return out.text.trim() === "" ? undefined : out
  }
}

/**
 * 把超长的文字切成不超过上限的几段（见文件头第四点）
 * @param text 正文
 * @param entities 实体
 * @param max 上限（UTF-16 码元）
 * @returns 各段的正文与实体（偏移已换算到段内）
 */
export function splitText(text: string, entities: readonly TgEntity[], max = MAX_TEXT): { text: string; entities: TgEntity[] }[] {
  const parts: { text: string; entities: TgEntity[] }[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + max, text.length)
    if (end < text.length) {
      // 后半段里有换行就切在换行之后
      const nl = text.lastIndexOf("\n", end - 1)
      if (nl >= start + max / 2) end = nl + 1
      // 不切开实体：起点落在切点之前、终点落在切点之后的实体，切点挪到它前面。
      // 挪过一次可能又落进另一个实体，故反复到不再变；`offset > start` 保证每段至少前进一个码元
      for (let moved = true; moved; ) {
        moved = false
        for (const e of entities) {
          if (e.offset > start && e.offset < end && e.offset + e.length > end && e.length <= max) {
            end = e.offset
            moved = true
          }
        }
      }
      // 不切开代理对
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > start) end--
    }
    const chunk: TgEntity[] = []
    for (const e of entities) {
      const from = Math.max(e.offset, start)
      const to = Math.min(e.offset + e.length, end)
      if (to > from) chunk.push({ ...e, offset: from - start, length: to - from })
    }
    const piece = text.slice(start, end)
    if (piece.trim() !== "") parts.push({ text: piece, entities: chunk })
    start = end
  }
  return parts
}

/**
 * 链接按钮只接受这几种协议；别的（`javascript:`、相对路径）平台会整条拒收
 * @param url 地址
 * @returns 是否可用
 */
function isButtonUrl(url: string): boolean {
  return /^(https?|tg):\/\//i.test(url)
}

/**
 * 通用按钮 → 内联按钮
 *
 * `input` 且 `enter` 与 `callback` 一样：点击即当作用户发言。`input` 不 `enter` 时 Telegram
 * 没有"把文字填进输入框"的按钮（`switch_inline_query_current_chat` 要求机器人开启内联模式），
 * 改为点击后弹窗提示用户手动发送 —— 与 adapter-kook 回一句"请输入 xxx"同一思路。
 * @param button 通用按钮
 * @param deps 外部能力
 * @returns 内联按钮；无法表达时 undefined
 */
async function encodeButton(button: KeyboardButton, deps: EncodeDeps): Promise<InlineButton | undefined> {
  const text = button.label.trim() === "" ? (button.data ?? "") : button.label
  if (text.trim() === "") return undefined
  const data = button.data ?? button.label
  switch (button.action) {
    case "link":
      return button.data !== undefined && isButtonUrl(button.data) ? { text, url: button.data } : undefined
    case "callback":
      return { text, callback_data: await deps.callback({ kind: "send", text: data }) }
    case "input":
      return { text, callback_data: await deps.callback({ kind: button.enter === true ? "send" : "prompt", text: data }) }
  }
}

/**
 * 按钮键盘 → 内联键盘（每行超过 8 个时拆行）
 * @param rows 按行组织的按钮
 * @param deps 外部能力
 * @returns 内联键盘的行
 */
export async function encodeKeyboard(rows: readonly KeyboardButton[][], deps: EncodeDeps): Promise<InlineButton[][]> {
  const out: InlineButton[][] = []
  for (const row of rows) {
    let line: InlineButton[] = []
    for (const button of row) {
      const el = await encodeButton(button, deps)
      if (el === undefined) continue
      if (line.length === MAX_ROW) {
        out.push(line)
        line = []
      }
      line.push(el)
    }
    if (line.length > 0) out.push(line)
  }
  return out
}

/** 遍历时的共享状态 */
interface VisitState {
  /** 正文缓冲 */
  run: TextRun
  /** 已产出的调用 */
  ops: OutgoingOp[]
  /** 引用 */
  quote?: string
  /** 键盘 */
  keyboard: InlineButton[][]
  /** 被丢弃的段类型 */
  dropped: string[]
}

/**
 * 把正文缓冲落成文字消息
 * @param state 共享状态
 */
function flush(state: VisitState): void {
  const taken = state.run.take()
  if (taken === undefined) return
  for (const part of splitText(taken.text, taken.entities)) state.ops.push({ kind: "text", ...part })
}

/**
 * 按顺序遍历段
 * @param segments 段序列
 * @param state 共享状态
 * @param deps 外部能力
 */
async function visit(segments: readonly Segment[], state: VisitState, deps: EncodeDeps): Promise<void> {
  const { run } = state
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        run.plain(seg.text)
        break
      case "markdown":
        // 见文件头第一点：原文发出，不做转换
        run.plain(seg.content)
        break
      case "at": {
        const target = await deps.mention(seg.uid, seg.name)
        if (target.entity === undefined) run.plain(target.text)
        else run.marked(target.text, target.entity)
        break
      }
      case "share":
        run.marked(seg.title || seg.url, { type: "text_link", url: seg.url })
        break
      case "music":
        if (seg.url !== undefined) run.marked(seg.title ?? seg.url, { type: "text_link", url: seg.url })
        else state.dropped.push("music")
        break
      case "location":
        flush(state)
        state.ops.push({ kind: "call", method: "sendLocation", params: { latitude: seg.lat, longitude: seg.lon } })
        break
      case "dice":
        flush(state)
        state.ops.push({ kind: "call", method: "sendDice", params: { emoji: "🎲" } })
        break
      case "reply":
        state.quote ??= seg.messageId
        break
      case "image":
        flush(state)
        state.ops.push({ kind: "media", media: "image", ref: seg.file })
        break
      case "video":
        flush(state)
        state.ops.push({ kind: "media", media: "video", ref: seg.file })
        break
      case "record":
        flush(state)
        state.ops.push({ kind: "media", media: "audio", ref: seg.file })
        break
      case "file":
        flush(state)
        state.ops.push({ kind: "media", media: "file", ref: seg.file, ...(seg.name === undefined ? {} : { name: seg.name }) })
        break
      case "keyboard":
        state.keyboard.push(...(await encodeKeyboard(seg.rows, deps)))
        break
      case "forward": {
        // Telegram 没有合并转发：逐节点摊平，每个节点各成一条
        const nodes = seg.nodes ?? []
        if (nodes.length === 0) state.dropped.push("forward")
        for (const node of nodes) {
          if (node.message === undefined) continue
          flush(state)
          await visit(node.message, state, deps)
        }
        flush(state)
        break
      }
      case "raw":
        if (seg.platform === PLATFORM && typeof seg.data === "object" && seg.data !== null && !Array.isArray(seg.data)) {
          flush(state)
          state.ops.push({ kind: "call", method: seg.platformType, params: { ...(seg.data as Record<string, unknown>) } })
        } else {
          state.dropped.push(`raw(${seg.platform}/${seg.platformType})`)
        }
        break
      default:
        // atAll / face / poke / contact / json / xml / rps：Telegram 没有对应物
        state.dropped.push(seg.type)
    }
  }
}

/**
 * 编码一条消息
 * @param segments 段序列
 * @param deps 外部能力
 * @returns 待执行的调用
 */
export async function encodeMessage(segments: readonly Segment[], deps: EncodeDeps): Promise<Encoded> {
  const state: VisitState = { run: new TextRun(), ops: [], keyboard: [], dropped: [] }
  await visit(segments, state, deps)
  flush(state)
  const out: Encoded = { ops: state.ops, dropped: state.dropped }
  if (state.quote !== undefined) out.quote = state.quote
  if (state.keyboard.length > 0) out.keyboard = state.keyboard
  return out
}
