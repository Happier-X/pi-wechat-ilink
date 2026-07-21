import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FeishuRegistrationClient } from "./feishu-registration.js";

function response(value: unknown, ok = true, status?: number): Response {
	return {
		ok,
		status: status ?? (ok ? 200 : 500),
		json: async () => value,
	} as Response;
}

describe("FeishuRegistrationClient", () => {
	it("使用 form-urlencoded 调用 init/begin/poll 并返回凭证", async () => {
		const seen: Array<{ url: string; contentType: string | null; body: string }> = [];
		const replies = [
			{ supported_auth_methods: ["client_secret"] },
			{
				device_code: "dc",
				verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=ABCD",
				interval: 0.001,
				expires_in: 60,
			},
			{
				client_id: "cli_x",
				client_secret: "s",
				user_info: { open_id: "ou_owner", tenant_brand: "feishu" },
			},
		];
		const client = new FeishuRegistrationClient(async (input, init) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: String(input),
				contentType: headers.get("content-type"),
				body: String(init?.body ?? ""),
			});
			return response(replies.shift());
		});
		const challenge = await client.begin(Date.now());
		challenge.intervalMs = 1;
		const result = await client.poll(challenge);
		assert.equal(result.credentials.appId, "cli_x");
		assert.equal(result.ownerOpenId, "ou_owner");
		assert.equal(seen.length, 3);
		for (const call of seen) {
			assert.equal(call.contentType, "application/x-www-form-urlencoded");
			assert.match(call.body, /action=/);
		}
		assert.match(seen[0]!.body, /action=init/);
		assert.doesNotMatch(seen[0]!.body, /supported_auth_methods/);
		assert.match(seen[1]!.body, /action=begin/);
		assert.match(seen[1]!.body, /auth_method=client_secret/);
		assert.match(seen[2]!.body, /device_code=dc/);
	});

	it("兼容 data 包装与 expire_in 字段", async () => {
		const replies = [
			{ data: { supported_auth_methods: ["client_secret"] } },
			{
				data: {
					device_code: "dc2",
					verification_uri_complete: "https://accounts.feishu.cn/verify",
					interval: 1,
					expire_in: 30,
				},
			},
			{
				data: {
					client_id: "cli_y",
					client_secret: "secret",
					user_info: { open_id: "ou_y" },
				},
			},
		];
		const client = new FeishuRegistrationClient(
			async () => response(replies.shift()) as Response,
		);
		const challenge = await client.begin(Date.now());
		challenge.intervalMs = 1;
		const result = await client.poll(challenge);
		assert.equal(result.credentials.appId, "cli_y");
		assert.equal(result.ownerOpenId, "ou_y");
	});

	it("拒绝非 HTTPS 二维码和缺失有效期", async () => {
		const replies = [
			{ supported_auth_methods: ["client_secret"] },
			{
				device_code: "dc",
				verification_uri_complete: "javascript:x",
				expires_in: 60,
			},
		];
		const client = new FeishuRegistrationClient(
			async () => response(replies.shift()) as Response,
		);
		await assert.rejects(() => client.begin(), /URL 无效/);
	});

	it("HTTP 错误优先回显服务端文案且不回显 secret", async () => {
		const client = new FeishuRegistrationClient(async () =>
			response(
				{
					error: "invalid_request",
					error_description: "The app registration request auth method is unsupported. client_secret=very-sensitive",
				},
				false,
				400,
			),
		);
		await assert.rejects(
			() => client.begin(),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes("invalid_request") &&
				!error.message.includes("very-sensitive"),
		);
	});

	it("兼容 code/msg 及嵌套错误响应", async () => {
		const replies = [
			{ supported_auth_methods: ["client_secret"] },
			{ data: { error: { code: "registration_denied", msg: "拒绝" } } },
		];
		const client = new FeishuRegistrationClient(
			async () => response(replies.shift()) as Response,
		);
		await assert.rejects(() => client.begin(), /registration_denied/);
	});

	it("poll 在 user_info.tenant_brand=lark 时切换域名", async () => {
		const bases: string[] = [];
		const replies = [
			{ supported_auth_methods: ["client_secret"] },
			{
				device_code: "dc",
				verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=1",
				expires_in: 60,
				interval: 0.001,
			},
			{
				error: "authorization_pending",
				user_info: { tenant_brand: "lark" },
			},
			{
				client_id: "cli_lark",
				client_secret: "s",
				user_info: { open_id: "ou_lark", tenant_brand: "lark" },
			},
		];
		const client = new FeishuRegistrationClient(async (input) => {
			bases.push(String(input));
			return response(replies.shift());
		});
		const challenge = await client.begin(Date.now());
		challenge.intervalMs = 1;
		const result = await client.poll(challenge);
		assert.equal(result.credentials.brand, "lark");
		assert.ok(bases.some((url) => url.startsWith("https://accounts.larksuite.com/")));
	});
});
