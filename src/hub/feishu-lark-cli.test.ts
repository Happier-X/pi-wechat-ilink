/**
 * LarkCliFeishuTransport 单测：mock runCommand，不调用真实 lark-cli。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractMessageId,
	formatOutboundText,
	LarkCliFeishuTransport,
	type LarkCliRunner,
} from "./feishu-lark-cli.js";
import { parseInboundEvent } from "./feishu-inbound.js";

describe("extractMessageId", () => {
	it("扁平 message_id", () => {
		assert.equal(
			extractMessageId(JSON.stringify({ message_id: "om_abc123" })),
			"om_abc123",
		);
	});

	it("嵌套 data.message_id", () => {
		assert.equal(
			extractMessageId(
				JSON.stringify({ ok: true, data: { message_id: "om_nested99" } }),
			),
			"om_nested99",
		);
	});

	it("无法解析 → null", () => {
		assert.equal(extractMessageId("not json"), null);
		assert.equal(extractMessageId("{}"), null);
	});
});

describe("formatOutboundText", () => {
	it("含 title / piId / requestId", () => {
		const t = formatOutboundText({
			title: "任务结束",
			body: "摘要内容",
			piId: "a1",
			event: "task_end",
			requestId: "req-1",
		});
		assert.match(t, /任务结束/);
		assert.match(t, /piId: a1/);
		assert.match(t, /requestId: req-1/);
		assert.match(t, /摘要内容/);
	});
});

describe("LarkCliFeishuTransport", () => {
	it("send 拼装参数并解析 message_id", async () => {
		const calls: string[][] = [];
		const runCommand: LarkCliRunner = async (args) => {
			calls.push(args);
			return {
				code: 0,
				stdout: JSON.stringify({ message_id: "om_from_cli" }),
				stderr: "",
			};
		};

		const t = new LarkCliFeishuTransport({
			userId: "ou_op",
			as: "bot",
			runCommand,
			log: () => {},
		});

		const r = await t.send({
			title: "Hello",
			body: "world",
			piId: "p1",
			event: "task_end",
			requestId: "r1",
		});
		assert.equal(r.messageId, "om_from_cli");
		assert.equal(calls.length, 1);
		const args = calls[0]!;
		assert.ok(args.includes("im"));
		assert.ok(args.includes("+messages-send"));
		assert.ok(args.includes("--user-id"));
		assert.ok(args.includes("ou_op"));
		assert.ok(args.includes("--json"));
		assert.equal(t.history.length, 1);
	});

	it("cli 非 0 退出 → throw", async () => {
		const t = new LarkCliFeishuTransport({
			chatId: "oc_1",
			runCommand: async () => ({
				code: 1,
				stdout: "",
				stderr: "auth failed",
			}),
			log: () => {},
		});
		await assert.rejects(
			() => t.send({ body: "x" }),
			/lark-cli|失败|auth/,
		);
	});

	it("无法解析 message_id → throw", async () => {
		const t = new LarkCliFeishuTransport({
			userId: "ou_1",
			runCommand: async () => ({
				code: 0,
				stdout: JSON.stringify({ ok: true }),
				stderr: "",
			}),
			log: () => {},
		});
		await assert.rejects(() => t.send({ body: "x" }), /message_id/);
	});

	it("缺少 recipient → 构造允许，send 失败；setRecipient 后可发", async () => {
		const t = new LarkCliFeishuTransport({
			runCommand: async () => ({
				code: 0,
				stdout: JSON.stringify({ message_id: "om_boot" }),
				stderr: "",
			}),
			log: () => {},
		});
		await assert.rejects(() => t.send({ body: "x" }), /收件人|userId|chatId/);
		t.setRecipient({ userId: "ou_bound" });
		const r = await t.send({ body: "hello" });
		assert.equal(r.messageId, "om_boot");
	});

	it("sendApprovalCard 含批准说明", async () => {
		let textArg = "";
		const t = new LarkCliFeishuTransport({
			userId: "ou_1",
			runCommand: async (args) => {
				const i = args.indexOf("--text");
				textArg = args[i + 1] ?? "";
				return {
					code: 0,
					stdout: JSON.stringify({ message_id: "om_card1" }),
					stderr: "",
				};
			},
			log: () => {},
		});
		const r = await t.sendApprovalCard({
			body: "rm -rf /",
			requestId: "abcd-efgh-ijkl",
			piId: "p1",
			event: "approval",
			actions: ["approve", "reject"],
		});
		assert.equal(r.messageId, "om_card1");
		assert.match(textArg, /批准 abcd-efg/);
		assert.match(textArg, /\/control\/approval/);
	});
});

describe("parseInboundEvent", () => {
	it("扁平 schema 字段", () => {
		const p = parseInboundEvent({
			sender_id: "ou_user1",
			content: "列表",
			message_id: "om_msg1",
			chat_id: "oc_c1",
			chat_type: "p2p",
		});
		assert.ok(p);
		assert.equal(p!.openId, "ou_user1");
		assert.equal(p!.text, "列表");
		assert.equal(p!.messageId, "om_msg1");
	});

	it("content 为 text JSON", () => {
		const p = parseInboundEvent({
			sender_id: "ou_2",
			content: JSON.stringify({ text: "使用 a1" }),
		});
		assert.equal(p?.text, "使用 a1");
	});

	it("parent_id 作为 replyToMessageId", () => {
		const p = parseInboundEvent({
			sender_id: "ou_3",
			content: "继续",
			parent_id: "om_parent",
		});
		assert.equal(p?.replyToMessageId, "om_parent");
	});
});
