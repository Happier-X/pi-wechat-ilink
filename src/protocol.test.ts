import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROTOCOL_LIMITS,
	decodeHubToPiMessage,
	decodePiToHubMessage,
	parseProtocolMessage,
	serializeMessage,
} from "./protocol.js";

describe("decodePiToHubMessage", () => {
	it("接受最小合法 register", () => {
		const raw = serializeMessage({
			type: "register",
			displayName: "demo",
			cwd: "/tmp/demo",
			pid: 1,
		});
		const r = decodePiToHubMessage(raw);
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.message.type, "register");
	});

	it("拒绝缺字段 / 错误类型 / 未知枚举", () => {
		assert.equal(decodePiToHubMessage("{}").ok, false);
		assert.equal(decodePiToHubMessage(JSON.stringify({ type: "heartbeat" })).ok, false);
		assert.equal(
			decodePiToHubMessage(
				JSON.stringify({ type: "heartbeat", piId: "a", status: "running", ts: 1 }),
			).ok,
			false,
		);
		assert.equal(
			decodePiToHubMessage(
				JSON.stringify({ type: "heartbeat", piId: "a", status: "idle", ts: Number.NaN }),
			).ok,
			false,
		);
	});

	it("拒绝 Hub→Pi 方向消息与未知 type", () => {
		const wrong = decodePiToHubMessage(JSON.stringify({ type: "register_ok", piId: "x" }));
		assert.equal(wrong.ok, false);
		if (!wrong.ok) assert.equal(wrong.code, "wrong_direction");
		const unknown = decodePiToHubMessage(JSON.stringify({ type: "nope" }));
		assert.equal(unknown.ok, false);
		if (!unknown.ok) assert.equal(unknown.code, "unknown_type");
	});

	it("拒绝超长字段与过大帧", () => {
		const longTitle = decodePiToHubMessage(
			JSON.stringify({
				type: "notify",
				piId: "a",
				event: "task_end",
				requestId: "r",
				title: "t".repeat(PROTOCOL_LIMITS.title + 1),
				body: "b",
			}),
		);
		assert.equal(longTitle.ok, false);
		if (!longTitle.ok) assert.equal(longTitle.code, "too_long");

		const huge = "x".repeat(PROTOCOL_LIMITS.frameBytes + 10);
		const frame = decodePiToHubMessage(huge);
		assert.equal(frame.ok, false);
		if (!frame.ok) assert.ok(frame.code === "frame_too_large" || frame.code === "invalid_json");
	});

	it("接受 approval_result_ack", () => {
		const r = decodePiToHubMessage(
			JSON.stringify({ type: "approval_result_ack", piId: "a", requestId: "r" }),
		);
		assert.equal(r.ok, true);
	});

	it("接受 queue_report", () => {
		const r = decodePiToHubMessage(
			JSON.stringify({ type: "queue_report", piId: "a", text: "空" }),
		);
		assert.equal(r.ok, true);
	});

	it("合法 notify 含 actions", () => {
		const r = decodePiToHubMessage(
			JSON.stringify({
				type: "notify",
				piId: "a1",
				event: "approval",
				requestId: "req",
				title: "t",
				body: "b",
				actions: ["approve", "reject"],
				timeoutMs: 1000,
			}),
		);
		assert.equal(r.ok, true);
	});
});

describe("decodeHubToPiMessage", () => {
	it("接受 queue_control", () => {
		const r = decodeHubToPiMessage(
			JSON.stringify({ type: "queue_control", piId: "a", action: "cancel", id: "q1" }),
		);
		assert.equal(r.ok, true);
		if (r.ok && r.message.type === "queue_control") {
			assert.equal(r.message.action, "cancel");
			assert.equal(r.message.id, "q1");
		}
	});

	it("接受 register_ok / user_message / approval_result", () => {
		assert.equal(decodeHubToPiMessage(JSON.stringify({ type: "register_ok", piId: "a" })).ok, true);
		assert.equal(
			decodeHubToPiMessage(
				JSON.stringify({
					type: "user_message",
					piId: "a",
					text: "hi",
					source: "default",
				}),
			).ok,
			true,
		);
		assert.equal(
			decodeHubToPiMessage(
				JSON.stringify({
					type: "approval_result",
					piId: "a",
					requestId: "r",
					decision: "approve",
				}),
			).ok,
			true,
		);
	});

	it("拒绝 Pi→Hub 方向与非法 decision", () => {
		const wrong = decodeHubToPiMessage(
			JSON.stringify({ type: "register", displayName: "d", cwd: "/", pid: 1 }),
		);
		assert.equal(wrong.ok, false);
		if (!wrong.ok) assert.equal(wrong.code, "wrong_direction");
		assert.equal(
			decodeHubToPiMessage(
				JSON.stringify({
					type: "approval_result",
					piId: "a",
					requestId: "r",
					decision: "maybe",
				}),
			).ok,
			false,
		);
	});
});

describe("parseProtocolMessage 兼容", () => {
	it("合法双向消息可解析，非法返回 null", () => {
		assert.ok(parseProtocolMessage(JSON.stringify({ type: "register_ok", piId: "x" })));
		assert.ok(
			parseProtocolMessage(
				JSON.stringify({ type: "register", displayName: "d", cwd: "/", pid: 1 }),
			),
		);
		assert.equal(parseProtocolMessage("{"), null);
		assert.equal(parseProtocolMessage(JSON.stringify({ type: "nope" })), null);
	});
});
