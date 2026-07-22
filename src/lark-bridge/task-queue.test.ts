import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskQueue } from "./task-queue.js";

describe("TaskQueue", () => {
	it("入队/列表/取消/清空", () => {
		let n = 0;
		const q = new TaskQueue({
			maxSize: 3,
			idFactory: () => `id${++n}`,
		});
		assert.ok(q.enqueue({ text: "a", source: "default" }));
		assert.ok(q.enqueue({ text: "b", source: "reply" }));
		assert.equal(q.size, 2);
		const cancel = q.cancel("id1");
		assert.equal(cancel.ok, true);
		assert.equal(q.size, 1);
		assert.equal(q.clear(), 1);
		assert.equal(q.size, 0);
	});

	it("满则拒绝", () => {
		const q = new TaskQueue({ maxSize: 1, idFactory: () => "only" });
		assert.ok(q.enqueue({ text: "1", source: "x" }));
		assert.equal(q.enqueue({ text: "2", source: "x" }), null);
	});

	it("前缀取消需唯一", () => {
		let n = 0;
		const q = new TaskQueue({
			idFactory: () => (n++ === 0 ? "ab1" : "ab2"),
		});
		q.enqueue({ text: "1", source: "x" });
		q.enqueue({ text: "2", source: "x" });
		assert.equal(q.cancel("ab").ok, false);
		assert.equal(q.cancel("ab1").ok, true);
	});

	it("formatList 含 id", () => {
		const q = new TaskQueue({ idFactory: () => "qabc" });
		q.enqueue({ text: "hello world", source: "default", enqueuedAt: Date.now() });
		assert.match(q.formatList("执行中"), /qabc/);
		assert.match(q.formatList(), /待执行队列/);
	});
});
