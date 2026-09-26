//#region src/registry.ts
/** 用户级作用域：优先级更高。 */
const USER_SCOPE = "os-user";
/** 系统级作用域。 */
const MACHINE_SCOPE = "os-machine";
/** 注册表路径。 */
const KEYS = {
	[USER_SCOPE]: "HKCU\\Environment",
	[MACHINE_SCOPE]: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
};
/** `reg.exe` 报告的类型 → 我们的规范化类型。 */
const VALUE_TYPES = /* @__PURE__ */ new Set([
	"REG_SZ",
	"REG_EXPAND_SZ",
	"REG_MULTI_SZ",
	"REG_DWORD",
	"REG_QWORD",
	"REG_BINARY",
	"REG_NONE"
]);
/**
* 宽松解码 `reg.exe` 输出。
*
* `reg.exe` 写的是控制台代码页（中文 Windows 上是 GBK），而 Node 默认按 UTF-8
* 解。`TextDecoder` 的 `fatal: false` 会把无法解释的字节替换成 U+FFFD 而**不抛错**，
* 所以能拿到可用的 ASCII 部分（类型名与变量名都是 ASCII），代价是非 ASCII 的
* **值**可能带替换字符。这是已知限制，不是可以悄悄忽略的问题：UI 展示注册表里
* 的非 ASCII 值时应标注可能不精确。
*
* @param buffer - 原始字节。
* @returns 解码后的文本。
*/
function decodeRegOutput(buffer) {
	return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}
/**
* 把注册表键路径规范化成可比形式。
*
* **这是必须的**：`reg query` 接受缩写根（`HKCU\Environment`），但**输出用全名**
* （`HKEY_CURRENT_USER\Environment`）。不统一两者，scope 判断永远匹配不上，
* 表现为"解析出 0 个值"这个极具误导性的症状（实测踩过）。
*
* @param path - 键路径或输出里的键头。
* @returns 统一为全名 + 大写的形式。
*/
function normalizeKeyPath(path) {
	return String(path).trim().replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\").replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\").toUpperCase();
}
/**
* 解析 `reg.exe query` 的输出。
*
* 输出形如：
* ```
* HKEY_CURRENT_USER\Environment
*     Path    REG_EXPAND_SZ    %USERPROFILE%\bin
*     TEMP    REG_SZ    C:\Users\x\AppData\Local\Temp
* ```
* 子键块（`...\Environment\SubKey` 后面跟自己的值）要被跳过，只取本键的值。
* `(Default)` 是默认值的显示形式，正式名称为空串。
*
* @param text - 解码后的输出。
* @param keyPath - 被查询的键路径（可用缩写根），用于区分本键与其子键。
* @returns `{ name, type, value }` 数组。
*/
function parseRegQuery(text, keyPath) {
	const out = [];
	const lines = text.split(/\r?\n/);
	const wantKey = normalizeKeyPath(keyPath);
	let inScope = false;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		if (!/^\s/.test(line) && line.includes("\\")) {
			inScope = normalizeKeyPath(line) === wantKey;
			continue;
		}
		if (!inScope) continue;
		const match = /^\s{4}(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line);
		if (match === null) continue;
		const rawName = match[1].trim();
		const type = match[2];
		if (!VALUE_TYPES.has(type)) continue;
		out.push({
			name: rawName === "(Default)" ? "" : rawName,
			type,
			value: match[3] ?? ""
		});
	}
	return out;
}
/**
* OS 环境层的读取/写入端口。抽象成类以便测试注入假执行器。
*/
var OsEnvironmentLayer = class {
	/** 执行 `reg.exe`；未注入（或平台不支持）时为 undefined。 */
	run;
	/** 平台标识；`supported` 的依据之一。 */
	platform;
	/**
	* @param options - 依赖。
	* @param options.run - 执行 `reg.exe` 并把 stdout 作为 Buffer 返回。
	* @param options.platform - 平台标识；默认 `process.platform`。
	*/
	constructor(options = {}) {
		this.run = options.run;
		this.platform = options.platform ?? process.platform;
	}
	/**
	* 本平台是否支持读写 OS 环境层。
	*
	* Linux 与 macOS **没有**单一可靠的写入点（见设计文档 §2.2 / §2.3：
	* macOS GUI 启动的应用读 launchd 而非 shell profile，而 `launchctl setenv`
	* 不持久；Linux 的 `environment.d` 只影响 systemd 用户会话）。
	* 所以这里如实报告"不支持"，而不是假装读写成功。
	*
	* @returns 支持时为 true。
	*/
	get supported() {
		return this.platform === "win32" && typeof this.run === "function";
	}
	/**
	* 读取一个作用域的全部值。
	*
	* @param scope - `os-user` 或 `os-machine`。
	* @returns `{ scope, entries, error }`；失败时 `entries` 为空并带 `error`。
	*/
	async read(scope) {
		const run = this.run;
		if (!this.supported || run === void 0) return {
			scope,
			entries: [],
			error: "unsupported-platform"
		};
		const keyPath = KEYS[scope];
		if (keyPath === void 0) return {
			scope,
			entries: [],
			error: "unknown-scope"
		};
		let stdout;
		try {
			stdout = await run(["query", keyPath]);
		} catch (error) {
			return {
				scope,
				entries: [],
				error: errorText(error)
			};
		}
		return {
			scope,
			entries: parseRegQuery(decodeRegOutput(stdout), keyPath)
		};
	}
	/**
	* 读取两个作用域。
	*
	* @returns `{ 'os-user': [...], 'os-machine': [...] }`。
	*/
	async readAll() {
		const [user, machine] = await Promise.all([this.read(USER_SCOPE), this.read(MACHINE_SCOPE)]);
		return {
			[USER_SCOPE]: user,
			[MACHINE_SCOPE]: machine
		};
	}
	/**
	* 写一个值，**保留原有类型**。
	*
	* 为什么必须保留类型：`REG_EXPAND_SZ` 的值含 `%VAR%` 引用，由 Windows 在
	* 进程启动时展开。若写回 `REG_SZ`，`%USERPROFILE%` 就会变成字面量。
	*
	* @param scope - 作用域。
	* @param name - 变量名。
	* @param value - 新值（`REG_EXPAND_SZ` 时应传含 `%VAR%` 的原文）。
	* @param type - 原有类型；省略则按 `REG_SZ` 处理。
	* @returns 写入结果。
	*/
	async write(scope, name, value, type = "REG_SZ") {
		const run = this.run;
		if (!this.supported || run === void 0) return {
			ok: false,
			error: "unsupported-platform"
		};
		const keyPath = KEYS[scope];
		if (keyPath === void 0) return {
			ok: false,
			error: "unknown-scope"
		};
		const effectiveType = VALUE_TYPES.has(type) ? type : "REG_SZ";
		const args = [
			"add",
			keyPath,
			"/v",
			name,
			"/t",
			effectiveType,
			"/d",
			String(value),
			"/f"
		];
		try {
			await run(args);
			return {
				ok: true,
				type: effectiveType
			};
		} catch (error) {
			return {
				ok: false,
				error: errorText(error)
			};
		}
	}
	/**
	* 读取一个作用域里的单个值。
	*
	* 用于"删除前先备份原值"：删除是不可逆的，而 UI 只有摘要（长值被截断），
	* 所以撤销能力必须在**宿主侧**取得完整原值。
	*
	* @param scope - 作用域。
	* @param name - 变量名。
	* @returns `{ found, value?, type? }`。
	*/
	async readOne(scope, name) {
		const all = await this.read(scope);
		if (all.error !== void 0) return {
			found: false,
			error: all.error
		};
		const want = process.platform === "win32" ? name.toUpperCase() : name;
		const hit = all.entries.find((e) => (process.platform === "win32" ? e.name.toUpperCase() : e.name) === want);
		return hit === void 0 ? { found: false } : {
			found: true,
			name: hit.name,
			value: hit.value,
			type: hit.type
		};
	}
	/**
	* 删除一个值，并**返回被删的原值与类型**以便撤销。
	*
	* 删除注册表值没有回收站。返回原值是让 UI 至少能提供"撤销"的唯一途径。
	*
	* @param scope - 作用域。
	* @param name - 变量名。
	* @returns `{ ok, removed? }`；`removed` 含 `{ name, value, type }`。
	*/
	async remove(scope, name) {
		const run = this.run;
		if (!this.supported || run === void 0) return {
			ok: false,
			error: "unsupported-platform"
		};
		const keyPath = KEYS[scope];
		if (keyPath === void 0) return {
			ok: false,
			error: "unknown-scope"
		};
		const backup = await this.readOne(scope, name).catch(() => ({ found: false }));
		try {
			await run([
				"delete",
				keyPath,
				"/v",
				name,
				"/f"
			]);
			return {
				ok: true,
				...backup.found === true ? { removed: {
					name: backup.name ?? name,
					value: backup.value,
					type: backup.type
				} } : {
					removed: void 0,
					backupUnavailable: true
				}
			};
		} catch (error) {
			return {
				ok: false,
				error: errorText(error)
			};
		}
	}
	/**
	* 计算 Windows 的 PATH 合并语义。
	*
	* **系统 PATH 在前**，用户 PATH 追加在后 —— 这是 Windows 上唯一会"两层叠加"
	* 的变量，其他变量都是用户级覆盖系统级。UI 若不显示这个区别，用户在
	* "改了没生效"时会无从判断自己改错了哪一份。
	*
	* @param userPath - 用户级 PATH（可含 `%VAR%`）。
	* @param machinePath - 系统级 PATH。
	* @returns 合并前后的视图。
	*/
	static mergePath(userPath, machinePath) {
		const hasUser = typeof userPath === "string" && userPath.length > 0;
		const hasMachine = typeof machinePath === "string" && machinePath.length > 0;
		if (!hasUser && !hasMachine) return {
			combined: "",
			order: []
		};
		if (!hasUser) return {
			combined: machinePath ?? "",
			order: ["os-machine"]
		};
		if (!hasMachine) return {
			combined: userPath ?? "",
			order: ["os-user"]
		};
		return {
			combined: `${machinePath};${userPath}`,
			order: ["os-machine", "os-user"]
		};
	}
};
/**
* 把 OS 层的值合并进复合环境模型。
*
* 作为**额外层**加入：`os-user` 与 `os-machine` 在信任顺序上低于 `process`
* （因为进程启动时已经继承了它们），但在展示上必须与 `project-env` /
* `user-env` 并列，否则用户看不出"注册表里设了但被进程遮蔽"。
*
* @param model - `buildEnvironmentModel()` 的结果。
* @param osLayers - `readAll()` 的结果。
* @returns 新的变量数组（不修改入参）。
*/
function mergeOsLayers(model, osLayers) {
	const byName = /* @__PURE__ */ new Map();
	for (const variable of model.variables) byName.set(variable.name, {
		...variable,
		layers: [...variable.layers]
	});
	/** Windows 上名字大小写不敏感。 */
	const fold = (name) => process.platform === "win32" ? name.toUpperCase() : name;
	const folded = /* @__PURE__ */ new Map();
	for (const [name, entry] of byName) folded.set(fold(name), entry);
	const addLayer = (scope, entries) => {
		for (const raw of entries ?? []) {
			if (raw.name.length === 0) continue;
			const key = fold(raw.name);
			let entry = folded.get(key);
			if (entry === void 0) {
				entry = {
					name: raw.name,
					layers: [],
					effective: void 0,
					shadowed: false,
					forbidden: false,
					sensitive: /KEY|PASSWORD|SECRET|TOKEN/i.test(raw.name),
					runtimeManaged: raw.name.toUpperCase().startsWith("DSH_")
				};
				folded.set(key, entry);
				byName.set(raw.name, entry);
			}
			if (entry.layers.some((l) => l.layer === scope)) continue;
			entry.layers.push({
				layer: scope,
				value: raw.value,
				registryType: raw.type,
				writable: true,
				...scope === "os-machine" ? { requiresElevation: true } : {}
			});
		}
	};
	addLayer(USER_SCOPE, osLayers[USER_SCOPE]?.entries);
	addLayer(MACHINE_SCOPE, osLayers[MACHINE_SCOPE]?.entries);
	const order = [
		"process",
		"project-env",
		"user-env",
		USER_SCOPE,
		MACHINE_SCOPE
	];
	const variables = [];
	for (const entry of byName.values()) {
		entry.layers.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer));
		entry.effective = entry.layers[0]?.layer;
		entry.shadowed = entry.layers.length > 1;
		entry.layerCount = entry.layers.length;
		variables.push(entry);
	}
	variables.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return variables;
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
export { MACHINE_SCOPE, OsEnvironmentLayer, USER_SCOPE, decodeRegOutput, mergeOsLayers, normalizeKeyPath, parseRegQuery };
