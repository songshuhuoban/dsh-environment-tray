import { credentialAccessOf, isPossibleRef } from "./credentials.js";
import { BLOCKED_REASON_TEXT, buildEnvironmentModel } from "./env-model.js";
import { readDotEnvFile } from "./env-write.js";
import { MACHINE_SCOPE, OsEnvironmentLayer, USER_SCOPE, mergeOsLayers } from "./registry.js";
import { CREDENTIAL_ROUTE, ENV_ROUTE, REGISTRY_ROUTE, createRequestGuard, readJsonBody, resolveLayerPath } from "./write-routes.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/host-api.ts
/**
* 宿主 API —— 把复合环境模型投影成一个**适合经 HTTP 传输**的视图。
*
* 三个刻意的约束：
*
*  1. **不原样回传整个环境。** 否则一次响应几十 KB，绝大部分是 `PATH` 这种
*     既长又无展示价值的值。默认只给长度与前后缀摘要，客户端要详情再单取。
*  2. **敏感名默认不给值。** 名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的条目，
*     只报"已配置"与来源 —— 与 `dsh-subprocess` 的 `scrubbedParentEnv`
*     用同一条规则，也与凭据域的掩码约定一致。
*  3. **错误要能到达客户端。** `dsh-host-webserver` 对抛出异常的处理器回
*     一个空的 400，所以这里自己捕获并回结构化错误，让 UI 能说明原因。
*
* @module dsh-environment-tray/host-api
*/
const execFileAsync = promisify(execFile);
/**
* 真实的 `reg.exe` 执行器。
*
* 刻意用 `execFile` 而不是 shell：参数数组不会被 shell 解释，变量名里的特殊
* 字符不会被注入。返回值必须是 **Buffer**（原始字节），因为 `reg.exe` 写的是
* 控制台代码页而非 UTF-8。
*
* @param args - `reg.exe` 参数。
* @returns stdout 原始字节。
*/
async function runReg(args) {
	const { stdout } = await execFileAsync("reg.exe", args, {
		windowsHide: true,
		maxBuffer: 8388608,
		encoding: "buffer"
	});
	return stdout;
}
/** 值的展示上限：超过就摘要化。 */
const VALUE_PREVIEW_LIMIT = 120;
/** 路由路径。命名成 `/api/` 前缀以贴合 Web 端的既有约定。 */
const STATE_ROUTE = "/api/env-manager/state";
/** 探活路由。 */
const HEALTH_ROUTE = "/api/env-manager/health";
/** 密钥状态路由（只报"是否已配置"，永不回值）。 */
const CREDENTIAL_STATE_ROUTE = "/api/env-manager/credential-state";
const VALUE_ROUTE = "/api/env-manager/value";
/**
* 摘要素值以便展示。
*
* 长值（例如 `PATH`）只给长度与首尾片段 —— 它们的信息量在结构而不在全文。
*
* @param value - 原始值。
* @returns 展示视图 `{ preview, length, truncated }`。
*/
function summarizeValue(value) {
	const text = String(value);
	if (text.length <= VALUE_PREVIEW_LIMIT) return {
		preview: text,
		length: text.length,
		truncated: false
	};
	return {
		preview: `${text.slice(0, 60)}…${text.slice(-30)}`,
		length: text.length,
		truncated: true
	};
}
/**
* 把复合模型投影成传输视图。
*
* @param model - `buildEnvironmentModel()` 的结果。
* @param options - 投影选项。
* @param options.revealValues - 是否包含值。默认 true。
* @param options.revealSensitive - 是否连敏感名的值一起给。默认 false。
* @returns 可 JSON 序列化的视图。
*/
function projectState(model, options = {}) {
	const revealValues = options.revealValues !== false;
	/**
	* 严格布尔化：`options.revealSensitive` 的公开类型已是 `boolean`，但宿主
	* 里同一份选项可能在未类型化的边界被拼出来（见 `/state` 解析 `reveal` 的
	* 那条注释）。用 `=== true` 而不是真值判断，保证任何非 true 的取值 ——
	* 包括 `"true"`、`1`、`undefined` —— 都留在默认的遮蔽路径上。
	*/
	const revealSensitive = options.revealSensitive === true;
	const variables = model.variables.map((variable) => ({
		name: variable.name,
		effective: variable.effective,
		shadowed: variable.shadowed,
		forbidden: variable.forbidden,
		sensitive: variable.sensitive,
		runtimeManaged: variable.runtimeManaged,
		/** 该变量的层数：>1 表示存在遮蔽竞争。 */
		layerCount: variable.layers.length,
		layers: variable.layers.map((layer) => {
			const entry = {
				layer: layer.layer,
				writable: layer.writable,
				...layer.path === void 0 ? {} : { path: layer.path },
				...layer.blockedCode === void 0 ? {} : { blockedCode: layer.blockedCode },
				...layer.registryType === void 0 ? {} : { registryType: layer.registryType },
				...layer.requiresElevation === true ? { requiresElevation: true } : {}
			};
			if (variable.sensitive && !revealSensitive) {
				entry.redacted = true;
				if (layer.value !== void 0) entry.valueLength = String(layer.value).length;
				return entry;
			}
			if (layer.value === void 0) return entry;
			if (revealValues) entry.valueSummary = summarizeValue(layer.value);
			else entry.valueLength = String(layer.value).length;
			return entry;
		})
	}));
	return {
		cwd: model.cwd,
		home: model.home,
		files: {
			project: model.projectFile?.path ?? null,
			user: model.userFile?.path ?? null
		},
		/**
		* 解析诊断（当前只有 BOM）。UI **必须**显示它们：
		* 带 BOM 的文件里第一个变量名对 DSH 而言与界面显示的不同，静默处理等于隐瞒。
		*/
		warnings: model.warnings ?? [],
		/** 文案表：与层里的 `blockedCode` 配合使用，只传一次而不是每行一份。 */
		blockedReasonText: BLOCKED_REASON_TEXT,
		counts: {
			total: variables.length,
			shadowed: variables.filter((v) => v.shadowed).length,
			forbidden: variables.filter((v) => v.forbidden).length,
			sensitive: variables.filter((v) => v.sensitive).length,
			runtimeManaged: variables.filter((v) => v.runtimeManaged).length
		},
		variables
	};
}
/**
* 构造宿主 API 处理器集合。
*
* @param options - 依赖。
* @param options.ctx - cordis 上下文。
* @param options.osLayer - OS 环境层适配器；默认用真实 `reg.exe`。
* @returns 路由处理器与注册函数。
*/
function createHostApi(options) {
	const { ctx } = options;
	const osLayer = options.osLayer ?? new OsEnvironmentLayer({ run: runReg });
	const guard = options.guard ?? createRequestGuard({ connection: options.connection ?? ctx.connection });
	/** 从查询串取工作目录；未指定则用进程 cwd。 */
	const cwdOf = (req) => {
		try {
			return new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd") ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	/** 只接受 GET/HEAD；其余明确回 405，而不是让处理器假装成功。 */
	const requireGet = (req, res) => {
		if (req.method === "GET" || req.method === "HEAD") return true;
		res.writeHead(405, { allow: "GET, HEAD" });
		res.end();
		return false;
	};
	return {
		/** 完整值只按用户选中的名称和层读取，不进入列表响应。 */
		async value(req, res) {
			if (!guard(req, res)) return;
			if (req.method !== "POST") {
				res.writeHead(405, { allow: "POST" });
				res.end();
				return;
			}
			try {
				const body = await readJsonBody(req);
				if (typeof body.name !== "string" || body.name.length === 0 || body.name.includes("\0")) {
					writeJson(res, 400, {
						ok: false,
						error: "invalid-name",
						message: "变量名无效"
					});
					return;
				}
				let value;
				let revision;
				const equal = (name) => process.platform === "win32" ? name.toUpperCase() === body.name.toUpperCase() : name === body.name;
				if (body.layer === "credential") {
					if (!isPossibleRef(body.name)) {
						writeJson(res, 400, {
							ok: false,
							error: "invalid-ref",
							message: "凭据名称无效"
						});
						return;
					}
					if (!ctx.credentials?.resolve) {
						writeJson(res, 501, {
							ok: false,
							error: "credentials-unavailable",
							message: "无法读取凭据"
						});
						return;
					}
					value = (await ctx.credentials.resolve(body.name))?.value;
				} else if (body.layer === "project-env" || body.layer === "user-env") {
					const cwd = cwdOf(req);
					const model = buildEnvironmentModel({ cwd });
					const file = await readDotEnvFile(resolveLayerPath(body.layer, cwd, model.home));
					const name = Object.keys(file.values).find(equal);
					value = name === void 0 ? void 0 : file.values[name];
					revision = file.revision;
				} else if (body.layer === "process") {
					const name = Object.keys(process.env).find(equal);
					value = name === void 0 ? void 0 : process.env[name];
				} else if (body.layer === "os-user" || body.layer === "os-machine") {
					const scope = (await osLayer.readAll())[body.layer];
					if (scope.error) throw new Error("无法读取注册表");
					value = scope.entries.find((entry) => equal(entry.name))?.value;
				} else {
					writeJson(res, 400, {
						ok: false,
						error: "invalid-layer",
						message: "环境层无效"
					});
					return;
				}
				if (value === void 0) {
					writeJson(res, 404, {
						ok: false,
						error: "value-missing",
						message: "值已不存在"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					value,
					...revision === void 0 ? {} : { revision }
				});
			} catch {
				writeJson(res, 500, {
					ok: false,
					error: "read-failed",
					message: "读取失败"
				});
			}
		},
		/** GET /api/env-manager/state —— 复合模型视图。 */
		async state(req, res) {
			if (!guard(req, res)) return;
			if (!requireGet(req, res)) return;
			try {
				const url = new URL(req.url ?? "/", "http://localhost");
				/**
				* `reveal` 的三个取值，**白名单匹配而不是前缀/宽松匹配**：
				*
				*   - `0`   —— 只要结构不要值（用于先渲染骨架），连摘要都不给
				*   - `all` —— 值**含**敏感名（用户在 UI 里显式打开的开关）
				*   - 其余（含缺省、`1`、以及任何拼错的串）—— 默认：给值，但敏感名仍遮蔽
				*
				* 拼错必须落到默认而不是 `all`。宽松解析（`startsWith('a')`、
				* 真值判定、`!== '0'` 之类的取反）会把 `reveal=al`、`reveal=ALL`、
				* `reveal=true` 静默升级成"把密钥发出去" —— 一个 typo 就是一次泄露。
				* 所以这里写成显式的 `=== 'all'`，且只在**没有**其他解释时才生效。
				*/
				const revealParam = url.searchParams.get("reveal");
				const reveal = revealParam !== "0";
				const revealSensitive = revealParam === "all";
				const includeOs = url.searchParams.get("os") !== "0";
				const model = buildEnvironmentModel({ cwd: cwdOf(req) });
				let osStatus;
				if (includeOs) {
					const osLayers = await osLayer.readAll();
					model.variables = mergeOsLayers(model, osLayers);
					osStatus = {
						supported: osLayer.supported,
						scopes: {
							[USER_SCOPE]: {
								error: osLayers["os-user"].error ?? null,
								count: osLayers[USER_SCOPE].entries.length
							},
							[MACHINE_SCOPE]: {
								error: osLayers["os-machine"].error ?? null,
								count: osLayers[MACHINE_SCOPE].entries.length
							}
						}
					};
				} else osStatus = {
					supported: osLayer.supported,
					skipped: true
				};
				const body = projectState(model, {
					revealValues: reveal,
					revealSensitive
				});
				body.os = osStatus;
				writeJson(res, 200, body);
			} catch (error) {
				writeJson(res, 500, {
					error: "state-failed",
					message: errorText(error)
				});
			}
		},
		/**
		* GET /api/env-manager/credential-state —— 探测一组名字的密钥状态。
		*
		* 用 GET + 查询串而不是把名字塞进主 state 响应，原因有二：
		*  1. 主 state 是环境变量的视图，密钥是另一个键空间；混在一起会含糊。
		*  2. 客户端知道自己关心哪些名字（从 state 里筛出敏感名），按需查询即可，
		*     不必让每个 state 请求都多付一轮凭据读取。
		*
		* 响应里**只有** `{ configured, writable, source, sourceLabel, editable, blockedReason }`，
		* 没有任何可以搭载值的位置。
		*/
		async credentialState(req, res) {
			if (!guard(req, res)) return;
			if (!requireGet(req, res)) return;
			try {
				const refs = (new URL(req.url ?? "/", "http://localhost").searchParams.get("refs") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
				const access = credentialAccessOf(ctx);
				if (access === void 0) {
					writeJson(res, 200, {
						available: false,
						refs: {}
					});
					return;
				}
				writeJson(res, 200, {
					available: true,
					refs: await access.describeMany(refs)
				});
			} catch (error) {
				writeJson(res, 500, {
					error: "credential-state-failed",
					message: errorText(error)
				});
			}
		},
		/** GET /api/env-manager/health —— 轻量探活，供 P4 目视确认。 */
		health(req, res) {
			if (!guard(req, res)) return;
			if (!requireGet(req, res)) return;
			writeJson(res, 200, {
				ok: true,
				pid: process.pid,
				uptimeSeconds: Math.round(process.uptime()),
				routes: [STATE_ROUTE, HEALTH_ROUTE]
			});
		},
		/**
		* 注册两条路由。
		*
		* 用 `ctx.inject([...], cb)` 延迟激活：`webServer` 与本插件行的激活顺序
		* 不保证，直接读会拿到 `undefined`（P0 已经踩过这个坑 —— cordis 的
		* `ReflectService._getImpl` 在 strict 模式下要求服务所属 fiber 已 ACTIVE）。
		*
		* @returns 注册用的 fiber（PromiseLike），可忽略。
		*/
		register() {
			if (typeof ctx.inject !== "function") {
				ctx.logger?.("env-manager")?.warn?.("[env-manager] ctx.inject unavailable — host API routes not registered");
				return;
			}
			const stateHandler = this.state.bind(this);
			const healthHandler = this.health.bind(this);
			const credentialStateHandler = this.credentialState.bind(this);
			const valueHandler = this.value.bind(this);
			return ctx.inject(["webServer"], (scope) => {
				scope.effect(() => {
					const disposers = [
						scope.webServer.register({
							kind: "exact",
							path: STATE_ROUTE,
							handler: stateHandler
						}),
						scope.webServer.register({
							kind: "exact",
							path: HEALTH_ROUTE,
							handler: healthHandler
						}),
						scope.webServer.register({
							kind: "exact",
							path: CREDENTIAL_STATE_ROUTE,
							handler: credentialStateHandler
						}),
						scope.webServer.register({
							kind: "exact",
							path: VALUE_ROUTE,
							handler: valueHandler
						})
					];
					return () => {
						for (const dispose of disposers) try {
							dispose();
						} catch {}
					};
				});
				ctx.logger?.("env-manager")?.info?.(`[env-manager] routes registered: ${STATE_ROUTE}, ${HEALTH_ROUTE}, ${CREDENTIAL_STATE_ROUTE}`);
			});
		},
		/**
		* 注册写路由（`.env` / 凭据 / 注册表）。
		*
		* 与读路由分开是刻意的：写端点的爆炸半径大得多，分开注册让 composition
		* 可以选择只暴露只读面。
		*
		* @param writeRoutes - `createWriteRoutes()` 的结果。
		* @returns 注册用的 fiber（PromiseLike）。
		*/
		registerWriteRoutes(writeRoutes) {
			if (typeof ctx.inject !== "function") return void 0;
			const bound = {
				env: writeRoutes.env.bind(writeRoutes),
				envRead: writeRoutes.envRead.bind(writeRoutes),
				credentials: writeRoutes.credentials.bind(writeRoutes),
				registry: writeRoutes.registry.bind(writeRoutes)
			};
			return ctx.inject(["webServer"], (scope) => {
				scope.effect(() => {
					const disposers = [
						scope.webServer.register({
							kind: "exact",
							path: ENV_ROUTE,
							handler: bound.env
						}),
						scope.webServer.register({
							kind: "exact",
							path: `${ENV_ROUTE}/read`,
							handler: bound.envRead
						}),
						scope.webServer.register({
							kind: "exact",
							path: CREDENTIAL_ROUTE,
							handler: bound.credentials
						}),
						scope.webServer.register({
							kind: "exact",
							path: REGISTRY_ROUTE,
							handler: bound.registry
						})
					];
					return () => {
						for (const dispose of disposers) try {
							dispose();
						} catch {}
					};
				});
				ctx.logger?.("env-manager")?.info?.(`[env-manager] write routes registered: ${ENV_ROUTE}, ${CREDENTIAL_ROUTE}, ${REGISTRY_ROUTE}`);
			});
		}
	};
}
/**
* 写一个 JSON 响应。
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
/**
* 从 `unknown` 里安全取出 `message`，取不到就把原值整体字符串化。
*
* catch 变量在 strict 下是 `unknown`，直接读 `.message` 过不了类型检查。
* 这里按**形状**取值而不是 `instanceof Error` —— 宿主与子进程抛出的未必是
* `Error` 实例，断言的范围也只有这一个属性；结果与原来的
* `String(error?.message ?? error)` 完全一致（对 null/undefined 与基本类型同样安全）。
*
* @param error - 任意抛出的值。
* @returns 诊断文本。
*/
function errorText(error) {
	const message = error?.message;
	return String(message ?? error);
}
//#endregion
export { CREDENTIAL_STATE_ROUTE, HEALTH_ROUTE, STATE_ROUTE, VALUE_ROUTE, createHostApi, projectState, runReg, summarizeValue };
