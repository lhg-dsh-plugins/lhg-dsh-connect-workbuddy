# 上游出处（UPSTREAM）

- 上游仓库：https://github.com/dingminhua/dsh-connect-workbuddy
- 固定提交（HEAD SHA）：`4cdba8a37b277a465b754328737f580254552d34`
- 上游版本：5.6.2（`package.json`）
- 许可证：MIT（`LICENSE` 原样保留，作者署名未改动）
- 原作者：dingminhua
- 拉取日期：2026-10-23
- 仓库核对：`gh api repos/dingminhua/dsh-connect-workbuddy` 返回的 `full_name` 与请求一致，无改名/重定向。

## 本修复版

- 版本：5.6.3
- 落点：https://github.com/lhg-dsh-plugins/lhg-dsh-connect-workbuddy
- 改动范围：`src/adapter.ts`（修复本体）+ `tests/adapter-unusable-route-default.spec.ts`（新增回归测试）；其余上游文件一字未动。另新增本文件与 `BUGFIX.md`，并在 `README.md` 顶部加 fork 说明、`CHANGELOG.md` 顶部加 5.6.3 条目、`package.json` 同步版本号与 `repository.url`（`src/version.ts` 的版本为构建期由 tsdown 自 `package.json` 注入，无源码字面量需同步；`pnpm-lock.yaml` 无根包版本字段）。


---

## 修复版版权

本修复版的修改部分 © 2026 lhg-dsh-plugins（刘洪光），修改内容见 [BUGFIX.md](./BUGFIX.md)；原始代码版权归原作者所有，见仓库内 LICENSE 与上方出处。
