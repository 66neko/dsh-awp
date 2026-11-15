# vendor/

本目录由 `scripts/vendor-deps.mjs` 从 pnpm 安装结果复制而来，目的是让插件包
**离线可安装**：安装 .tgz 时不再需要访问 npm 源。

- 入口包：`mqtt`
- 包数：42
- 体积：7.70 MB

重新生成：`pnpm run vendor`（需要先 `pnpm install`）。

各依赖的许可证见其各自目录下的 LICENSE 文件。
