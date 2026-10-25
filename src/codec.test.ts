/**
 * 模块职责：收发两侧编解码的单元测试 —— 实体解析、媒体、引用、编码、长文切分、按钮数据
 * 依赖方向：测试文件，依赖 decode / encode / callback 与内核的 seg
 * 生命周期：无状态
 * 注意事项：发送侧用一个记录调用的假 `EncodeDeps`，不碰网络：真正的请求形状在 bot.test.ts 里端到端测
 */
import { describe, expect, it } from "vitest"
import { seg, toSegments } from "@yunzai-ng/core"
import { CALLBACK_DATA_MAX, decodeCallback, encodeCallback } from "./callback.js"
import type { ButtonAction } from "./callback.js"
import { decodeMessage, decodeQuote, decodeText } from "./decode.js"
import type { DecodeContext } from "./decode.js"
import { MAX_TEXT, encodeMessage, splitText } from "./encode.js"
import type { EncodeDeps } from "./encode.js"
import type { TgMessage } from "./types.js"

const ctx: DecodeContext = {
  selfId: 999,
  selfUsername: "MyBot",
  idOfUsername: name => (name.toLowerCase() === "alice" ? 111 : undefined)
}

/** 一条最小的消息 */
function msg(extra: Partial<TgMessage>): TgMessage {
  return { message_id: 1, date: 1, chat: { id: -100, type: "supergroup" }, ...extra }
}

/** 记录调用的编码依赖 */
function deps(): EncodeDeps & { stored: Map<string, ButtonAction> } {
  const stored = new Map<string, ButtonAction>()
  return {
    stored,
    mention: async (uid, name) =>
      uid === "tg_111" ? { text: "@alice", entity: { type: "mention" } } : { text: name ?? uid, entity: { type: "text_mention", user: { id: 222 } } },
    callback: action => encodeCallback(action, async (key, value) => void stored.set(key, value))
  }
}

describe("接收：实体", () => {
  it("@自己与见过的用户名成 at 段，没见过的保留原文，顺序不变", () => {
    expect(decodeText("@MyBot 和 @alice 比，@bob 旁观", [
      { type: "mention", offset: 0, length: 6 },
      { type: "mention", offset: 9, length: 6 },
      { type: "mention", offset: 18, length: 4 }
    ], ctx)).toEqual([
      { type: "at", uid: "tg_999", name: "MyBot" },
      { type: "text", text: " 和 " },
      { type: "at", uid: "tg_111", name: "alice" },
      { type: "text", text: " 比，@bob 旁观" }
    ])
  })

  it("text_mention 直接用实体里的用户", () => {
    expect(decodeText("嗨 小明", [{ type: "text_mention", offset: 2, length: 2, user: { id: 5, first_name: "小明" } }], ctx)).toEqual([
      { type: "text", text: "嗨 " },
      { type: "at", uid: "tg_5", name: "小明" }
    ])
  })

  it("只去掉指向自己的命令后缀", () => {
    expect(decodeText("/help@MyBot x", [{ type: "bot_command", offset: 0, length: 11 }], ctx)).toEqual([{ type: "text", text: "/help x" }])
    expect(decodeText("/help@Other", [{ type: "bot_command", offset: 0, length: 11 }], ctx)).toEqual([{ type: "text", text: "/help@Other" }])
  })

  it("偏移按 UTF-16 码元计：emoji 在前也切得准", () => {
    expect(decodeText("😀@alice", [{ type: "mention", offset: 2, length: 6 }], ctx)).toEqual([
      { type: "text", text: "😀" },
      { type: "at", uid: "tg_111", name: "alice" }
    ])
  })
})

describe("接收：媒体与引用", () => {
  it("图片取最大尺寸，以 file_id 给出；说明文字跟在后面", () => {
    const out = decodeMessage(msg({
      photo: [{ file_id: "s", width: 90, height: 90 }, { file_id: "l", width: 1280, height: 720 }],
      caption: "#识图"
    }), ctx)
    expect(out).toEqual([
      { type: "image", file: { kind: "id", id: "l" }, width: 1280, height: 720 },
      { type: "text", text: "#识图" }
    ])
  })

  it("以文件发送的图片仍是图片；GIF 取 animation；TGS 贴纸退化成 emoji", () => {
    expect(decodeMessage(msg({ document: { file_id: "d", mime_type: "image/png" } }), ctx)).toEqual([{ type: "image", file: { kind: "id", id: "d" } }])
    expect(decodeMessage(msg({ animation: { file_id: "a" }, document: { file_id: "a" } }), ctx)).toEqual([{ type: "video", file: { kind: "id", id: "a" } }])
    expect(decodeMessage(msg({ sticker: { file_id: "st", is_animated: true, emoji: "👍" } }), ctx)).toEqual([{ type: "text", text: "👍" }])
  })

  it("认不出的消息给空数组", () => {
    expect(decodeMessage(msg({}), ctx)).toEqual([])
  })

  it("引用带上被引用消息的全文与图；话题创建消息不算引用", () => {
    const quote = decodeQuote(msg({
      reply_to_message: msg({ message_id: 7, from: { id: 3, first_name: "甲" }, photo: [{ file_id: "p", width: 1, height: 1 }], caption: "看图" })
    }), ctx)
    expect(quote).toMatchObject({ messageId: "-100:7", sender: { uid: "tg_3", name: "甲" }, text: "看图" })
    expect(quote?.message?.[0]).toMatchObject({ type: "image" })
    expect(decodeQuote(msg({ reply_to_message: msg({ forum_topic_created: {} }) }), ctx)).toBeUndefined()
  })
})

describe("发送：编码", () => {
  it("@ 写成实体，偏移按 UTF-16 计", async () => {
    const out = await encodeMessage(toSegments(["😀", seg.at("tg_111"), " 你好"]), deps())
    expect(out.ops).toEqual([{ kind: "text", text: "😀@alice 你好", entities: [{ type: "mention", offset: 2, length: 6 }] }])
  })

  it("文字与媒体按顺序拆开；引用只记一次；按钮单独给出", async () => {
    const out = await encodeMessage(
      toSegments([seg.reply("-100:5"), "看", seg.image("https://x/a.png"), "完", seg.keyboard([[{ label: "再来", action: "callback", data: "#再来" }]])]),
      deps()
    )
    expect(out.quote).toBe("-100:5")
    expect(out.ops.map(o => o.kind)).toEqual(["text", "media", "text"])
    expect(out.keyboard).toEqual([[{ text: "再来", callback_data: "=s#再来" }]])
  })

  it("合并转发逐节点成条；不认得的段记入 dropped", async () => {
    const out = await encodeMessage(
      [seg.atAll(), seg.forward([seg.node("一"), seg.node("二")])],
      deps()
    )
    expect(out.ops).toEqual([
      { kind: "text", text: "一", entities: [] },
      { kind: "text", text: "二", entities: [] }
    ])
    expect(out.dropped).toEqual(["atAll"])
  })

  it("只有空白的正文不产出消息", async () => {
    expect((await encodeMessage([seg.text("  \n")], deps())).ops).toEqual([])
  })

  it("seg.raw('telegram', 方法, 参数) 原样调用", async () => {
    const out = await encodeMessage([seg.raw("telegram", "sendPoll", { question: "?" })], deps())
    expect(out.ops).toEqual([{ kind: "call", method: "sendPoll", params: { question: "?" } }])
  })
})

describe("发送：长文切分", () => {
  it("超过上限时在换行处切，实体换算到段内", () => {
    const head = "a".repeat(3000)
    const text = `${head}\n@alice${"b".repeat(2000)}`
    const parts = splitText(text, [{ type: "mention", offset: 3001, length: 6 }])
    expect(parts.map(p => p.text.length)).toEqual([3001, 2006])
    expect(parts[1]!.entities).toEqual([{ type: "mention", offset: 0, length: 6 }])
    expect(parts.every(p => p.text.length <= MAX_TEXT)).toBe(true)
  })

  it("没有换行时不切开实体与代理对", () => {
    const parts = splitText(`${"a".repeat(4094)}@alice`, [{ type: "mention", offset: 4094, length: 6 }])
    expect(parts.map(p => p.text)).toEqual(["a".repeat(4094), "@alice"])
    const emoji = splitText(`${"a".repeat(4095)}😀`, [])
    expect(emoji.map(p => p.text.length)).toEqual([4095, 2])
  })
})

describe("按钮数据", () => {
  it("短的内联，长的存 KV 换短键，同内容同键", async () => {
    const store = new Map<string, ButtonAction>()
    const save = async (key: string, value: ButtonAction): Promise<void> => void store.set(key, value)
    expect(await encodeCallback({ kind: "prompt", text: "#绑定" }, save)).toBe("=p#绑定")
    const long = { kind: "send" as const, text: "#原神绑定".repeat(10) }
    const key = await encodeCallback(long, save)
    expect(key).toMatch(/^#[0-9a-f]{16}$/)
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(CALLBACK_DATA_MAX)
    expect(await encodeCallback(long, save)).toBe(key)
    expect(store.size).toBe(1)
    expect(await decodeCallback(key, async k => store.get(k))).toEqual(long)
  })

  it("别的程序发的按钮整段当作发言", async () => {
    expect(await decodeCallback("vote_1", async () => undefined)).toEqual({ kind: "send", text: "vote_1" })
  })
})
