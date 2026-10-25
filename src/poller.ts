/**
 * 模块职责：`getUpdates` 长轮询 —— 取更新、推进 offset、失败退避、致命错误时上报
 * 依赖方向：依赖 api 与内核的 `sleep`
 * 生命周期：一次连接一个实例；`start()` / `stop()` 各一次
 * 注意事项：**一、offset 先推进、后处理，并持久化。** 推进 offset 等于告诉 Telegram"这一批收到了"。
 *          若进程在处理途中退出、offset 没落盘，重启后这一批会再来一遍 —— 用户收到两条回复。
 *          故每处理完一批就把 offset 写进账号的 KV；处理单条出错只记日志、照样推进，
 *          否则一条解码必崩的消息会让轮询永远卡在原地。
 *
 *          **二、只在致命时上报断线。** 网络抖动、代理偶尔超时是常态，每次都让内核拆掉重建，面板上
 *          的状态会一直在"在线 / 离线"之间跳。故连续失败 `MAX_FAILURES` 次以内自己退避重试；
 *          token 失效（401 / 404）与另一处在收（409）立即上报，交给内核退避重连 —— 重连时的
 *          `getMe` 会给出一句可照着改的错误。
 *
 *          **三、停下就不再投递。** `stop()` 之后在途的长轮询被中止；就算回包已经在路上，
 *          循环也会在投递前检查一次，不让它漏进来。
 */
import { sleep } from "@yunzai-ng/core"
import type { Logger } from "@yunzai-ng/types"
import { TelegramApiError } from "./api.js"
import type { TelegramApi } from "./api.js"
import type { TgUpdate } from "./types.js"

/** 长轮询的服务端等待秒数（Bot API 上限 50） */
export const POLL_TIMEOUT = 50

/** 订阅的更新类型 */
export const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const

/** 连续失败多少次后上报断线 */
const MAX_FAILURES = 3

/** 时间参数（测试里调小） */
export interface PollerTimings {
  /** 服务端等待秒数 */
  pollTimeout: number
  /** 首次退避毫秒 */
  backoff: number
  /** 退避上限毫秒 */
  maxBackoff: number
}

/** 轮询器的外部依赖 */
export interface PollerOptions {
  /** API 客户端 */
  api: TelegramApi
  /** 日志器 */
  logger: Logger
  /** 起始 offset（持久化读出的值；0 为从头取） */
  offset: number
  /**
   * 持久化 offset
   * @param offset 下一次请求的 offset
   */
  saveOffset(offset: number): Promise<void>
  /**
   * 处理一个更新（串行调用，前一个处理完才给下一个）
   * @param update 更新
   */
  onUpdate(update: TgUpdate): Promise<void>
  /**
   * 意外停止（致命错误或连续失败）
   * @param reason 原因
   */
  onClosed(reason: string): void
  /** 时间参数 */
  timings?: Partial<PollerTimings>
}

/** 长轮询器 */
export class Poller {
  /** 依赖 */
  readonly #opts: PollerOptions
  /** 时间参数 */
  readonly #timings: PollerTimings
  /** 停止信号 */
  readonly #controller = new AbortController()
  /** 下一次请求的 offset */
  #offset: number
  /** 循环本身 */
  #task: Promise<void> | undefined

  /**
   * @param opts 外部依赖
   */
  constructor(opts: PollerOptions) {
    this.#opts = opts
    this.#offset = opts.offset
    this.#timings = { pollTimeout: POLL_TIMEOUT, backoff: 1000, maxBackoff: 30_000, ...opts.timings }
  }

  /** 是否在轮询中 */
  get running(): boolean {
    return this.#task !== undefined && !this.#controller.signal.aborted
  }

  /** 当前 offset（测试用） */
  get offset(): number {
    return this.#offset
  }

  /** 轮询循环 */
  async #loop(): Promise<void> {
    const signal = this.#controller.signal
    const { pollTimeout } = this.#timings
    let failures = 0
    while (!signal.aborted) {
      let updates: TgUpdate[]
      try {
        updates = await this.#opts.api.call<TgUpdate[]>(
          "getUpdates",
          { offset: this.#offset > 0 ? this.#offset : undefined, timeout: pollTimeout, allowed_updates: ALLOWED_UPDATES },
          {},
          // HTTP 超时要比服务端等待更久，否则每一轮空等都会被当成超时
          { signal, timeout: (pollTimeout + 15) * 1000 }
        )
      } catch (err) {
        if (signal.aborted) return
        failures++
        const message = err instanceof Error ? err.message : String(err)
        const fatal = err instanceof TelegramApiError && (err.code === 401 || err.code === 404 || err.code === 409)
        if (fatal || failures >= MAX_FAILURES) {
          this.#controller.abort()
          this.#opts.onClosed(fatal ? message : `连续 ${failures} 次拉取更新失败：${message}`)
          return
        }
        const hinted = err instanceof TelegramApiError && err.retryAfter !== undefined ? err.retryAfter * 1000 : 0
        const wait = Math.max(hinted, Math.min(this.#timings.backoff * 2 ** (failures - 1), this.#timings.maxBackoff))
        this.#opts.logger.warn(`拉取更新失败（第 ${failures} 次），${Math.round(wait / 1000)} 秒后重试：${message}`)
        await sleep(wait, signal).catch(() => undefined)
        continue
      }
      failures = 0
      if (updates.length === 0) continue

      const before = this.#offset
      for (const update of updates) {
        // 见文件头第三点；未处理的那几条 offset 不推进，下次连上会再来
        if (signal.aborted) break
        this.#offset = Math.max(this.#offset, update.update_id + 1)
        try {
          await this.#opts.onUpdate(update)
        } catch (err) {
          this.#opts.logger.error(`处理更新 ${update.update_id} 失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (this.#offset !== before) {
        await this.#opts.saveOffset(this.#offset).catch((err: unknown) => {
          this.#opts.logger.warn(`保存更新进度失败，重启后可能重复处理少量消息：${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }

  /** 开始轮询；重复调用无效 */
  start(): void {
    if (this.#task !== undefined || this.#controller.signal.aborted) return
    this.#task = this.#loop().finally(() => {
      this.#task = undefined
    })
  }

  /**
   * 停止轮询并等循环退出
   * @returns 循环退出后兑现
   */
  async stop(): Promise<void> {
    this.#controller.abort()
    await this.#task
  }
}
