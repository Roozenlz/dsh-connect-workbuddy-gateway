# npm 首次发布：待办清单

本文件记录「发布 1.0.0」这件事的当前状态与剩余步骤。完成后可删除。

## 为什么卡住了

为了把首次公开版本从 `2.1.0` 对齐到 `1.0.0`，整包被删除。npm 对整包删除有 **24 小时
重发冷却**：

```
删除时间（UTC）: 2026-11-23 17:49:35
可重发（UTC）:   2026-11-24 17:49:35
可重发（北京）:  2026-11-25 01:49:35
```

## 副作用：OIDC 配置没了

Trusted Publisher 是挂在包上的元数据，整包删除后一起消失（访问 access 页返回 404）。
所以重发之后需要**重新配置一次**，否则 GitHub Actions 无法发布。

## 恢复步骤（按顺序）

### 1. 确认可重发

```bash
npm view dsh-connect-workbuddy-gateway --registry=https://registry.npmjs.org/
# 不再是 E404 "Unpublished on ..." 即可
```

### 2. 本地发布 1.0.0

```bash
cd <repo>
node tests/harness.mjs        # 应全绿（165 项）
npm pack --dry-run            # 应 32 files / ~75 kB
npm publish --registry=https://registry.npmjs.org/ --access public
```

凭据：本机已有 granular token（带 publish 权限、绕过 2FA）。若已失效，重新 `npm login`
或在 npm 网页生成新 token 后 `npm config set //registry.npmjs.org/:_authToken <token>`。

### 3. 重新配置 Trusted Publisher

浏览器打开：

```
https://www.npmjs.com/package/dsh-connect-workbuddy-gateway/access
```

Trusted Publisher → GitHub Actions，填：

| 字段 | 值 |
|---|---|
| Organization | `Roozenlz` |
| Repository | `dsh-connect-workbuddy-gateway` |
| Workflow name | `publish.yml` |
| Environment | 留空 |

勾选 `npm publish` 权限，点 **Set up connection**，用安全密钥完成 2FA。

> 这一步必须人工做：绕过 2FA 的 token 被 npm 禁止执行账号变更类操作
> （`npm trust`、`npm unpublish` 都会 403）。

配好后状态是 **Pending validation**，需要再发布一次才算生效。

### 4. 打 tag 验证 OIDC 链路

```bash
git tag v1.0.0
git push origin v1.0.0
```

工作流会：校验 tag == package.json 版本 → 跑测试 → 用 OIDC 发布。因为 1.0.0 已经
被第 2 步发过，这次会因「版本已存在」失败——这是**预期**的，只用来确认 OIDC 握手
成功（日志里能看到它拿到了凭据，而不是报 401/403）。

要真正验证「CI 能发布」，需要下一个版本：把 `package.json` 改成 `1.0.1`，
提交后推 `v1.0.1`。

### 5. 更新 README

- 把「C. 从 npm」那段 ⚠️ 警告去掉，改成可用
- 确认徽章、仓库链接正确

## 另需清理

```bash
git stash drop          # 清掉一条纯行尾噪音的 stash（内容与 HEAD 一致）
```

以及本地临时文件：`D:\dsh-workspace\.ego-npm\`（浏览器脚本）、
`D:\dsh-workspace\.npm-login.log`。
