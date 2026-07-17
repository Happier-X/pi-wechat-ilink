import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PairingStore,
	parsePairCommand,
	DEFAULT_PAIR_TTL_MS,
} from "./pairing.js";

describe("parsePairCommand", () => {
	it("识别中英口令", () => {
		assert.deepEqual(parsePairCommand("配对 AB12CD"), { code: "AB12CD" });
		assert.deepEqual(parsePairCommand("pair xy99zz"), { code: "XY99ZZ" });
		assert.equal(parsePairCommand("列表"), null);
		assert.equal(parsePairCommand("配对"), null);
	});
});

describe("PairingStore", () => {
	it("begin + consume 成功后会话清空", () => {
		let t = 1_000_000;
		let r = 0.1;
		const store = new PairingStore({
			now: () => t,
			random: () => r,
			ttlMs: DEFAULT_PAIR_TTL_MS,
		});
		const begun = store.begin("pi-a");
		assert.equal(begun.code.length, 6);
		assert.equal(begun.ttlMs, DEFAULT_PAIR_TTL_MS);

		const bad = store.consume({ code: "XXXXXX", openId: "ou_1" });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.equal(bad.reason, "mismatch");

		const ok = store.consume({ code: begun.code, openId: "ou_owner" });
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.openId, "ou_owner");

		const again = store.consume({ code: begun.code, openId: "ou_owner" });
		assert.equal(again.ok, false);
		if (!again.ok) assert.equal(again.reason, "no_session");
	});

	it("过期后 consume 失败", () => {
		let t = 0;
		const store = new PairingStore({
			now: () => t,
			ttlMs: 1000,
			random: () => 0.2,
		});
		const begun = store.begin();
		t = 2000;
		const r = store.consume({ code: begun.code, openId: "ou_x" });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "expired");
	});

	it("无 openId 失败", () => {
		const store = new PairingStore({ random: () => 0.3 });
		const begun = store.begin();
		const r = store.consume({ code: begun.code });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "no_open_id");
	});
});
