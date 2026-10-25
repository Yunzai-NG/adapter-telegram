/**
 * 模块职责：Telegram Bot API 客户端 —— `{ ok, result }` 解包、multipart 上传、429 等待、token 脱敏
 * 依赖方向：依赖类型包的 `HttpClient`（由插件的 `ctx.http` 注入）、内核的 `sleep` 与 media.ts
 * 生命周期：一个账号一个实例，随驱动创建
 * 注意事项：**一、走 `ctx.http` 而不是自己 `node:https`。** 内核的客户端已支持按请求指定代理，
 *          全局代理、连接池、插件卸载时中止在途请求也都只在那里配置了一次。
 *
 *          **二、token 在 URL 路径里，内核的打码管不到。** Bot API 的地址是 `/bot<token>/<方法>`，
 *          内核 `sanitizeUrl` 只打码查询串，`HttpError` 的文案里会带上完整 URL。故本层捕获一切
 *          错误、把 token 替换成 `[REDACTED]` 后重新抛出，且不挂 `cause`，
 *          免得日志序列化时把原始错误一并打出来。
 *
 *          **三、关掉自动重试。** `sendMessage` 不是幂等的：网络层超时可能是"已经发出、只是回包丢了"，
 *          重试的结果是用户收到两条一样的回复。唯一的例外是 429：平台明确说了没处理、`retry_after`
 *          秒后再来，等一次再发是安全的（只等一次）。
 */
import type { HttpClient, Logger } from "@yunzai-ng/types"
import { sleep } from "@yunzai-ng/core"
import { buildMultipart } from "./media.js"
import type { UploadFile } from "./media.js"

/** Bot API 的统一响应外壳 */
interface Envelope {
  /** 是否成功 */
  ok?: boolean
  /** 成功时的数据 */
  result?: unknown
  /** 失败时的文案 */
  description?: string
  /** 失败时的错误码（多与 HTTP 状态码相同） */
  error_code?: number
  /** 附加参数 */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

/** Bot API 调用失败 */
export class TelegramApiError extends Error {
  /** 错误码；网络层失败时为 0 */
  readonly code: number
  /** 出错的方法名，如 `sendMessage` */
  readonly method: string
  /** 429 时平台要求等待的秒数 */
  readonly retryAfter: number | undefined

  /**
   * @param method 方法名
   * @param code 错误码
   * @param message 已脱敏的文案
   * @param retryAfter 429 时的等待秒数
   */
  constructor(method: string, code: number, message: string, retryAfter?: number) {
    super(`Telegram ${method} 失败（${code}）：${message}`)
    this.name = "TelegramApiError"
    this.code = code
    this.method = method
    this.retryAfter = retryAfter
  }
}

/** 单次调用的选项 */
export interface CallOptions {
  /** 覆盖默认超时（毫秒）；长轮询要比轮询时长更久 */
  timeout?: number
  /** 额外的中止信号（与账号信号取并集） */
  signal?: AbortSignal
}

/** API 客户端 */
export interface TelegramApi {
  /** API 基址（不含 `/bot<token>`） */
  readonly base: string

  /**
   * 调用一个方法
   * @param method 方法名，如 `sendMessage`
   * @param params 参数；undefined / null 的键丢弃
   * @param files 要上传的文件字段；非空时以 multipart 发送
   * @param opts 调用选项
   * @returns 解包后的 result
   * @throws TelegramApiError 一切失败（已脱敏）
   */
  call<T>(method: string, params?: Record<string, unknown>, files?: Record<string, UploadFile>, opts?: CallOptions): Promise<T>

  /**
   * 文件的下载地址
   * @param filePath `getFile` 返回的 file_path
   * @returns 地址（**含 token**，不要写进日志）
   */
  fileUrl(filePath: string): string

  /**
   * 把文本里的 token 替换掉
   * @param text 任意文本
   * @returns 脱敏后的文本
   */
  redact(text: string): string
}

/** 客户端构造参数 */
export interface TelegramApiOptions {
  /** 插件的 HTTP 客户端 */
  http: HttpClient
  /** API 基址，不含末尾斜杠 */
  base: string
  /** Bot Token */
  token: string
  /** 代理；空串表示沿用全局设置 */
  proxy: string
  /** 默认超时毫秒 */
  timeout: number
  /** 账号停用时 abort，在途请求随之中止 */
  signal: AbortSignal
  /** 日志器 */
  logger: Logger
}

/** 方法名的形状：Bot API 的方法一律是小驼峰字母数字 */
const METHOD_RE = /^[a-zA-Z][a-zA-Z0-9]*$/

/** 429 最多等多久（秒）：平台偶尔给出上千秒，等那么久不如直接报错 */
const MAX_RETRY_AFTER = 60

/**
 * 常见错误码的处置提示
 * @param code 错误码
 * @param description 平台文案
 * @returns 附在文案后面的提示
 */
function hintOf(code: number, description: string): string {
  if (code === 401) return "（Bot Token 无效或已被重置，请到 @BotFather 重新取得）"
  if (code === 404 && /not found/i.test(description)) return "（检查 Bot Token 与 API 基址是否正确）"
  if (code === 409 && /webhook/i.test(description)) return "（该机器人设置了 Webhook，与长轮询互斥：调用 deleteWebhook 后再连）"
  if (code === 409) return "（另一处正在用同一个 Bot Token 收消息，同一个机器人同时只能有一个程序在线）"
  return ""
}

/**
 * 丢掉值为 undefined / null 的键
 * @param params 参数
 * @returns 新对象
 */
function compact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) out[key] = value
  return out
}

/**
 * 创建 API 客户端
 * @param opts 构造参数
 * @returns 客户端
 */
export function createTelegramApi(opts: TelegramApiOptions): TelegramApi {
  const http = opts.http.extend({
    baseUrl: `${opts.base}/bot${opts.token}/`,
    timeout: opts.timeout,
    retry: 0,
    signal: opts.signal,
    ...(opts.proxy === "" ? {} : { proxy: opts.proxy })
  })

  const redact = (text: string): string => text.split(opts.token).join("[REDACTED]")

  /**
   * 解包响应外壳
   * @param method 方法名
   * @param status HTTP 状态码
   * @param body 响应体
   * @returns result
   */
  const unwrap = <T>(method: string, status: number, body: unknown): T => {
    const env = (typeof body === "object" && body !== null ? body : undefined) as Envelope | undefined
    if (env === undefined || typeof env.ok !== "boolean") {
      const snippet = typeof body === "string" ? body.slice(0, 200) : (JSON.stringify(body)?.slice(0, 200) ?? "空")
      // 反向代理挂了时常见：回一张 HTML 错误页
      throw new TelegramApiError(method, status, redact(`HTTP ${status} 返回了非预期的响应：${snippet}`))
    }
    if (env.ok) return env.result as T
    const code = env.error_code ?? status
    const description = env.description ?? `HTTP ${status}`
    throw new TelegramApiError(method, code, redact(`${description}${hintOf(code, description)}`), env.parameters?.retry_after)
  }

  /**
   * 发一次请求（不含 429 等待）
   * @param method 方法名
   * @param params 参数
   * @param files 文件字段
   * @param callOpts 调用选项
   * @returns result
   */
  const once = async <T>(
    method: string,
    params: Record<string, unknown>,
    files: Record<string, UploadFile>,
    callOpts: CallOptions
  ): Promise<T> => {
    const multipart = Object.keys(files).length > 0 ? buildMultipart(params, files) : undefined
    let res: { status: number; data: unknown }
    try {
      res = await http.request<unknown>(method, {
        method: "POST",
        ...(multipart === undefined
          ? { json: params }
          : { body: multipart.body, headers: { "Content-Type": multipart.contentType } }),
        ...(callOpts.timeout === undefined ? {} : { timeout: callOpts.timeout }),
        ...(callOpts.signal === undefined ? {} : { signal: callOpts.signal }),
        throwOnError: false
      })
    } catch (err) {
      // 网络层失败：文案里有完整 URL，脱敏后重抛，不挂 cause（见文件头第二点）
      const aborted = opts.signal.aborted || callOpts.signal?.aborted === true
      throw new TelegramApiError(method, 0, aborted ? "请求已取消" : redact(err instanceof Error ? err.message : String(err)))
    }
    return unwrap<T>(method, res.status, res.data)
  }

  return {
    base: opts.base,

    async call<T>(
      method: string,
      params: Record<string, unknown> = {},
      files: Record<string, UploadFile> = {},
      callOpts: CallOptions = {}
    ): Promise<T> {
      if (!METHOD_RE.test(method)) throw new TelegramApiError(method.slice(0, 40), 0, "方法名无效，应为 sendMessage 这样的字母数字")
      const body = compact(params)
      if (method !== "getUpdates") opts.logger.trace(`${method} ${JSON.stringify(body).slice(0, 500)}`)
      try {
        return await once<T>(method, body, files, callOpts)
      } catch (err) {
        // 见文件头第三点：只有 429 是"平台明确没处理"，等一次再发
        if (!(err instanceof TelegramApiError) || err.code !== 429 || err.retryAfter === undefined) throw err
        if (err.retryAfter > MAX_RETRY_AFTER) throw err
        opts.logger.debug(`${method} 触发频率限制，${err.retryAfter} 秒后重试一次`)
        const signal = callOpts.signal === undefined ? opts.signal : AbortSignal.any([opts.signal, callOpts.signal])
        await sleep(err.retryAfter * 1000, signal)
        return once<T>(method, body, files, callOpts)
      }
    },

    fileUrl: filePath => `${opts.base}/file/bot${opts.token}/${filePath.replace(/^\/+/, "")}`,

    redact
  }
}
