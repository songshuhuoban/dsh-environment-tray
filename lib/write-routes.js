import { CredentialAccess, CredentialRejected, CredentialShadowed } from "./credentials.js";
import { resolveDshHome } from "./env-model.js";
import { EnvEditRejected, applyEnvEdits, readDotEnvFile } from "./env-write.js";
import "./registry.js";
import { resolve } from "node:path";
//#region src/write-routes.ts
/**
* 写路由 —— 把三层写入能力暴露成 HTTP。
*
* **这是整个插件风险最高的地方**：一个签了名的 HTTP 端点，能写磁盘文件、
* 能改注册表。所以本模块的每一条设计都围绕"限制爆炸半径"：
*
*  1. **绝不接受任意路径。** 请求里给的是**层标识**（`project-env` / `user-env`），
*     路径由宿主自己算出来。请求里若带 `path`，必须与算出来的完全一致，否则拒绝。
*     没有这一条，任何能访问该端点的人都能覆盖任意文件。
*  2. **写前必校验。** `.env` 走 `applyEnvEdits`（含禁止名单 + 有损值 + CAS），
*     密钥走 `CredentialAccess`（含遮蔽预检），注册表走 `OsEnvironmentLayer`
*     （含类型保留）。路由层不自己发明规则。
*  3. **响应里不出现密钥。** 密钥写入后只回 `describe()` 的结果。
*  4. **错误必须结构化到达客户端。** webserver 会把抛出的异常变成**空的** 400，
*     所以这里自己捕获并回 `{ error, message, problems }`。
*
* @module dsh-environment-tray/write-routes
*/
/** 请求体上限。环境变量的值不该有几百 KB。 */
const MAX_BODY_BYTES = 262144;
/** 路由路径。 */
const ENV_ROUTE = "/api/dsh-environment-tray/env";
const CREDENTIAL_ROUTE = "/api/dsh-environment-tray/credentials";
const REGISTRY_ROUTE = "/api/dsh-environment-tray/registry";
/**
* 请求策略闸门。
*
* **这是必须的一层。** `dsh-host-webserver` 的文档明确说明它自身
* "carries no TLS, authentication, or origin policy of its own"，并警告
* "Binding a non-loopback address still exposes unprotected routes" ——
* 鉴权由**路由所有者**负责，而 `dsh-client-connection` 只为它自己注册的
* 路由做了这件事。
*
* 我们直接把路由注册在 webserver 上，因此**默认绕过了那道闸门**。实测确证过
* 这个缺口的后果：一个带 `Sec-Fetch-Site: cross-site` 与外部 `Origin` 的
* 请求能成功写入 `.env`，而第一方 `/api/gateway` 在同样条件下回 401。
*
* 所以这里**复用 DSH 自己的权威实现**（`connection.requestRejection`），
* 而不是自己重新实现一套安全策略 —— 自研的策略迟早会与上游漂移。
*
* 策略内容（来自 `dsh-client-connection` 的 `isTrustedApiRequest` +
* `browserAuth`）：
*   - Host 头必须是回环或部署声明的 trustedHosts（挡 DNS rebinding）
*   - `Sec-Fetch-Site: cross-site` 直接拒（挡跨站请求）
*   - `Origin`（若存在）必须与 Host 同源
*   - 之后还要通过浏览器会话认证（cookie / process launch token）
*
* @param options - 依赖。
* @param options.connection - `ctx.connection` 服务；缺失时**失败关闭**。
* @returns 一个 `(req, res) => boolean` 闸门：返回 true 表示可以继续。
*/
function createRequestGuard(options) {
	const { connection } = options;
	return (req, res) => {
		if (connection === void 0 || typeof connection.requestRejection !== "function") {
			writeJson(res, 503, {
				ok: false,
				error: "request-policy-unavailable",
				message: "无法验证请求，请重新连接 DSH"
			});
			return false;
		}
		const rejection = connection.requestRejection(req);
		if (rejection === void 0) return true;
		writeJson(res, rejection, {
			ok: false,
			error: rejection === 403 ? "untrusted-origin" : "unauthenticated",
			message: rejection === 403 ? "请求来源不受信任" : "请重新连接 DSH"
		});
		return false;
	};
}
/**
* 读取并解析 JSON 请求体。
*
* 上限是必须的：没有上限的话一个超大 body 会一直堆在内存里。
*
* @param req - IncomingMessage。
* @returns 解析后的对象。
* @throws 当 body 过大或不是合法 JSON 时。
*/
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) throw new Error(`请求体超过上限 ${String(MAX_BODY_BYTES)} 字节`);
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim().length === 0) return {};
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`);
	}
}
/**
* 解析请求目标层对应的 `.env` 路径。
*
* **路径完全由宿主推导**，只接受层标识。请求里若给了 `path`，必须与推导结果
* 一致 —— 这条比对是防止路径注入的关键。
*
* @param layer - `project-env` 或 `user-env`。
* @param cwd - 项目目录（`project-env` 用）。
* @param home - DSH home（`user-env` 用）。
* @param claimed - 请求里声明的路径；可选。
* @returns `.env` 的绝对路径。
* @throws 层非法或声明路径与推导结果不一致时。
*/
function resolveLayerPath(layer, cwd, home, claimed) {
	let derived;
	if (layer === "project-env") derived = resolve(cwd, ".env");
	else if (layer === "user-env") derived = resolve(home, ".env");
	else throw new Error(`不支持的层 "${String(layer)}"；只接受 project-env 与 user-env`);
	if (claimed !== void 0 && claimed !== null) {
		const claimedResolved = resolve(String(claimed));
		if (claimedResolved !== derived) throw new Error(`拒绝写入：请求声明的路径 "${claimedResolved}" 与 ${layer} 层推导出的路径 "${derived}" 不一致。本端点只接受层标识，不接受任意路径`);
	}
	return derived;
}
/** 写操作被拒绝。 */
var WriteRejected = class extends Error {
	/** 机器可读原因。 */
	code;
	/** 结构化问题列表（禁止名单、有损值等），供 UI 逐条展示。 */
	problems;
	/** 建议的 HTTP 状态码。 */
	status;
	/**
	* @param code - 机器可读原因。
	* @param message - 人类可读说明。
	* @param problems - 结构化问题列表。
	* @param status - 建议的 HTTP 状态码。
	*/
	constructor(code, message, problems = [], status = 400) {
		super(message);
		this.name = "WriteRejected";
		this.code = code;
		this.problems = problems;
		this.status = status;
	}
};
/**
* 把内部异常翻译成 `WriteRejected`，保住状态码与结构化问题。
*
* @param error - 原始异常。
* @returns 规范化后的拒绝对象。
*/
function toWriteRejected(error) {
	if (error instanceof WriteRejected) return error;
	if (error instanceof EnvEditRejected) {
		const rejected = error;
		const status = rejected.code === "stale-revision" || rejected.code === "already-exists" ? 409 : 400;
		return new WriteRejected(rejected.code, rejected.message, rejected.problems ?? [], status);
	}
	if (error instanceof CredentialShadowed) return new WriteRejected("credential-shadowed", error.message, [], 409);
	if (error instanceof CredentialRejected) return new WriteRejected(error.code ?? "credential-rejected", error.message, [], 400);
	const message = error?.message;
	return new WriteRejected("write-failed", String(message ?? error), [], 500);
}
/**
* 构造写路由处理器。
*
* @param options - 依赖。
* @param options.ctx - cordis 上下文。
* @param options.osLayer - OS 层适配器。
* @param options.credentialAccess - 凭据适配器工厂；便于测试注入。
* @param options.homeOf - DSH home 解析器；便于测试注入。
* @returns 三个处理器。
*/
function createWriteRoutes(options) {
	const { ctx, osLayer } = options;
	const homeOf = options.homeOf ?? (() => resolveDshHome());
	const credentialAccessOfFn = options.credentialAccessOf ?? (() => {
		const provider = ctx.credentials;
		return provider === void 0 ? void 0 : new CredentialAccess(provider);
	});
	const guard = options.guard ?? createRequestGuard({ connection: options.connection ?? ctx.connection });
	/** 只接受 POST。 */
	const requirePost = (req, res) => {
		if (req.method === "POST") return true;
		res.writeHead(405, { allow: "POST" });
		res.end();
		return false;
	};
	const registryCreates = /* @__PURE__ */ new Map();
	const serializeRegistryCreate = async (key, write) => {
		const current = (registryCreates.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
		registryCreates.set(key, current);
		try {
			return await current;
		} finally {
			if (registryCreates.get(key) === current) registryCreates.delete(key);
		}
	};
	/**
	* 统一写出结果或拒绝。
	*
	* **必须返回这个 promise 并让处理器 await 它。** 先前版本只启动链条就返回，
	* 于是 `await routes.env(...)` 在响应真正写出**之前**就 resolve 了 ——
	* 调用方读到的是未定义的 status/body。这个 bug 在测试里表现为"路由没反应"，
	* 但根因是实现异步语义不完整。
	*
	* @param res - 响应对象。
	* @param fn - 产生响应体的异步工作。
	* @returns 写出完成后的 promise。
	*/
	const respond = (res, fn) => Promise.resolve().then(fn).then((result) => writeJson(res, 200, {
		ok: true,
		...result
	})).catch((error) => {
		const rejected = toWriteRejected(error);
		writeJson(res, rejected.status, {
			ok: false,
			error: rejected.code,
			message: rejected.message,
			...rejected.problems.length > 0 ? { problems: rejected.problems } : {}
		});
	});
	const cwdOf = (req) => {
		try {
			return new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd") ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	const syncRuntime = async (layer, names, req, removed) => options.runtime === void 0 ? {
		appliedToProcess: false,
		restartRequired: true
	} : options.runtime.sync({
		layer,
		names,
		cwd: cwdOf(req),
		home: homeOf(),
		removed
	});
	return {
		/**
		* POST /api/dsh-environment-tray/env —— 批量编辑某个 `.env` 层。
		*
		* 请求体：`{ layer, expectedRevision, edits: [{op:'set'|'unset', name, value?}] }`
		* 可带 `path` 作断言，但必须与推导结果一致。
		*/
		async env(req, res) {
			if (!guard(req, res)) return;
			if (!requirePost(req, res)) return;
			const cwd = cwdOf(req);
			await respond(res, async () => {
				const body = await readJsonBody(req);
				if (typeof body.layer !== "string") throw new WriteRejected("invalid-layer", "layer 必须是字符串", [], 400);
				if (!Array.isArray(body.edits)) throw new WriteRejected("invalid-edits", "edits 必须是数组", [], 400);
				if (body.expectedRevision !== void 0 && typeof body.expectedRevision !== "string") throw new WriteRejected("invalid-revision", "expectedRevision 必须是字符串", [], 400);
				const path = resolveLayerPath(body.layer, cwd, homeOf(), body.path);
				const after = await applyEnvEdits({
					path,
					layer: body.layer,
					edits: body.edits,
					expectedRevision: body.expectedRevision,
					createOnly: body.createOnly === true
				});
				return {
					path: after.path,
					revision: after.revision,
					keys: Object.keys(after.values),
					...await syncRuntime(body.layer, body.edits.map((edit) => edit.name), req)
				};
			});
		},
		/**
		* GET 不支持；POST /api/dsh-environment-tray/env/read 用 POST 语义读一个层。
		*
		* 之所以不做成 GET：读也需要 `layer` 参数且要回 revision，放在同一族里
		* 更好对齐。仍然只接受层标识。
		*/
		async envRead(req, res) {
			if (!guard(req, res)) return;
			if (!requirePost(req, res)) return;
			const cwd = cwdOf(req);
			await respond(res, async () => {
				const body = await readJsonBody(req);
				const path = resolveLayerPath(body.layer, cwd, homeOf(), body.path);
				const current = await readDotEnvFile(path);
				return {
					path: current.path,
					exists: current.exists,
					revision: current.revision,
					keys: Object.keys(current.values)
				};
			});
		},
		/**
		* POST /api/dsh-environment-tray/credentials —— 写入或移除密钥。
		*
		* 请求体：`{ ref, value }` 写入；`{ ref, unset: true }` 移除。
		* **响应里永远不会出现密钥本身** —— 只回 `describe()` 的结果。
		*/
		async credentials(req, res) {
			if (!guard(req, res)) return;
			if (!requirePost(req, res)) return;
			await respond(res, async () => {
				const access = credentialAccessOfFn();
				if (access === void 0) throw new WriteRejected("credentials-unavailable", "凭据服务不可用", [], 501);
				const body = await readJsonBody(req);
				if (typeof body.ref !== "string" || body.ref.length === 0) throw new WriteRejected("invalid-ref", "ref 必须是非空字符串", [], 400);
				if (body.value !== void 0 && typeof body.value !== "string") throw new WriteRejected("invalid-value", "value 必须是字符串", [], 400);
				const ref = body.ref;
				if (body.unset === true) return {
					ref,
					view: await access.unset(ref)
				};
				return {
					ref,
					view: await access.set(ref, body.value)
				};
			});
		},
		/**
		* POST /api/dsh-environment-tray/registry —— 写入或修改 OS 层变量。
		*
		* 请求体：`{ scope, name, value, type? }`；`{ scope, name, unset: true }` 删除。
		* `type` 必须显式给出（客户端从读取结果里带回），否则 `REG_EXPAND_SZ`
		* 会被降级成 `REG_SZ`，破坏 `%VAR%` 引用。
		*/
		async registry(req, res) {
			if (!guard(req, res)) return;
			if (!requirePost(req, res)) return;
			await respond(res, async () => {
				if (!osLayer.supported) throw new WriteRejected("unsupported-platform", "当前平台不支持编辑系统环境变量", [], 501);
				const body = await readJsonBody(req);
				const scope = body.scope;
				if (scope !== "os-user" && scope !== "os-machine") throw new WriteRejected("invalid-scope", `不支持的 scope "${String(scope)}"`, [], 400);
				if (typeof body.name !== "string" || body.name.length === 0) throw new WriteRejected("invalid-name", "变量名不能为空", [], 400);
				if (body.value !== void 0 && typeof body.value !== "string") throw new WriteRejected("invalid-value", "value 必须是字符串", [], 400);
				const value = typeof body.value === "string" ? body.value : "";
				if (body.type !== void 0 && typeof body.type !== "string") throw new WriteRejected("invalid-type", "type 必须是字符串", [], 400);
				const type = typeof body.type === "string" ? body.type : void 0;
				if (body.unset === true) {
					const removed = await osLayer.remove(scope, body.name);
					if (!removed.ok) throw new WriteRejected("registry-failed", String(removed.error), [], 500);
					return {
						scope,
						name: body.name,
						removed: true,
						...removed.removed === void 0 ? { backupUnavailable: true } : { undo: {
							name: removed.removed.name,
							value: removed.removed.value,
							type: removed.removed.type
						} },
						...await syncRuntime(scope, [body.name], req, removed.removed)
					};
				}
				const name = body.name;
				const write = async () => {
					if (body.createOnly === true) {
						const current = (await osLayer.readAll?.())?.[scope];
						if (current === void 0 || current.error !== void 0) throw new WriteRejected("registry-read-failed", "无法读取目标环境变量，未执行新建", [], 500);
						if (current.entries.some((entry) => entry.name.toUpperCase() === name.toUpperCase())) throw new WriteRejected("already-exists", "所选位置中已存在同名变量", [], 409);
					}
					const wrote = await osLayer.write(scope, name, value, type);
					if (!wrote.ok) throw new WriteRejected("registry-failed", String(wrote.error), [], 500);
					return {
						scope,
						name,
						type: wrote.type,
						...await syncRuntime(scope, [name], req)
					};
				};
				return body.createOnly === true ? serializeRegistryCreate(scope + "\0" + name.toUpperCase(), write) : write();
			});
		}
	};
}
/**
* 写一个 JSON 响应。与 host-api 的同名helper 保持一致的头。
*
* @param res - 响应对象。
* @param status - HTTP 状态码。
* @param body - 可序列化对象。
*/
function writeJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text, "utf8")
	});
	res.end(text);
}
//#endregion
export { CREDENTIAL_ROUTE, ENV_ROUTE, REGISTRY_ROUTE, WriteRejected, createRequestGuard, createWriteRoutes, readJsonBody, resolveLayerPath, toWriteRejected };
