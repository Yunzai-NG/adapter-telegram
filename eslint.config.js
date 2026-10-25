// @ts-check
import js from "@eslint/js"
import tsParser from "@typescript-eslint/parser"
import tsPlugin from "@typescript-eslint/eslint-plugin"
import jsdoc from "eslint-plugin-jsdoc"

/**
 * Yunzai NG 插件代码风格 —— 与框架仓库 eslint.config.js 保持一致
 *
 * 三条硬规则，其余尽量宽松：
 * 1. 每个导出符号必须有中文 TSDoc。
 * 2. 禁止读写全局 Bot / redis / logger，一律走 ctx。
 * 3. 禁止深引内核内部实现 —— 框架仓库内该约束由 scripts/check-layering.mjs 断言，
 *    插件独立成库后门禁不再覆盖此处，故以 no-restricted-imports 等价替代。
 */
export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"]
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { project: false }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      jsdoc
    },
    rules: {
      /* --- 基础 --- */
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "no-undef": "off",
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": ["error", "properties"],

      /* --- 分层：只许走内核的公开入口 --- */
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `@yunzai-ng/core/testing` 是 core 的 exports 里声明过的公开入口
              // （给插件作者写测试用），放行；其余任何子路径都是内部实现。
              group: ["@yunzai-ng/core/*", "!@yunzai-ng/core/testing"],
              message: "禁止深引内核内部实现，请只用 @yunzai-ng/core 的公开入口"
            },
            {
              group: ["#miao", "#miao.models", "#yunzai"],
              message: "Miao-Yunzai 的包别名，本框架不提供，请改用 @yunzai-ng/core"
            }
          ]
        }
      ],

      /* --- 反全局污染：本次重写的核心约束之一 --- */
      "no-restricted-globals": [
        "error",
        { name: "Bot", message: "禁用全局 Bot，请用 ctx / event.bot" },
        { name: "redis", message: "禁用全局 redis，请用 ctx.kv" },
        { name: "logger", message: "禁用全局 logger，请用 ctx.logger" },
        { name: "segment", message: "禁用全局 segment，请从 @yunzai-ng/core 导入 seg" },
        { name: "Renderer", message: "禁用全局 Renderer，请用 ctx.render" },
        { name: "plugin", message: "禁用全局 plugin 基类，请用 definePlugin" }
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", message: "禁止在 globalThis 上挂载状态" }
      ],

      /* --- 注释：统一中文 TSDoc --- */
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true
          },
          contexts: [
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
            "TSPropertySignature",
            "TSMethodSignature"
          ]
        }
      ],
      "jsdoc/require-param-description": "warn",
      "jsdoc/require-returns-description": "warn",
      "jsdoc/no-types": "error",
      "jsdoc/check-alignment": "warn",
      "jsdoc/tag-lines": "off"
    },
    settings: {
      jsdoc: { mode: "typescript" }
    }
  },
  {
    /**
     * 构建脚本跑在 Node 里，但 `js.configs.recommended` 只认浏览器无关的语言内建，
     * 不认 `console`/`process`。这里显式声明，而不是把 `no-undef` 关掉 ——
     * 关掉就连真正的拼写错误也一起放过了。
     */
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        structuredClone: "readonly"
      }
    }
  },
  {
    files: ["**/*.test.ts", "scripts/**/*.mjs", "vitest.config.ts"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "no-console": "off"
    }
  }
]
