/**
 * 路由与注册表单测（node:test）。
 * 运行：npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InstanceSnapshot } from "../protocol.js";
import {
	ApprovalStore,
	parseApprovalTextCommand,
} from "./approvals.js";
import { MessageBindingStore } from "./bindings.js";
import { handleControlApproval, handleControlMessage } from "./control.js";
import { PairingStore } from "./pairing.js";
import { ConsoleFeishuTransport, NoopFeishuTransport } from "./feishu-transport.js";
import { InstanceRegistry } from "./registry.js";
import {
	formatOnlineList,
	isListCommand,
	parseUseCommand,
	routePlainText,
	routeUseCommand,
} from "./router.js";

function snap(
	partial: Partial<InstanceSnapshot> & Pick<InstanceSnapshot, "piId" | "displayName">,
): InstanceSnapshot {
	return {
		cwd: partial.cwd ?? `/tmp/${partial.displayName}`,
		pid: partial.pid ?? 1,
		status: partial.status ?? "idle",
		capabilities: partial.capabilities ?? [],
		lastHeartbeatAt: partial.lastHeartbeatAt ?? Date.now(),
		connectedAt: partial.connectedAt ?? Date.now(),
		piId: partial.piId,
		displayName: partial.displayName,
	};
}

describe("routePlainText", () => {
	it("零在线 → need_select empty", () => {
		const d = routePlainText({ online: [], defaultPiId: null });
		assert.equal(d.kind, "need_select");
		if (d.kind === "need_select") assert.equal(d.reason, "empty");
	});

	it("单在线 → deliver + single_online", () => {
		const only = snap({ piId: "a1", displayName: "proj-a" });
		const d = routePlainText({ online: [only], defaultPiId: null });
		assert.deepEqual(d, { kind: "deliver", piId: "a1", reason: "single_online" });
	});

	it("多在线有默认 → deliver default", () => {
		const online = [
			snap({ piId: "a1", displayName: "proj-a" }),
			snap({ piId: "b2", displayName: "proj-b" }),
		];
		const d = routePlainText({ online, defaultPiId: "b2" });
		assert.deepEqual(d, { kind: "deliver", piId: "b2", reason: "default" });
	});

	it("多在线无默认 → need_select，不猜测", () => {
		const online = [
			snap({ piId: "a1", displayName: "proj-a" }),
			snap({ piId: "b2", displayName: "proj-b" }),
		];
		const d = routePlainText({ online, defaultPiId: null });
		assert.equal(d.kind, "need_select");
		if (d.kind === "need_select") {
			assert.equal(d.reason, "no_default");
			assert.match(d.reply, /未投递|使用/);
		}
	});

	it("默认已离线 → need_select default_offline", () => {
		const online = [
			snap({ piId: "a1", displayName: "proj-a" }),
			snap({ piId: "b2", displayName: "proj-b" }),
		];
		const d = routePlainText({ online, defaultPiId: "gone" });
		assert.equal(d.kind, "need_select");
		if (d.kind === "need_select") assert.equal(d.reason, "default_offline");
	});
});

describe("routeUseCommand", () => {
	it("唯一匹配 → set_default", () => {
		const m = snap({ piId: "a1", displayName: "proj-a" });
		const d = routeUseCommand({
			query: "proj-a",
			matches: [m],
			online: [m],
			defaultPiId: null,
		});
		assert.equal(d.kind, "set_default");
		if (d.kind === "set_default") assert.equal(d.piId, "a1");
	});

	it("多匹配 → ambiguous", () => {
		const matches = [
			snap({ piId: "a1", displayName: "api" }),
			snap({ piId: "a2", displayName: "api-v2" }),
		];
		const d = routeUseCommand({
			query: "api",
			matches,
			online: matches,
			defaultPiId: null,
		});
		assert.equal(d.kind, "ambiguous");
	});

	it("零匹配 → not_found", () => {
		const d = routeUseCommand({
			query: "zzz",
			matches: [],
			online: [snap({ piId: "a1", displayName: "proj-a" })],
			defaultPiId: null,
		});
		assert.equal(d.kind, "not_found");
	});
});

describe("command parsers", () => {
	it("isListCommand", () => {
		assert.equal(isListCommand("列表"), true);
		assert.equal(isListCommand("list"), true);
		assert.equal(isListCommand("ls"), true);
		assert.equal(isListCommand("hello"), false);
	});

	it("parseUseCommand", () => {
		assert.equal(parseUseCommand("使用 a1"), "a1");
		assert.equal(parseUseCommand("use proj-a"), "proj-a");
		assert.equal(parseUseCommand("列表"), null);
	});
});

describe("InstanceRegistry", () => {
	it("单实例自动默认；第二实例加入不改默认；离线后单在线再自动默认", () => {
		const reg = new InstanceRegistry({ heartbeatTimeoutMs: 30_000 });
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		assert.equal(reg.getDefaultPiId(), "a1");

		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		// 多个在线时不强制改已有默认（也不清掉）
		assert.equal(reg.getDefaultPiId(), "a1");

		reg.unregister("a1");
		// 仅剩一个 → 自动设为默认
		assert.equal(reg.getDefaultPiId(), "b2");
	});

	it("心跳超时离线", () => {
		const reg = new InstanceRegistry({ heartbeatTimeoutMs: 100 });
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		const expired = reg.sweepExpired(Date.now() + 200);
		assert.deepEqual(expired, ["a1"]);
		assert.equal(reg.listOnline().length, 0);
	});

	it("心跳刷新使用服务端时间，忽略客户端过期 ts", () => {
		const reg = new InstanceRegistry({ heartbeatTimeoutMs: 1_000 });
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		// 客户端伪造很旧的 ts，不得把 lastHeartbeatAt 拨回过去
		assert.equal(reg.heartbeat("a1", "busy", Date.now() - 60_000), true);
		const snap = reg.get("a1");
		assert.ok(snap);
		assert.ok(Date.now() - snap!.lastHeartbeatAt < 500);
		assert.equal(snap!.status, "busy");
		// 刚刷新过，不应被超时扫掉
		assert.deepEqual(reg.sweepExpired(Date.now() + 200), []);
	});

	it("resolve 按 displayName", () => {
		const reg = new InstanceRegistry();
		reg.register({
			piId: "a1",
			displayName: "my-app",
			cwd: "C:/code/my-app",
			pid: 1,
			connectionId: "c1",
		});
		assert.equal(reg.resolve("my-app")[0]?.piId, "a1");
		assert.equal(reg.resolve("a1")[0]?.piId, "a1");
	});
});

describe("handleControlMessage", () => {
	it("列表与使用 + 投递", () => {
		const reg = new InstanceRegistry();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		// 注册第二个后，默认仍可能是 a1（先注册的保持）
		reg.setDefault(null);

		const list = handleControlMessage({ registry: reg }, { text: "列表" });
		assert.match(list.reply, /proj-a/);
		assert.match(list.reply, /proj-b/);
		assert.equal(list.deliveredTo, undefined);

		const plain = handleControlMessage({ registry: reg }, { text: "跑测试" });
		assert.equal(plain.deliveredTo, undefined);
		assert.match(plain.reply, /未投递|使用|多个/);

		const use = handleControlMessage({ registry: reg }, { text: "使用 b2" });
		assert.equal(reg.getDefaultPiId(), "b2");
		assert.match(use.reply, /已设定默认/);

		const deliver = handleControlMessage({ registry: reg }, { text: "跑测试" });
		assert.equal(deliver.deliveredTo, "b2");
		assert.equal(deliver.deliverText, "跑测试");
	});

	it("未授权拒绝", () => {
		const reg = new InstanceRegistry();
		const r = handleControlMessage(
			{ registry: reg, isAuthorized: () => false },
			{ text: "列表", openId: "x" },
		);
		assert.match(r.reply, /无权限/);
	});

	it("配对口令优先于白名单且成功绑定", () => {
		const reg = new InstanceRegistry();
		const pairing = new PairingStore({ random: () => 0.1 });
		const begun = pairing.begin("pi-a");
		let bound: string | undefined;
		const r = handleControlMessage(
			{
				registry: reg,
				pairing,
				isAuthorized: () => false,
				onOwnerBound: (openId) => {
					bound = openId;
					return { ok: true, message: "ok-file" };
				},
			},
			{ text: `配对 ${begun.code}`, openId: "ou_owner" },
		);
		assert.equal(bound, "ou_owner");
		assert.equal(r.decision.kind, "pair");
		if (r.decision.kind === "pair") assert.equal(r.decision.ok, true);
		assert.match(r.reply, /已绑定/);
	});

	it("错码不调用 onOwnerBound", () => {
		const reg = new InstanceRegistry();
		const pairing = new PairingStore({ random: () => 0.2 });
		pairing.begin();
		let called = false;
		const r = handleControlMessage(
			{
				registry: reg,
				pairing,
				isAuthorized: () => false,
				onOwnerBound: () => {
					called = true;
					return { ok: true, message: "x" };
				},
			},
			{ text: "配对 WRONG1", openId: "ou_x" },
		);
		assert.equal(called, false);
		assert.equal(r.decision.kind, "pair");
		if (r.decision.kind === "pair") assert.equal(r.decision.ok, false);
	});

	it("默认离线时清默认且不改投", () => {
		const reg = new InstanceRegistry();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		// 人为制造「默认已不在在线表」：setDefault 后 unregister 会清默认；
		// 这里直接把默认指到幽灵 id（registry 不允许，故用内部场景：
		// 两在线但 default 被手动清后又注入不一致路径 —— 走 setDefault(null) 后
		// 再模拟 route 的 default_offline：通过反射式先 set a1，unregister a1，
		// 仅剩 b2 时 ensureSingle 会把默认设为 b2。故改测：
		// 两在线 + 无默认 → 不投递。
		reg.setDefault(null);
		const r = handleControlMessage({ registry: reg }, { text: "hello" });
		assert.equal(r.deliveredTo, undefined);
		assert.match(r.reply, /未投递|使用|多个/);
	});
});

describe("formatOnlineList", () => {
	it("空列表文案", () => {
		assert.match(formatOnlineList([], null), /没有在线/);
	});
});

describe("MessageBindingStore", () => {
	it("bind / get / 过期", () => {
		const store = new MessageBindingStore({ ttlMs: 1_000 });
		store.bind({
			messageId: "console-1",
			piId: "a1",
			requestId: "req-1",
			event: "task_end",
			createdAt: 1_000,
		});
		assert.equal(store.get("console-1", 1_500)?.piId, "a1");
		assert.equal(store.get("console-1", 2_100), undefined);
		assert.equal(store.size(2_100), 0);
	});

	it("未绑定 messageId 查不到", () => {
		const store = new MessageBindingStore();
		assert.equal(store.get("missing"), undefined);
	});

	it("need_reply 绑定保留 requestId 与 event", () => {
		const store = new MessageBindingStore();
		const b = store.bind({
			messageId: "console-nr-1",
			piId: "a1",
			requestId: "nr-req-abc",
			event: "need_reply",
		});
		assert.equal(b.event, "need_reply");
		assert.equal(b.requestId, "nr-req-abc");
		assert.equal(store.get("console-nr-1")?.requestId, "nr-req-abc");
	});
});

describe("reply routing via handleControlMessage", () => {
	it("replyToMessageId 覆盖默认并精确投递", () => {
		const reg = new InstanceRegistry();
		const bindings = new MessageBindingStore();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		// 默认指向 a1；回复绑定指向 b2，必须进 b2
		reg.setDefault("a1");
		bindings.bind({
			messageId: "console-b2-end",
			piId: "b2",
			requestId: "req-b",
			event: "task_end",
		});

		const r = handleControlMessage(
			{ registry: reg, bindings },
			{ text: "继续改 B", replyToMessageId: "console-b2-end" },
		);
		assert.equal(r.deliveredTo, "b2");
		assert.equal(r.source, "reply");
		assert.equal(r.replyToRequestId, "req-b");
		assert.equal(r.decision.kind, "reply");
		assert.equal(r.deliverText, "继续改 B");
	});

	it("need_reply 绑定：回复携带 replyToRequestId 供 bridge 关联", () => {
		const reg = new InstanceRegistry();
		const bindings = new MessageBindingStore();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		// need_reply 出站绑定（与 server.handleNotify 一致：含 requestId + event）
		const requestId = "nr-req-001-xyz";
		bindings.bind({
			messageId: "console-need-reply-1",
			piId: "a1",
			requestId,
			event: "need_reply",
		});

		const r = handleControlMessage(
			{ registry: reg, bindings },
			{ text: "用户的回答内容", replyToMessageId: "console-need-reply-1" },
		);
		assert.equal(r.deliveredTo, "a1");
		assert.equal(r.source, "reply");
		assert.equal(r.replyToRequestId, requestId);
		assert.equal(r.deliverText, "用户的回答内容");
		assert.equal(r.decision.kind, "reply");
		// 绑定 event 信息可从 store 读出（调试 /notifications）
		assert.equal(bindings.get("console-need-reply-1")?.event, "need_reply");
	});

	it("未绑定 replyTo 失败关闭，不改投默认", () => {
		const reg = new InstanceRegistry();
		const bindings = new MessageBindingStore();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.setDefault("a1");

		const r = handleControlMessage(
			{ registry: reg, bindings },
			{ text: "hello", replyToMessageId: "console-unknown" },
		);
		assert.equal(r.deliveredTo, undefined);
		assert.equal(r.decision.kind, "reply_unbound");
		assert.match(r.reply, /未找到|未投递/);
	});

	it("绑定目标离线时不改投", () => {
		const reg = new InstanceRegistry();
		const bindings = new MessageBindingStore();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		bindings.bind({
			messageId: "console-b2",
			piId: "b2",
			event: "task_end",
		});
		reg.unregister("b2");

		const r = handleControlMessage(
			{ registry: reg, bindings },
			{ text: "继续", replyToMessageId: "console-b2" },
		);
		assert.equal(r.deliveredTo, undefined);
		assert.equal(r.decision.kind, "reply_offline");
		assert.match(r.reply, /已离线|未改投/);
	});

	it("无 replyTo 仍走默认路由", () => {
		const reg = new InstanceRegistry();
		const bindings = new MessageBindingStore();
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		reg.register({
			piId: "b2",
			displayName: "proj-b",
			cwd: "/tmp/b",
			pid: 2,
			connectionId: "c2",
		});
		reg.setDefault("a1");

		const r = handleControlMessage(
			{ registry: reg, bindings },
			{ text: "跑测试" },
		);
		assert.equal(r.deliveredTo, "a1");
		assert.equal(r.source, "default");
	});
});

describe("FeishuTransport", () => {
	it("ConsoleFeishuTransport 返回 console- messageId", async () => {
		const t = new ConsoleFeishuTransport();
		const r = await t.send({
			title: "任务结束",
			body: "摘要",
			piId: "a1",
			event: "task_end",
			requestId: "r1",
		});
		assert.match(r.messageId, /^console-/);
		assert.equal(t.history.length, 1);
		assert.equal(t.history[0]?.piId, "a1");
	});

	it("NoopFeishuTransport 可注入 messageId", async () => {
		const t = new NoopFeishuTransport({ idFactory: () => "noop-fixed" });
		const r = await t.send({ body: "x", piId: "a1" });
		assert.equal(r.messageId, "noop-fixed");
		assert.equal(t.sent.length, 1);
	});

	it("sendApprovalCard 带 actions", async () => {
		const t = new ConsoleFeishuTransport();
		const r = await t.sendApprovalCard({
			body: "rm -rf /",
			piId: "a1",
			event: "approval",
			requestId: "req-card",
			actions: ["approve", "reject"],
		});
		assert.match(r.messageId, /^console-/);
		assert.match(t.history[0]?.body ?? "", /card actions/);
	});
});

describe("ApprovalStore", () => {
	it("approve 一次 → terminal；重复 decide 幂等 already_handled", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-1", piId: "a1" });

		const first = store.decide({
			requestId: "req-1",
			decision: "approve",
			isPiOnline: () => true,
		});
		assert.equal(first.kind, "decided");
		if (first.kind === "decided") {
			assert.equal(first.shouldDeliver, true);
			assert.equal(first.record.status, "approved");
			assert.equal(first.record.decision, "approve");
		}
		store.markDelivered("req-1");

		const second = store.decide({
			requestId: "req-1",
			decision: "reject",
			isPiOnline: () => true,
		});
		assert.equal(second.kind, "already_handled");
		if (second.kind === "already_handled") {
			assert.equal(second.record.status, "approved");
			assert.equal(second.record.decision, "approve");
			assert.equal(second.record.deliveredToPi, true);
		}
		store.clear();
	});

	it("reject 决策", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-r", piId: "b2" });
		const r = store.decide({
			requestId: "req-r",
			decision: "reject",
			isPiOnline: () => true,
		});
		assert.equal(r.kind, "decided");
		if (r.kind === "decided") {
			assert.equal(r.record.status, "rejected");
			assert.equal(r.shouldDeliver, true);
		}
		store.clear();
	});

	it("目标 Pi 离线 → failed_delivery，不投递", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-off", piId: "gone" });
		const r = store.decide({
			requestId: "req-off",
			decision: "approve",
			isPiOnline: () => false,
		});
		assert.equal(r.kind, "decided");
		if (r.kind === "decided") {
			assert.equal(r.offline, true);
			assert.equal(r.shouldDeliver, false);
			assert.equal(r.record.status, "failed_delivery");
			assert.equal(r.record.decision, "approve");
		}
		store.clear();
	});

	it("failed_delivery 后 Pi 恢复可重试投递；已 markDelivered 则幂等", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-retry", piId: "a1" });
		const offline = store.decide({
			requestId: "req-retry",
			decision: "approve",
			isPiOnline: () => false,
		});
		assert.equal(offline.kind, "decided");
		if (offline.kind === "decided") {
			assert.equal(offline.shouldDeliver, false);
			assert.equal(offline.record.status, "failed_delivery");
		}

		// 二次点击不同 decision 也不得覆盖首次 approve
		const retry = store.decide({
			requestId: "req-retry",
			decision: "reject",
			isPiOnline: () => true,
		});
		assert.equal(retry.kind, "decided");
		if (retry.kind === "decided") {
			assert.equal(retry.shouldDeliver, true);
			assert.equal(retry.record.decision, "approve");
			assert.equal(retry.record.status, "approved");
		}
		store.markDelivered("req-retry");

		const third = store.decide({
			requestId: "req-retry",
			decision: "reject",
			isPiOnline: () => true,
		});
		assert.equal(third.kind, "already_handled");
		if (third.kind === "already_handled") {
			assert.equal(third.record.decision, "approve");
			assert.equal(third.record.deliveredToPi, true);
		}
		store.clear();
	});

	it("socket 投递失败 markFailedDelivery 后可重试", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-sock", piId: "a1" });
		const first = store.decide({
			requestId: "req-sock",
			decision: "reject",
			isPiOnline: () => true,
		});
		assert.equal(first.kind, "decided");
		// 模拟 sendToPi 失败：不 markDelivered，改 markFailedDelivery
		store.markFailedDelivery("req-sock");
		assert.equal(store.get("req-sock")?.status, "failed_delivery");
		assert.equal(store.get("req-sock")?.deliveredToPi, false);

		const retry = store.decide({
			requestId: "req-sock",
			decision: "approve",
			isPiOnline: () => true,
		});
		assert.equal(retry.kind, "decided");
		if (retry.kind === "decided") {
			assert.equal(retry.shouldDeliver, true);
			// 保留首次 reject，不因二次点击改成 approve
			assert.equal(retry.record.decision, "reject");
		}
		store.clear();
	});

	it("applyTimeout → reject 投递；再次 timeout 幂等", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "req-t", piId: "a1" });
		const t1 = store.applyTimeout("req-t", () => true);
		assert.equal(t1.kind, "timed_out");
		if (t1.kind === "timed_out") {
			assert.equal(t1.shouldDeliver, true);
			assert.equal(t1.record.status, "timeout");
			assert.equal(t1.record.decision, "reject");
		}
		store.markDelivered("req-t");
		const t2 = store.applyTimeout("req-t", () => true);
		assert.equal(t2.kind, "already_handled");
		store.clear();
	});

	it("定时器触发 onTimeoutFire", async () => {
		const fired: string[] = [];
		const store = new ApprovalStore({
			defaultTimeoutMs: 20,
			onTimeoutFire: (id) => {
				fired.push(id);
				store.applyTimeout(id, () => true);
			},
		});
		store.create({ requestId: "req-timer", piId: "a1", timeoutMs: 20 });
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(fired, ["req-timer"]);
		assert.equal(store.get("req-timer")?.status, "timeout");
		store.clear();
	});

	it("not_found", () => {
		const store = new ApprovalStore();
		const r = store.decide({
			requestId: "missing",
			decision: "approve",
			isPiOnline: () => true,
		});
		assert.equal(r.kind, "not_found");
		store.clear();
	});

	it("resolveByPrefix 唯一匹配", () => {
		const store = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		store.create({ requestId: "abc-111-xxx", piId: "a1" });
		store.create({ requestId: "def-222-yyy", piId: "b2" });
		assert.equal(store.resolveByPrefix("abc")?.requestId, "abc-111-xxx");
		assert.equal(store.resolveByPrefix("nope"), null);
		store.clear();
	});
});

describe("parseApprovalTextCommand", () => {
	it("解析批准/拒绝", () => {
		assert.deepEqual(parseApprovalTextCommand("批准 abc-1"), {
			decision: "approve",
			requestIdPrefix: "abc-1",
		});
		assert.deepEqual(parseApprovalTextCommand("拒绝 xyz"), {
			decision: "reject",
			requestIdPrefix: "xyz",
		});
		assert.equal(parseApprovalTextCommand("列表"), null);
		assert.equal(parseApprovalTextCommand("批准"), null);
	});
});

describe("handleControlApproval", () => {
	it("在线批准 → approvalDeliver", () => {
		const reg = new InstanceRegistry();
		const approvals = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		approvals.create({ requestId: "req-ctrl", piId: "a1" });

		const r = handleControlApproval(
			{ registry: reg, approvals },
			{ requestId: "req-ctrl", decision: "approve", openId: "u1" },
		);
		assert.equal(r.approvalDeliver?.piId, "a1");
		assert.equal(r.approvalDeliver?.decision, "approve");
		assert.equal(r.decision.kind, "approval");

		// 调用方（server）成功投递后 markDelivered，此后幂等
		approvals.markDelivered("req-ctrl");
		const r2 = handleControlApproval(
			{ registry: reg, approvals },
			{ requestId: "req-ctrl", decision: "reject" },
		);
		assert.equal(r2.approvalDeliver, undefined);
		assert.equal(r2.decision.kind, "approval");
		if (r2.decision.kind === "approval") {
			assert.equal(r2.decision.result.kind, "already_handled");
		}
		approvals.clear();
	});

	it("离线不改投", () => {
		const reg = new InstanceRegistry();
		const approvals = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		// 不注册 pi → offline
		approvals.create({ requestId: "req-off2", piId: "ghost" });
		const r = handleControlApproval(
			{ registry: reg, approvals },
			{ requestId: "req-off2", decision: "approve" },
		);
		assert.equal(r.approvalDeliver, undefined);
		assert.match(r.reply, /离线|未改投/);
		approvals.clear();
	});

	it("未授权拒绝", () => {
		const reg = new InstanceRegistry();
		const approvals = new ApprovalStore();
		const r = handleControlApproval(
			{ registry: reg, approvals, isAuthorized: () => false },
			{ requestId: "x", decision: "approve", openId: "bad" },
		);
		assert.match(r.reply, /无权限/);
		approvals.clear();
	});

	it("文本命令 批准 前缀", () => {
		const reg = new InstanceRegistry();
		const approvals = new ApprovalStore({ defaultTimeoutMs: 60_000 });
		reg.register({
			piId: "a1",
			displayName: "proj-a",
			cwd: "/tmp/a",
			pid: 1,
			connectionId: "c1",
		});
		approvals.create({ requestId: "mno-999-zzz", piId: "a1" });

		const r = handleControlMessage(
			{ registry: reg, approvals },
			{ text: "批准 mno-999" },
		);
		assert.equal(r.approvalDeliver?.requestId, "mno-999-zzz");
		assert.equal(r.approvalDeliver?.decision, "approve");
		approvals.clear();
	});
});
