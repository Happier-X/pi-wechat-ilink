#!/usr/bin/env node
import { assertValidHubConfig, formatConfigSummary, loadHubConfig } from "./config.js";
import { loadCredentials } from "./credentials.js";
import { NativeFeishuTransport, NativeFeishuWsInbound } from "./feishu-native.js";
import { NoopFeishuTransport } from "./feishu-transport.js";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, startHubServer } from "./server.js";

function parseArgs(argv: string[]): { port?: number; host?: string; help?: boolean } { const out: { port?: number; host?: string; help?: boolean } = {}; for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a==="--help"||a==="-h") out.help=true; else if (a==="--port"||a==="-p") out.port=Number(argv[++i]); else if (a==="--host") out.host=argv[++i]; else if (a.startsWith("--port=")) out.port=Number(a.slice(7)); else throw new Error(`未知参数: ${a}`); } return out; }
function help() { console.log(`pi-lark-hub\n用法: pi-lark-hub [--port ${DEFAULT_HUB_PORT}] [--host ${DEFAULT_HUB_HOST}]\n飞书只支持 /lark 官方扫码后的原生 OpenAPI + WebSocket。`); }
async function main() {
 const args=parseArgs(process.argv.slice(2)); if(args.help){help();return;}
 const config=loadHubConfig(); if(args.port) config.port=args.port; if(args.host && !["127.0.0.1","localhost"].includes(args.host)) throw new Error("Hub 仅允许 loopback"); assertValidHubConfig(config);
 console.log(`[pi-lark-hub] 配置摘要:\n${formatConfigSummary(config)}`);
 const credentials=loadCredentials();
 const transport=credentials ? new NativeFeishuTransport(credentials,{userId:config.feishu.userId}) : new NoopFeishuTransport();
 let inboundStop:(()=>void)|undefined;
 const hub=await startHubServer({host:config.host,port:config.port,feishu:transport,allowedOpenIds:config.allowedOpenIds,hubConfig:config,
  onNativeRuntime:async(candidate,creds,server)=>{const ws=new NativeFeishuWsInbound(creds,{onMessage:async input=>{const r=await server.handleInboundMessage(input);return{ok:r.ok,reply:r.reply}},replyToUser:async text=>{await candidate.send({body:text})}},{log:console.log});await ws.start();const stop=()=>ws.stop();inboundStop=stop;return stop},
  onReady:async server=>{if(!credentials)return;const ws=new NativeFeishuWsInbound(credentials,{onMessage:async input=>{const r=await server.handleInboundMessage(input);return{ok:r.ok,reply:r.reply}},replyToUser:async text=>{await server.feishu.send({body:text})}},{log:console.log});await ws.start();const stop=()=>ws.stop();inboundStop=stop;return stop}
 });
 console.log(`[pi-lark-hub] 已启动 http://${hub.host}:${hub.port}；${credentials?"原生飞书已连接":"等待 Pi 执行 /lark 扫码"}`);
 const shutdown=async()=>{inboundStop?.();await hub.close();process.exit(0)};process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
}
main().catch(e=>{console.error("[pi-lark-hub] 启动失败:",e instanceof Error?e.message:e);process.exit(1)});
