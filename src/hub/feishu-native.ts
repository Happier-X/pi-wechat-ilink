import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuCredentials } from "./credentials.js";
import type { InboundControlHandlers } from "./feishu-native-inbound.js";
import { parseInboundEvent } from "./feishu-native-inbound.js";
import type { FeishuOutboundMessage, FeishuSendResult, FeishuTransport } from "./feishu-transport.js";

export type NativeClientLike = { im: { message: { create(input: unknown): Promise<any> } }; request?(input: unknown): Promise<any> };
export class NativeFeishuTransport implements FeishuTransport {
 private userId?: string; private chatId?: string;
 constructor(private credentials: FeishuCredentials, options: { userId?: string; chatId?: string; client?: NativeClientLike } = {}) { this.userId = options.userId; this.chatId = options.chatId; this.client = options.client ?? new Lark.Client({ appId: credentials.appId, appSecret: credentials.appSecret, appType: Lark.AppType.SelfBuild, domain: credentials.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu }) as unknown as NativeClientLike; }
 private client: NativeClientLike;
 setRecipient(input: { userId?: string; chatId?: string }) { if (input.userId && input.chatId) throw new Error("原生飞书收件人不能同时设置 userId/chatId"); this.userId = input.userId; this.chatId = input.chatId; }
 async send(message: FeishuOutboundMessage): Promise<FeishuSendResult> {
  const receiveId = this.userId ?? this.chatId; if (!receiveId) throw new Error("原生飞书尚未绑定主人，请执行 /lark");
  try { const r = await this.client.im.message.create({ params: { receive_id_type: this.userId ? "open_id" : "chat_id" }, data: { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text: [message.title, message.body].filter(Boolean).join("\n") }) } }); const id = r?.data?.message_id ?? r?.message_id; if (!id) throw new Error("响应缺少 message_id"); return { messageId: id }; }
  catch (e) { throw new Error(`原生飞书发送失败：${e instanceof Error ? e.message : String(e)}`); }
 }
 async probeBotOpenId(): Promise<string | undefined> { const r = await this.client.request?.({ method: "GET", url: "/open-apis/bot/v3/info" }); return r?.bot?.open_id ?? r?.data?.bot?.open_id; }
}

export type NativeWsConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";
export type NativeWsLike = {
 start(input: { eventDispatcher: unknown }): Promise<void> | void;
 getConnectionStatus(): { state: NativeWsConnectionState };
 close?(input?: { force?: boolean }): void;
};
export class NativeFeishuWsInbound {
 private ws: NativeWsLike; private dispatcher: any; private readyTimeoutMs: number; private readyPollMs: number;
 constructor(credentials: FeishuCredentials, private handlers: InboundControlHandlers, options: { ws?: NativeWsLike; dispatcher?: any; log?: (s: string) => void; readyTimeoutMs?: number; readyPollMs?: number } = {}) {
  this.log = options.log ?? console.log; this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000; this.readyPollMs = options.readyPollMs ?? 25;
  this.dispatcher = options.dispatcher ?? new Lark.EventDispatcher({}).register({ "im.message.receive_v1": (raw: unknown) => void this.accept(raw) });
  this.ws = options.ws ?? new Lark.WSClient({ appId: credentials.appId, appSecret: credentials.appSecret, domain: credentials.brand === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu, handshakeTimeoutMs: this.readyTimeoutMs }) as unknown as NativeWsLike;
 }
 private log: (s: string) => void;
 async start() {
  const deadline = Date.now() + this.readyTimeoutMs;
  let startTimer: NodeJS.Timeout | undefined;
  try {
   await Promise.race([
    Promise.resolve(this.ws.start({ eventDispatcher: this.dispatcher })),
    new Promise<never>((_, reject) => { startTimer = setTimeout(() => reject(new Error(`WebSocket SDK start 超时（${this.readyTimeoutMs}ms）`)), this.readyTimeoutMs); }),
   ]);
  } finally { if (startTimer) clearTimeout(startTimer); }
  this.log("[feishu-native] WebSocket 已发起连接，等待握手完成");
  while (Date.now() < deadline) {
   const state = this.ws.getConnectionStatus().state;
   if (state === "connected") { this.log("[feishu-native] WebSocket 已连接"); return; }
   if (state === "failed") throw new Error("WebSocket 连接失败");
   await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
  }
  throw new Error(`WebSocket 连接就绪超时（${this.readyTimeoutMs}ms）`);
 }
 stop() { this.ws.close?.({ force: true }); }
 async accept(raw: unknown) { const p = parseInboundEvent(raw); if (!p?.text) return; try { const r = await this.handlers.onMessage({ text: p.text, openId: p.openId, replyToMessageId: p.replyToMessageId }); if (r.reply && this.handlers.replyToUser) await this.handlers.replyToUser(r.reply); } catch (e) { this.log(`[feishu-native] 入站处理失败：${e instanceof Error ? e.message : String(e)}`); } }
}
