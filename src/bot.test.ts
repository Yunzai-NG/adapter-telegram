/**
 * 模块职责：驱动的端到端测试 —— 对一个本地的假 Bot API 跑通连接、长轮询、收发、断线
 * 依赖方向：测试文件，依赖 bot.ts / config.ts、内核的 HTTP 客户端、KV 与测试替身
 * 生命周期：每项用例各自起一个服务器与一个驱动，afterEach 逆序清理
 * 注意事项：不替换 api / poller 层。该链路上最易错的恰是报文的具体形态 —— 路径里的 token、
 *          chat_id 是不是去掉前缀的原始 id、multipart 里的 JSON 字段、offset 的推进 —— 替换掉就一项都测不到。
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Kv, MemoryKvDriver, createCache, createHttpClient, seg } from "@yunzai-ng/core"
import type { ManagedHttpClient } from "@yunzai-ng/core"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type {
  AccountRecord,
  AccountStatus,
  AdapterHost,
  BotDriver,
  IncomingEvent,
  IncomingMessageEvent,
  KvNamespace
} from "@yunzai-ng/types"
import { createTelegramBot } from "./bot.js"
import { validateAccount } from "./config.js"
import type { TgMessage, TgUpdate } from "./types.js"

const TOKEN = "123:test-token"

/** 假 Bot API 收到的一次调用 */
interface Seen {
  /** 方法名 */
  method: string
  /** 参数（JSON 或 multipart 的文本字段） */
  body: Record<string, unknown>
  /** multipart 的文件字段 */
  files: Record<string, { filename: string; type: string; size: number }>
}

/** Bot API 的失败应答 */
class TgError {
  constructor(
    readonly code: number,
    readonly description: string
  ) {}
}

/** 一个方法的应答 */
type Handler = (req: Seen) => unknown

/**
 * 解析 multipart 请求体（只认本适配器拼出来的形状）
 * @param raw 请求体
 * @param contentType Content-Type 头
 * @returns 文本字段与文件字段
 */
function parseMultipart(raw: Buffer, contentType: string): Pick<Seen, "body" | "files"> {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!
  const body: Record<string, unknown> = {}
  const files: Seen["files"] = {}
  for (const part of raw.toString("latin1").split(`--${boundary}`)) {
    const m = /^\r\nContent-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([\s\S]*)\r\n$/.exec(part)
    if (m === null) continue
    if (m[2] !== undefined) {
      files[m[1]!] = { filename: m[2], type: m[3] ?? "", size: m[4]!.length }
      continue
    }
    const text = Buffer.from(m[4]!, "latin1").toString("utf8")
    body[m[1]!] = /^[[{]/.test(text) ? JSON.parse(text) : text
  }
  return { body, files }
}

/** 假 Bot API */
interface FakeTelegram {
  /** API 基址 */
  base: string
  /** 收到的全部调用 */
  requests: Seen[]
  /** 按方法覆盖应答 */
  routes: Record<string, Handler>
  /** token 是否已被吊销（之后一律 401） */
  revoked: boolean
  /** 推送更新 */
  push(...updates: TgUpdate[]): void
  /** 取某个方法的调用 */
  calls(method: string): Seen[]
  /** 关闭 */
  close(): Promise<void>
}

/**
 * 启动一个假 Bot API
 * @returns 服务器句柄
 */
async function startFakeTelegram(): Promise<FakeTelegram> {
  let pending: TgUpdate[] = []
  let waiters: (() => void)[] = []
  let nextId = 100

  const sent: Handler = req => ({ message_id: ++nextId, date: 1, chat: { id: Number(req.body["chat_id"]), type: "supergroup" } })
  const fake: FakeTelegram = {
    base: "",
    requests: [],
    revoked: false,
    routes: {
      getMe: () => ({ id: 9000, is_bot: true, first_name: "测试机器人", username: "TestBot" }),
      getWebhookInfo: () => ({ url: "" }),
      getUpdates: async req => {
        const offset = Number(req.body["offset"] ?? 0)
        pending = pending.filter(u => u.update_id >= offset)
        if (pending.length === 0) {
          await new Promise<void>(resolve => {
            waiters.push(resolve)
            setTimeout(resolve, 100)
          })
        }
        return pending.filter(u => u.update_id >= offset)
      },
      getChatAdministrators: () => [
        { status: "creator", user: { id: 1000, first_name: "群主" } },
        { status: "administrator", user: { id: 2000, first_name: "乙" } }
      ],
      getChat: () => new TgError(400, "Bad Request: chat not found"),
      getFile: req => ({ file_id: req.body["file_id"], file_path: "photos/file_1.jpg" }),
      answerCallbackQuery: () => true,
      deleteMessage: () => true,
      banChatMember: () => true,
      unbanChatMember: () => true,
      sendMessage: sent,
      sendPhoto: sent,
      sendDocument: sent,
      sendAnimation: sent,
      sendVoice: sent,
      sendSticker: sent
    },
    push: (...updates) => {
      pending.push(...updates)
      for (const w of waiters) w()
      waiters = []
    },
    calls: method => fake.requests.filter(r => r.method === method),
    close: () =>
      new Promise<void>(resolve => {
        for (const w of waiters) w()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      void (async () => {
        res.setHeader("Content-Type", "application/json")
        const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "")
        if (m === null || m[1] !== TOKEN || fake.revoked) {
          res.statusCode = m === null ? 404 : 401
          res.end(JSON.stringify({ ok: false, error_code: res.statusCode, description: m === null ? "Not Found" : "Unauthorized" }))
          return
        }
        const raw = Buffer.concat(chunks)
        const type = req.headers["content-type"] ?? ""
        const parsed = type.startsWith("multipart/")
          ? parseMultipart(raw, type)
          : { body: raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {}, files: {} }
        const seen: Seen = { method: m[2]!, ...parsed }
        fake.requests.push(seen)
        const handler = fake.routes[seen.method]
        const out = handler === undefined ? new TgError(404, "Not Found: method not found") : await handler(seen)
        if (out instanceof TgError) {
          res.statusCode = out.code
          res.end(JSON.stringify({ ok: false, error_code: out.code, description: out.description }))
        } else {
          res.end(JSON.stringify({ ok: true, result: out }))
        }
      })()
    })
  })

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

/** 测试用的宿主 */
interface TestHost extends AdapterHost {
  /** 已投递的事件 */
  submitted: IncomingEvent[]
  /** 已上报的状态 */
  statuses: { status: AccountStatus; error?: string }[]
  /** 模拟账号停用 */
  abort(): void
}

/**
 * 构造宿主
 * @param kv 账号的 KV（跨驱动共享时传同一个）
 * @returns 宿主
 */
function fakeHost(kv: KvNamespace = new Kv(new MemoryKvDriver())): TestHost {
  const record: AccountRecord = { id: "acc-1", adapterId: "telegram", enabled: true, config: {}, createdAt: 0, updatedAt: 0 }
  const controller = new AbortController()
  const host: TestHost = {
    submitted: [],
    statuses: [],
    abort: () => controller.abort(),
    logger: fakeLogger(),
    kv,
    account: record,
    policy: { masters: [], isMaster: () => false },
    server: { enabled: false, host: "127.0.0.1", port: 0, publicUrl: "" },
    signal: controller.signal,
    submit: event => host.submitted.push(event),
    route: () => () => undefined,
    websocket: () => () => undefined,
    createCache: opts => createCache(opts),
    onDispose: () => undefined,
    setStatus: (status, detail) => host.statuses.push({ status, ...(detail?.error === undefined ? {} : { error: detail.error }) })
  }
  return host
}

/**
 * 等待条件成立
 * @param check 条件
 * @param label 超时说明
 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待 ${label} 超过 3 秒仍未发生`)
}

/** 待清理 */
let cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** 一套测试环境 */
interface Env {
  /** 假 Bot API */
  fake: FakeTelegram
  /** 宿主 */
  host: TestHost
  /** 驱动 */
  driver: BotDriver
  /** HTTP 客户端 */
  http: ManagedHttpClient
}

/**
 * 起服务器、建驱动
 * @param config 额外的账号配置
 * @param reuse 复用上一套环境的服务器与 KV（模拟重连）
 * @returns 环境
 */
async function setup(config: Record<string, unknown> = {}, reuse?: Env): Promise<Env> {
  const fake = reuse?.fake ?? (await startFakeTelegram())
  if (reuse === undefined) cleanup.push(() => fake.close())
  const http = reuse?.http ?? createHttpClient({ useEnvProxy: false })
  if (reuse === undefined) cleanup.push(() => http.close())
  const host = fakeHost(reuse?.host.kv)
  const account = validateAccount({ token: TOKEN, apiBase: fake.base, ...config })
  const driver = createTelegramBot(account, host, {
    adapterId: "telegram",
    http,
    timings: { pollTimeout: 0, backoff: 20, maxBackoff: 50 }
  })
  cleanup.push(() => driver.disconnect())
  return { fake, host, driver, http }
}

/**
 * 起服务器、建驱动并连上
 * @param config 额外的账号配置
 * @returns 环境
 */
async function connected(config: Record<string, unknown> = {}): Promise<Env> {
  const env = await setup(config)
  await env.driver.connect()
  return env
}

/** 一条群消息 */
function groupMsg(id: number, text: string, from = 2000, extra: Partial<TgMessage> = {}): TgMessage {
  return { message_id: id, date: 1700000000, chat: { id: -1001, type: "supergroup", title: "测试群" }, from: { id: from, first_name: "乙", username: `u${from}` }, text, ...extra }
}

/** 取出已投递消息的文本 */
function texts(host: TestHost): string[] {
  return host.submitted
    .filter((e): e is IncomingMessageEvent => e.kind === "message")
    .map(e => e.message.map(s => (s.type === "text" ? s.text : `[${s.type}]`)).join(""))
}

/** 一张小 PNG（尺寸可调） */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}

describe("连接", () => {
  it("回填 selfId 与昵称，长轮询只订阅三类更新", async () => {
    const { fake, driver } = await connected()
    expect(driver.selfId).toBe("tg_9000")
    expect(driver.nickname).toBe("测试机器人")
    expect(driver.online).toBe(true)
    await until(() => fake.calls("getUpdates").length > 0, "getUpdates")
    expect(fake.calls("getUpdates")[0]!.body["allowed_updates"]).toEqual(["message", "callback_query", "my_chat_member"])
  })

  it("token 错误时 connect 抛出可照着改的错误", async () => {
    const { fake, driver } = await setup()
    fake.revoked = true
    await expect(driver.connect()).rejects.toThrow(/401.*@BotFather/)
  })

  it("网络层失败的错误里不带 token", async () => {
    const { driver } = await setup({ apiBase: "http://127.0.0.1:1" })
    const err: unknown = await driver.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("[REDACTED]")
    expect((err as Error).message).not.toContain("test-token")
    expect((err as Error).cause).toBeUndefined()
  })

  it("设置了 Webhook 时拒绝连接，不替用户删", async () => {
    const { fake, driver } = await setup()
    fake.routes["getWebhookInfo"] = () => ({ url: "https://example.com/hook" })
    await expect(driver.connect()).rejects.toThrow(/Webhook/)
    expect(fake.calls("deleteWebhook")).toHaveLength(0)
  })
})
describe("收消息", () => {
  it("群消息带上群与成员角色投递；管理员表只查一次", async () => {
    const { fake, host } = await connected()
    fake.push({ update_id: 1, message: groupMsg(5, "#签到") })
    await until(() => host.submitted.length === 1, "投递")
    expect(host.submitted[0]).toMatchObject({
      kind: "message",
      scene: "group",
      messageId: "-1001:5",
      time: 1700000000000,
      group: { gid: "tg_-1001", name: "测试群" },
      sender: { uid: "tg_2000", role: "admin", name: "乙" }
    })
    fake.push({ update_id: 2, message: groupMsg(6, "again", 3000) })
    await until(() => host.submitted.length === 2, "第二条")
    expect((host.submitted[1] as IncomingMessageEvent).sender).toMatchObject({ role: "member" })
    expect(fake.calls("getChatAdministrators")).toHaveLength(1)
  })

  it("@机器人成 at 段；私聊按 private 投递", async () => {
    const { fake, host } = await connected()
    fake.push(
      { update_id: 1, message: groupMsg(5, "@TestBot 帮助", 2000, { entities: [{ type: "mention", offset: 0, length: 8 }] }) },
      { update_id: 2, message: { message_id: 1, date: 1, chat: { id: 2000, type: "private", first_name: "乙" }, from: { id: 2000, first_name: "乙" }, text: "hi" } }
    )
    await until(() => host.submitted.length === 2, "两条")
    expect((host.submitted[0] as IncomingMessageEvent).message[0]).toEqual({ type: "at", uid: "tg_9000", name: "TestBot" })
    expect(host.submitted[1]).toMatchObject({ scene: "private", subType: "friend", sender: { uid: "tg_2000" }, messageId: "2000:1" })
  })

  it("offset 落进 KV：重连后从上次的位置接着取，不重复投递", async () => {
    const first = await connected()
    first.fake.push({ update_id: 41, message: groupMsg(5, "一") })
    await until(() => first.host.submitted.length === 1, "投递")
    await until(() => first.fake.calls("getUpdates").some(r => r.body["offset"] === 42), "offset 推进")
    await first.driver.disconnect()

    const second = await setup({}, first)
    const before = second.fake.calls("getUpdates").length
    await second.driver.connect()
    await until(() => second.fake.calls("getUpdates").length > before, "重连后的 getUpdates")
    expect(second.fake.calls("getUpdates")[before]!.body["offset"]).toBe(42)
  })

  it("按钮：send 当作发言投递并应答；prompt 只弹窗不投递", async () => {
    const { fake, host } = await connected()
    const card = groupMsg(50, "菜单", 9000)
    fake.push(
      { update_id: 1, callback_query: { id: "cb1", from: { id: 2000, first_name: "乙" }, message: card, data: "=s#签到" } },
      { update_id: 2, callback_query: { id: "cb2", from: { id: 2000, first_name: "乙" }, message: card, data: "=p#绑定 uid" } }
    )
    await until(() => fake.calls("answerCallbackQuery").length === 2, "两次应答")
    expect(host.submitted).toHaveLength(1)
    expect(host.submitted[0]).toMatchObject({ scene: "group", subType: "button", quote: { messageId: "-1001:50" }, sender: { uid: "tg_2000", role: "admin" } })
    expect(texts(host)).toEqual(["#签到"])
    // 应答是发出即不管的，两次的到达顺序不定
    const prompt = fake.calls("answerCallbackQuery").find(r => r.body["callback_query_id"] === "cb2")
    expect(prompt?.body).toMatchObject({ text: "请发送：#绑定 uid", show_alert: true })
  })

  it("成员进群成通知；机器人被踢后群从群列表里消失", async () => {
    const { fake, host, driver } = await connected()
    fake.push({ update_id: 1, message: groupMsg(5, "hi") })
    await until(() => host.submitted.length === 1, "第一条")
    fake.push({ update_id: 2, message: { ...groupMsg(6, ""), text: undefined, new_chat_members: [{ id: 4000, first_name: "新人" }] } })
    await until(() => host.submitted.length === 2, "进群通知")
    expect(host.submitted[1]).toMatchObject({ kind: "notice", noticeType: "group.increase", gid: "tg_-1001", uid: "tg_4000", operatorId: "tg_2000", way: "invite" })
    expect(await driver.getGroupList()).toEqual([{ gid: "tg_-1001", name: "测试群" }])

    fake.push({
      update_id: 3,
      my_chat_member: {
        chat: { id: -1001, type: "supergroup", title: "测试群" },
        from: { id: 1000 },
        date: 1,
        old_chat_member: { status: "member", user: { id: 9000 } },
        new_chat_member: { status: "kicked", user: { id: 9000 } }
      }
    })
    await until(() => fake.calls("getUpdates").some(r => r.body["offset"] === 4), "处理完")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await driver.getGroupList()).toEqual([])
  })
})

describe("断线", () => {
  it("轮询途中 token 被吊销：上报 offline，且之后不再投递", async () => {
    const { fake, host, driver } = await connected()
    fake.revoked = true
    await until(() => host.statuses.some(s => s.status === "offline"), "offline")
    expect(host.statuses[0]!.error).toMatch(/401/)
    expect(driver.online).toBe(false)
  })

  it("偶发失败自己退避重试，不上报 offline", async () => {
    const { fake, host } = await connected()
    let fails = 2
    const original = fake.routes["getUpdates"]!
    fake.routes["getUpdates"] = req => (fails-- > 0 ? new TgError(502, "Bad Gateway") : original(req))
    fake.push({ update_id: 1, message: groupMsg(5, "恢复后") })
    await until(() => host.submitted.length === 1, "恢复后投递")
    expect(host.statuses).toHaveLength(0)
  })

  it("账号停用（signal abort）即停轮询，不上报 offline、不再投递", async () => {
    const { fake, host, driver } = await connected()
    host.abort()
    await until(() => !driver.online, "轮询停止")
    fake.push({ update_id: 1, message: groupMsg(5, "停用后") })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(host.submitted).toHaveLength(0)
    expect(host.statuses).toHaveLength(0)
  })
})
describe("发消息", () => {
  it("chat_id 去掉前缀；引用走 reply_parameters 且只挂第一条", async () => {
    const { fake, driver } = await connected()
    const ret = await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, ["你好", seg.image(png(10, 10)), "再见"], { quote: "-1001:5" })
    expect(ret).toMatchObject({ ok: true, messageId: "-1001:101" })
    const [first, second] = fake.calls("sendMessage")
    expect(first!.body).toMatchObject({ chat_id: "-1001", text: "你好", reply_parameters: { message_id: 5, allow_sending_without_reply: true } })
    expect(second!.body["reply_parameters"]).toBeUndefined()
    expect(fake.calls("sendPhoto")[0]!.body["reply_parameters"]).toBeUndefined()
  })

  it("@见过的人写 @用户名 + mention；没用户名的写名字 + text_mention", async () => {
    const { fake, host, driver } = await connected()
    fake.push({ update_id: 1, message: groupMsg(5, "hi", 2000) })
    await until(() => host.submitted.length === 1, "见过 2000")
    await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, [seg.at("tg_2000"), " 和 ", seg.at("tg_7", "小七")])
    expect(fake.calls("sendMessage")[0]!.body).toMatchObject({
      text: "@u2000 和 小七",
      entities: [
        { type: "mention", offset: 0, length: 6 },
        { type: "text_mention", offset: 9, length: 2, user: { id: 7, first_name: "小七" } }
      ]
    })
  })

  it("小图以 sendPhoto 上传；超过尺寸上限改以文件发送", async () => {
    const { fake, driver } = await connected()
    await driver.sendMessage({ scene: "private", uid: "tg_2000" }, seg.image(png(800, 600)))
    await driver.sendMessage({ scene: "private", uid: "tg_2000" }, seg.image(png(800, 6000)))
    expect(fake.calls("sendPhoto")[0]!.files["photo"]).toMatchObject({ filename: "image.png", type: "image/png" })
    expect(fake.calls("sendPhoto")[0]!.body["chat_id"]).toBe("2000")
    expect(fake.calls("sendDocument")[0]!.files["document"]).toMatchObject({ filename: "image.png" })
  })

  it("sendPhoto 被拒（400）时退成文件", async () => {
    const { fake, driver } = await connected()
    fake.routes["sendPhoto"] = () => new TgError(400, "Bad Request: PHOTO_INVALID_DIMENSIONS")
    const ret = await driver.sendMessage({ scene: "private", uid: "tg_2000" }, seg.image(Buffer.from("not-really-an-image")))
    expect(ret.ok).toBe(true)
    expect(fake.calls("sendDocument")).toHaveLength(1)
  })

  it("file_id 的类型对不上时按平台报出的类型换方法", async () => {
    const { fake, driver } = await connected()
    fake.routes["sendPhoto"] = () => new TgError(400, "Bad Request: can't use file of type Sticker as Photo")
    await driver.sendMessage({ scene: "private", uid: "tg_2000" }, seg.image({ kind: "id", id: "CAACAg" }))
    expect(fake.calls("sendSticker")[0]!.body).toMatchObject({ chat_id: "2000", sticker: "CAACAg" })
  })

  it("按钮挂在最后一条上；只有按钮时补占位文字", async () => {
    const { fake, driver } = await connected()
    const kb = seg.keyboard([[{ label: "签到", action: "callback", data: "#签到" }, { label: "官网", action: "link", data: "https://example.com" }]])
    await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, ["菜单", seg.image(png(10, 10)), kb])
    expect(fake.calls("sendMessage")[0]!.body["reply_markup"]).toBeUndefined()
    expect(fake.calls("sendPhoto")[0]!.body["reply_markup"]).toEqual({
      inline_keyboard: [[{ text: "签到", callback_data: "=s#签到" }, { text: "官网", url: "https://example.com" }]]
    })
    await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, kb)
    expect(fake.calls("sendMessage")[1]!.body).toMatchObject({ text: "请选择", reply_markup: { inline_keyboard: [[{ text: "签到" }, { text: "官网" }]] } })
  })

  it("话题群：回到对方所在的话题", async () => {
    const { fake, host, driver } = await connected()
    const forum = { id: -1001, type: "supergroup", title: "测试群", is_forum: true }
    fake.push({ update_id: 1, message: groupMsg(5, "hi", 2000, { chat: forum, is_topic_message: true, message_thread_id: 77 }) })
    await until(() => host.submitted.length === 1, "投递")
    await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, "回复")
    expect(fake.calls("sendMessage")[0]!.body["message_thread_id"]).toBe(77)
  })

  it("发出一部分后失败：不重发，以部分成功返回；第一条就失败则抛出", async () => {
    const { fake, driver } = await connected()
    fake.routes["sendPhoto"] = () => new TgError(500, "Internal Server Error")
    const ret = await driver.sendMessage({ scene: "group", gid: "tg_-1001" }, ["先", seg.image(png(10, 10)), "后"])
    expect(ret.messageId).toBe("-1001:101")
    expect(fake.calls("sendMessage")).toHaveLength(1)
    await expect(driver.sendMessage({ scene: "group", gid: "tg_-1001" }, seg.image(png(10, 10)))).rejects.toThrow(/500/)
  })

  it("空消息直接报错，不打到平台", async () => {
    const { fake, driver } = await connected()
    const before = fake.requests.filter(r => r.method !== "getUpdates").length
    await expect(driver.sendMessage({ scene: "group", gid: "tg_-1001" }, [seg.atAll()])).rejects.toThrow("消息为空")
    expect(fake.requests.filter(r => r.method !== "getUpdates").length).toBe(before)
  })
})

describe("其他接口", () => {
  it("撤回按 会话id:消息id 拆开调 deleteMessage", async () => {
    const { fake, driver } = await connected()
    await driver.recallMessage("-1001:42")
    expect(fake.calls("deleteMessage")[0]!.body).toEqual({ chat_id: "-1001", message_id: 42 })
    await expect(driver.recallMessage("42")).rejects.toThrow(/无法撤回/)
  })

  it("getFileUrl 拼出下载地址；自建服务器给出的绝对路径原样返回", async () => {
    const { fake, driver } = await connected()
    expect(await driver.getFileUrl!("AgAD")).toBe(`${fake.base}/file/bot${TOKEN}/photos/file_1.jpg`)
    fake.routes["getFile"] = () => ({ file_id: "x", file_path: "/var/lib/telegram-bot-api/123/photos/a.jpg" })
    expect(await driver.getFileUrl!("x")).toBe("/var/lib/telegram-bot-api/123/photos/a.jpg")
  })

  it("踢人 = 封禁后立即解封；拒绝再加群时只封禁", async () => {
    const { fake, driver } = await connected()
    await driver.kickGroupMember!("tg_-1001", "tg_3000")
    expect(fake.calls("banChatMember")[0]!.body).toEqual({ chat_id: "-1001", user_id: "3000" })
    expect(fake.calls("unbanChatMember")[0]!.body).toEqual({ chat_id: "-1001", user_id: "3000", only_if_banned: true })
    await driver.kickGroupMember!("tg_-1001", "tg_3000", true)
    expect(fake.calls("unbanChatMember")).toHaveLength(1)
  })

  it("callApi 原样转发，方法名不合法时拒绝", async () => {
    const { fake, driver } = await connected()
    fake.routes["getChatMemberCount"] = () => 42
    expect(await driver.callApi("getChatMemberCount", { chat_id: -1001 })).toBe(42)
    await expect(driver.callApi("../getMe")).rejects.toThrow(/方法名无效/)
  })
})
