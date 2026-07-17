/**
 * pi-lark-hub 默认扩展入口。
 *
 * 仅 re-export lark-bridge，保持旧 `pi install` / `pi.extensions` 路径兼容。
 * 真正实现见 `./lark-bridge/index.ts`。
 */
export { default } from "./lark-bridge/index.js";
