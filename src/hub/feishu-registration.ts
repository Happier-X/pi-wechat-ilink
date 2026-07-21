import type { FeishuCredentials } from "./credentials.js";

const PATH = "/oauth/v1/app/registration";
const FEISHU_BASE = "https://accounts.feishu.cn";
const LARK_BASE = "https://accounts.larksuite.com";

type Fetch = typeof fetch;
type Json = Record<string, unknown>;
type FormParams = Record<string, string>;

/** OAuth device-flow 等待状态：不算失败，继续 poll。飞书可能用 HTTP 400 携带这些码。 */
const PENDING_ERRORS = new Set(["authorization_pending", "pending", "slow_down"]);

async function post(fetchFn: Fetch, base: string, params: FormParams): Promise<Json> {
	const body = new URLSearchParams(params);
	const response = await fetchFn(`${base}${PATH}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	let json: Json = {};
	try {
		json = (await response.json()) as Json;
	} catch {
		if (!response.ok) {
			throw new Error(`飞书注册服务返回 HTTP ${response.status}`);
		}
		throw new Error("飞书注册服务返回了无法解析的响应");
	}
	// 与 cc-connect 一致：以响应体 OAuth 字段为准；pending 不因 HTTP 状态失败。
	const code = oauthErrorCode(json);
	if (!response.ok && !(code && PENDING_ERRORS.has(code))) {
		throw new Error(err(json) ?? `飞书注册服务返回 HTTP ${response.status}`);
	}
	return json;
}

function oauthErrorCode(j: Json): string | undefined {
	if (typeof j.error === "string" && j.error.trim()) return j.error.trim();
	const nestedError = j.error && typeof j.error === "object" ? (j.error as Json) : undefined;
	if (typeof nestedError?.code === "string" && nestedError.code.trim()) return nestedError.code.trim();
	const nestedData = j.data && typeof j.data === "object" ? (j.data as Json) : undefined;
	if (typeof nestedData?.error === "string" && nestedData.error.trim()) return nestedData.error.trim();
	return undefined;
}

function err(j: Json): string | undefined {
	const nestedError = j.error && typeof j.error === "object" ? (j.error as Json) : undefined;
	const nestedData = j.data && typeof j.data === "object" ? (j.data as Json) : undefined;
	const dataError =
		nestedData?.error && typeof nestedData.error === "object"
			? (nestedData.error as Json)
			: undefined;
	const candidates = [
		j.error,
		j.error_description,
		j.msg,
		j.message,
		nestedError?.code,
		nestedError?.message,
		nestedError?.msg,
		nestedData?.error_description,
		nestedData?.msg,
		nestedData?.message,
		dataError?.code,
		dataError?.message,
		dataError?.msg,
	];
	const value = candidates.find(
		(item): item is string => typeof item === "string" && Boolean(item.trim()),
	);
	return value?.replace(/(client|app)?[_ -]?secret[^,\s]*/gi, "密钥").slice(0, 120);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`飞书注册响应缺少 ${field}`);
	}
	return value.trim();
}

function asRecord(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: {};
}

function payload(j: Json): Json {
	const data = asRecord(j.data);
	return Object.keys(data).length > 0 ? data : j;
}

function readExpireSeconds(d: Json): number {
	const expire = Number(d.expire_in ?? d.expires_in);
	if (!Number.isFinite(expire) || expire <= 0) {
		throw new Error("飞书注册响应缺少有效 expire_in/expires_in");
	}
	return expire;
}

function readTenantBrand(...values: unknown[]): "feishu" | "lark" {
	for (const value of values) {
		if (typeof value === "string" && value.trim().toLowerCase() === "lark") {
			return "lark";
		}
	}
	return "feishu";
}

export type RegistrationChallenge = {
	deviceCode: string;
	url: string;
	intervalMs: number;
	expiresAt: number;
	brand: "feishu" | "lark";
};

export type RegistrationResult = {
	credentials: FeishuCredentials;
	ownerOpenId?: string;
};

export class FeishuRegistrationClient {
	constructor(private fetchFn: Fetch = fetch) {}

	async begin(now = Date.now()): Promise<RegistrationChallenge> {
		const base = FEISHU_BASE;
		// 与 cc-connect 一致：application/x-www-form-urlencoded，init 只带 action。
		const init = await post(this.fetchFn, base, { action: "init" });
		if (err(init) && !Array.isArray(init.supported_auth_methods) && !Array.isArray(payload(init).supported_auth_methods)) {
			throw new Error(`初始化扫码失败：${err(init)}`);
		}
		const methods = init.supported_auth_methods ?? payload(init).supported_auth_methods;
		if (!Array.isArray(methods) || !methods.includes("client_secret")) {
			throw new Error("飞书注册服务未确认支持 client_secret");
		}

		const j = await post(this.fetchFn, base, {
			action: "begin",
			archetype: "PersonalAgent",
			auth_method: "client_secret",
			request_user_info: "open_id",
		});
		if (err(j) && !payload(j).device_code) {
			throw new Error(`发起扫码失败：${err(j)}`);
		}

		const d = payload(j);
		const deviceCode = requiredString(d.device_code, "device_code");
		const url = requiredString(d.verification_uri_complete, "verification_uri_complete");
		try {
			if (!/^https:\/\//i.test(url)) throw new Error();
			new URL(url);
		} catch {
			throw new Error("飞书注册响应二维码 URL 无效");
		}

		const expire = readExpireSeconds(d);
		return {
			deviceCode,
			url,
			intervalMs: Math.max(1000, Number(d.interval || 5) * 1000),
			expiresAt: now + expire * 1000,
			brand: readTenantBrand(d.tenant_brand, asRecord(d.user_info).tenant_brand),
		};
	}

	async poll(c: RegistrationChallenge, signal?: AbortSignal): Promise<RegistrationResult> {
		let delay = c.intervalMs;
		let base = c.brand === "lark" ? LARK_BASE : FEISHU_BASE;
		while (Date.now() < c.expiresAt) {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, delay);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(t);
						reject(new Error("扫码开局已取消"));
					},
					{ once: true },
				);
			});

			const j = await post(this.fetchFn, base, {
				action: "poll",
				device_code: c.deviceCode,
			});
			const d = payload(j);
			const userInfo = asRecord(d.user_info);
			const brand = readTenantBrand(
				d.tenant_brand,
				userInfo.tenant_brand,
				c.brand,
			);
			if (brand === "lark" && base !== LARK_BASE) {
				base = LARK_BASE;
				continue;
			}

			// 先判成功，再处理 pending；避免误把等待码当失败。
			if (
				typeof d.client_id === "string" &&
				typeof d.client_secret === "string" &&
				d.client_id.trim() &&
				d.client_secret.trim()
			) {
				return {
					credentials: {
						appId: d.client_id.trim(),
						appSecret: d.client_secret.trim(),
						brand,
						updatedAt: Date.now(),
					},
					ownerOpenId:
						typeof userInfo.open_id === "string" && userInfo.open_id.trim()
							? userInfo.open_id.trim()
							: undefined,
				};
			}

			const e = oauthErrorCode(j) ?? err(j);
			if (e === "authorization_pending" || e === "pending") continue;
			if (e === "slow_down") {
				delay += 5000;
				continue;
			}
			if (e === "expired_token") throw new Error("二维码已过期，请重新执行 /lark");
			if (e === "access_denied") throw new Error("用户拒绝了飞书授权");
			if (e) throw new Error(`飞书扫码失败：${e}`);
			throw new Error("飞书注册响应缺少 client_id/client_secret，请重新执行 /lark");
		}
		throw new Error("飞书扫码开局超时");
	}
}
