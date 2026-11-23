/** 模型名 → 一次真实调用。把「目录读取」与「策略解析」装起来。 */

import { listModels } from './backend.js'
import { resolveTarget } from './resolve.js'

/**
 * 解析一次调用的目标。
 * @param ctx 宿主上下文
 * @param config 插件级配置
 * @param providers workbuddy 系 provider 路由
 * @param keyEntry 这次请求所用 API key 的配置
 * @param requested 请求体里的 model
 */
export function resolve(ctx, config, providers, keyEntry, requested) {
  return resolveTarget(ctx, providers, keyEntry, requested, config, listModels)
}
