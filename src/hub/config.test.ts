import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultHubConfig, formatConfigSummary, loadHubConfig, resetNativeConfig, saveNativeSetupConfig, validateHubConfig } from "./config.js";

describe("原生 Hub 配置", () => {
 it("默认仅 native 且尚未绑定",()=>{const c=createDefaultHubConfig();assert.equal(c.feishu.mode,"native");assert.deepEqual(c.allowedOpenIds,[]);assert.equal(c.requireAllowlist,false)});
 it("可信主人配置通过",()=>{const c=createDefaultHubConfig();c.allowedOpenIds=["ou_owner"];c.feishu.userId="ou_owner";c.requireAllowlist=true;assert.deepEqual(validateHubConfig(c),[])});
 it("拒绝群聊、多主人和缺少收件人",()=>{const c=createDefaultHubConfig();c.allowedOpenIds=["a","b"];c.feishu.chatId="oc_x";const codes=validateHubConfig(c).map(e=>e.code);assert.ok(codes.includes("chat_recipient_removed"));assert.ok(codes.includes("missing_recipient"));assert.ok(codes.includes("multiple_owners"))});
 it("setup 写唯一主人，reset 清理飞书字段",()=>{const dir=mkdtempSync(path.join(os.tmpdir(),"lark-config-"));const file=path.join(dir,"config.json");const saved=saveNativeSetupConfig({configPath:file,ownerOpenId:"ou_owner"});assert.deepEqual(saved.config.allowedOpenIds,["ou_owner"]);assert.equal(saved.config.feishu.userId,"ou_owner");resetNativeConfig({configPath:file});const raw=JSON.parse(readFileSync(file,"utf8"));assert.equal(raw.feishu,undefined);assert.equal(raw.allowedOpenIds,undefined)});
 it("摘要脱敏",()=>{const c=createDefaultHubConfig();c.allowedOpenIds=["ou_1234567890"];c.feishu.userId="ou_1234567890";const text=formatConfigSummary(c);assert.ok(!text.includes("ou_1234567890"))});
});
