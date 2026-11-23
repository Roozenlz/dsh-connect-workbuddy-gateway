/** 模型名 → 一次真实调用。把「账号表」与「清单解析」装起来。 */

import { resolveTarget } from './resolve.js'
import { allAccounts } from './accounts.js'

/**
 * 解析一次调用的目标。
 * @param providers workbuddy 系 provider 路由
 * @param keyEntry 这次请求所用 API key
 * @param requested 请求体里的 model
 * @param config 插件级配置（`enableGlobal`）
 */
export function resolve(providers, keyEntry, requested, config) {
  const regions = config?.enableGlobal === false ? ['cn'] : ['cn', 'global']
  return resolveTarget(providers, keyEntry, allAccounts(regions), requested)
}
