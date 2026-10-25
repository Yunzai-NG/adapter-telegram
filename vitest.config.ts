import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { defineConfig } from "vitest/config"

/**
 * 定位框架包的**源码**目录
 *
 * 测试一律解析到框架源码而不是 dist，理由与框架仓库内相同：走 dist 就必须先 build
 * 才能跑测试，忘了就测的是上一版；且 dist 内的相对导入带 `.js` 后缀，会被下方
 * 那条后缀改写规则命中而找不到文件。
 *
 * 三处候选依次尝试：`YZNG_FRAMEWORK` 环境变量、已安装或已链接包内的 `src`、
 * 与插件仓库同祖的框架 checkout。框架包的 `files` 含 `src`，故发布版亦带源码，
 * 第三方插件作者无须 checkout 框架即可跑测试。
 * @param pkg 包名
 * @returns 该包 src 目录的绝对路径；三处均不存在时 undefined
 */
function frameworkSrc(pkg: string): string | undefined {
  const short = pkg.slice("@yunzai-ng/".length)
  const roots: string[] = []
  if (process.env.YZNG_FRAMEWORK) roots.push(resolve(process.env.YZNG_FRAMEWORK, "packages", short))
  try {
    roots.push(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)))
  } catch {
    // 未安装亦未链接，交由其余候选处理
  }
  roots.push(resolve(import.meta.dirname, "..", "..", "code", "packages", short))
  for (const root of roots) {
    if (existsSync(resolve(root, "src", "index.ts"))) return resolve(root, "src")
  }
  return undefined
}

const core = frameworkSrc("@yunzai-ng/core")
const types = frameworkSrc("@yunzai-ng/types")

if (core === undefined || types === undefined) {
  throw new Error(
    "未找到框架源码。请设置 YZNG_FRAMEWORK 指向 yunzai-ng 的 checkout 根目录，" +
      "或先执行 pnpm run link:framework。"
  )
}

export default defineConfig({
  resolve: {
    alias: [
      // 具体子路径要排在裸包名之前，否则 `@yunzai-ng/core` 会先把它匹配掉
      { find: /^@yunzai-ng\/core\/testing$/, replacement: resolve(core, "testing/index.ts") },
      { find: /^@yunzai-ng\/core$/, replacement: resolve(core, "index.ts") },
      { find: /^@yunzai-ng\/types$/, replacement: resolve(types, "index.ts") },
      // 源码里 import 统一带 `.js` 后缀（NodeNext ESM 的硬要求），
      // 但测试时实际文件是 `.ts`，需要把相对导入的后缀改回来
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" }
    ]
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // 内核用到 level/sqlite 等原生模块，串行更稳
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"]
    }
  }
})
