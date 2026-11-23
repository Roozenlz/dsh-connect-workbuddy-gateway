/**
 * 自测用的账号表注入。
 *
 * 真实账号取决于本机 WorkBuddy 登录状态，端到端测试不该依赖它。生产路径仍走
 * `$DSH_HOME/workbuddy-vault/`（见 src/accounts.js），这里只把它换成内存表。
 */

import { stubAccounts as install } from '../src/accounts.js'

/**
 * @param vault `{ cn: [{id,name}], global: [...] }`
 */
export function stubAccounts(vault) {
  install(vault)
}
