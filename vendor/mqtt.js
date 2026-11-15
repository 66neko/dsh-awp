/**
 * 运行时依赖的加载入口。
 *
 * 模块解析会从本文件所在目录向上找 node_modules，因此会命中
 * vendor/node_modules/mqtt，不依赖包外安装的依赖。
 * 由 scripts/vendor-deps.mjs 生成，请勿手改。
 */
import mqtt from 'mqtt'

export const connect = mqtt.connect
export default mqtt
