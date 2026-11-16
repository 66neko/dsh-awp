# vendor/

本目录由 `scripts/vendor-deps.mjs` 从 pnpm 安装结果复制而来，目的是让插件包
**离线可安装**：安装 .tgz 时不再需要访问 npm 源。

- 入口包：`mqtt`
- 包数：42
- 体积：7.70 MB

- Node 内置模块兼容性：生成脚本会把 vendored 代码中的 `require('<内置模块>/')` 规范化为 `require('node:<内置模块>')`，仅处理 Node 内置模块且可重复运行。

重新生成：`pnpm run vendor`（需要先 `pnpm install`）。

各依赖的许可证见其各自目录下的 LICENSE 文件。
