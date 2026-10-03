'use strict';

/** core 公共入口：纯 Node，不依赖 Electron，便于单测与复用为 CLI / 其他宿主。 */

module.exports = {
  schema: require('./schema'),
  sources: require('./sources'),
  llm: require('./llm'),
  extract: require('./extract'),
  resolve: require('./resolve'),
  store: require('./store'),
  audit: require('./audit'),
  pipeline: require('./pipeline'),
  runConversion: require('./pipeline').runConversion,
};