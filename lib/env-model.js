import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
//#region src/env-model.ts
/**
* DSH 环境变量复合模型 — 只读层解析。
*
* 这个模块是插件的**事实来源**：它把设计文档 §1 的"六个互相竞争的权威"
* 变成可计算的数据结构。UI 只渲染它的输出，不自己推断环境状态。
*
* 设计要点（全部有实测依据，见 docs/dsh-environment-tray-design.md）：
*
*  1. DSH 读 `.env` 用的是 `node:util.parseEnv`（`dsh-app-boot` 的 `readEnvLayer`），
*     所以这里的 `parseDotEnv` 必须与它**逐位一致** —— `verify-env-model.mjs`
*     用差分测试证明这一点，而不是靠阅读文档。
*  2. `.env` **不做任何变量展开**：`$VAR` / `${VAR}` / `%VAR%` 全是字面量。
*  3. 冒号分隔行（`KEY: value`）会被静默丢弃 —— 这是最危险的静默失败点。
*  4. 信任顺序：`process` > `project-env` > `user-env`（来自 `SOURCE_ORDER`）。
*  5. 禁止名单（`BOOTSTRAP_NAMES` / `BOOTSTRAP_PREFIXES`）命中的名字写进 `.env`
*     会让 DSH **启动失败**，不是被忽略。UI 必须前置拦截。
*  6. 唯一例外：`$DSH_HOME/.env` 允许那 4 个代理变量。
*
* @module dsh-environment-tray/env-model
*/
/** 层的信任顺序，最可信在前。与 `dsh-launch-environment` 的 `SOURCE_ORDER` 一致。 */
const SOURCE_ORDER = [
	"process",
	"project-env",
	"user-env"
];
/**
* 任何 `.env` 文件都不得声明的精确名字。
* 来源：`dsh-app-boot` 的 `BOOTSTRAP_NAMES`（逐条抄录，顺序保持原样便于比对）。
*/
const BOOTSTRAP_NAMES = /* @__PURE__ */ new Set([
	"PATH",
	"HOME",
	"USERPROFILE",
	"SHELL",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"PERL5OPT",
	"PERL5LIB",
	"PYTHONSTARTUP",
	"PYTHONPATH",
	"PYTHONHOME",
	"RUBYOPT",
	"RUBYLIB",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_COUNT",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"BROWSER",
	"DEEPSEEK_BASE_URL",
	"DEEPSEEK_SEARCH_BASE_URL",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"NODE_TLS_REJECT_UNAUTHORIZED"
]);
/** 任何 `.env` 文件都不得使用的名字前缀。来源：`BOOTSTRAP_PREFIXES`。 */
const BOOTSTRAP_PREFIXES = [
	"DSH_",
	"XDG_",
	"DYLD_",
	"BASH_FUNC_"
];
/**
* 只有 `$DSH_HOME/.env` 允许设置的代理变量。
*
* 源码注释给出的理由：代理决定每个请求走哪条路，所以随仓库分发的项目文件
* 继续拒绝它们；而这个 CA/TLS 同组成员则在所有层都拒绝，因为它们改变的是
* "信任什么"，不是"流量去哪"。
*/
const HOME_LAYER_PROXY_NAMES = /* @__PURE__ */ new Set([
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY"
]);
/** 敏感名字形状：子进程 spawn 时会被 `scrubbedParentEnv` 清洗掉。 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
/**
* 名字是否只能由启动环境提供（即写进任何 `.env` 都会拒绝启动）。
*
* @param name - 变量名。
* @returns 命中精确名单或前缀禁令时为 true。
*/
function isBootstrapOnly(name) {
	const upper = name.toUpperCase();
	return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
/**
* 解析一个 `.env` 文件的内容，语义**对齐 `node:util.parseEnv`**。
*
* 下面每一条都不是从文档推的，而是 `probe-parseenv-escapes.mjs` 实测出来的，
* 并由 `verify-env-model.mjs` 的差分测试持续守住：
*
*   - `export KEY=value` 前缀被接受并剥离
*   - `KEY: value` **整行丢弃**，且静默（最危险的静默失败点）
*   - `#` 在引号外**无条件**截断值，不需要前导空格；引号内不截断
*   - 双引号里**只有换行转义**被还原；其余转义序列全部保留字面
*   - 反斜杠**不能**转义引号 —— 首个同类引号即收尾
*   - 单引号是纯字面量，不做任何处理
*   - 键**不**去引号：`"K"=v` 的键就是 `"K"`
*   - **不做变量展开**
*
* **BOM 例外**：`parseEnv` 不剥离开头的 U+FEFF，于是带 BOM 的文件里第一个
* 变量名会变成 `\uFEFFFIRST` —— 一个在界面上**不可见**（BOM 无字形）、
* 因而用户既看不到也删不掉的名字，而 DSH 读到的键名与显示的不同。
* 这里**剥掉它**，与绝大多数工具的行为一致；差异通过 `warnings` 报出去，
* 不静默处理。
*
* @param content - 文件全文。
* @param warnings - 可选回调，接收 `{ code, message }` 形式的诊断。
* @returns 解析出的键值对；同名后者覆盖前者。
*/
function parseDotEnv(content, warnings) {
	let text = String(content);
	if (text.charCodeAt(0) === 65279) {
		text = text.slice(1);
		if (typeof warnings === "function") warnings({
			code: "bom",
			message: "文件以 UTF-8 BOM 开头。已按常规做法忽略它；但 DSH 自身的解析器不忽略，会把 BOM 算进第一个变量名（界面上不可见）。建议去掉 BOM。"
		});
	}
	const out = {};
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		let line = lines[index].trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("export")) {
			const after = line.slice(6);
			if (after.length === 0 || after[0] === " " || after[0] === "	") line = after.trim();
		}
		if (line.length === 0) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (key.length === 0) continue;
		let value = line.slice(eq + 1).trim();
		const quote = value[0];
		if (quote === "\"" || quote === "'") {
			let end = closingQuoteIndex(value, quote);
			while (end === -1 && index + 1 < lines.length) {
				index += 1;
				value += "\n";
				value += lines[index];
				lines[index] = "";
				end = closingQuoteIndex(value, quote);
			}
			if (end === -1) {
				out[key] = quote === "\"" ? unescapeDouble(value.slice(1)) : value.slice(1);
				continue;
			}
			const body = value.slice(1, end);
			out[key] = quote === "\"" ? unescapeDouble(body) : body;
		} else {
			const hash = value.indexOf("#");
			out[key] = (hash === -1 ? value : value.slice(0, hash)).trim();
		}
	}
	return out;
}
/**
* 找到起始引号对应的收尾引号下标。
*
* **没有转义概念**：`parseEnv` 里反斜杠不参与引号匹配，首个同种引号即收尾。
* 实测 `"he said \"hi\""` → `he said \`，印证了这一点。
*
* @param text - 以引号开头的值文本。
* @param quote - 引号字符（`"` 或 `'`）。
* @returns 收尾引号下标；未闭合时为 -1。
*/
function closingQuoteIndex(text, quote) {
	return text.indexOf(quote, 1);
}
/**
* 还原双引号字符串里的转义。
*
* **只处理 `\n`** —— 这是实测结论：`\t` `\\` `\"` `\/**
`\uXXXX` 等在
* `parseEnv` 里全部保留字面。把 `\\` 也还原会破坏"反斜杠不能被转义"的语义。
*
* @param body - 引号内的原文。
* @returns 还原后的值。
*/
function unescapeDouble(body) {
	return body.replace(/\\n/g, "\n");
}
/**
* 序列化结果的可表示性问题登记表（以生成的行为键）。
*
* 有些值在 `.env` 里**根本无法忠实表示** —— 因为 `parseEnv` 不提供任何
* 转义机制。UI 必须能拿到这个信息并拒绝保存，而不是静默写坏用户的值。
*/
const representabilityIssues = /* @__PURE__ */ new Map();
/**
* 序列化一个键值对为 `.env` 行。
*
* 引号策略完全依据实测（`probe-quote-strategy.mjs` + `probe-roundtrip-via-file.mjs`，
* 且同时在 `parseEnv` 与 `process.loadEnvFile` 两条路径上验证过）：
*
*   | 值的形状 | 写法 | 是否忠实 |
*   |---|---|---|
*   | 普通 | `KEY="v"` | ✅ |
*   | 含 `"` | `KEY='v'` | ✅ 单引号内双引号是字面量 |
*   | 含换行 | `KEY="a\nb"` | ✅ `\n` 是双引号内唯一被识别的转义 |
*   | 含 `'` | `KEY="v"` | ✅ 单引号在双引号内安全 |
*   | 同时含 `"` 和 `'` | 无解 | ❌ 两种引号都会截断 |
*   | 同时含 `"` 和换行 | 无解 | ❌ 双引号会吃掉 `"` |
*   | 空值 | `KEY=""` | ⚠️ 能读回，但与"未设置"无法区分 |
*
* 绝不生成 `KEY: value` 形式（那会被静默丢弃）。
*
* @param key - 变量名。
* @param value - 变量值。
* @returns 一行可被 `parseDotEnv`/`parseEnv`/`loadEnvFile` 稳定读回的内容。
*
* @remarks
* `value` 如实声明为 `string | undefined`：旧实现把它直接交给 `String()`，
* 传 `undefined` 会写出字面量 `"undefined"`。类型只是把既有事实写出来，
* 不用断言把它藏起来（调用方本应传字符串 —— 见验收报告里的疑似缺陷）。
*/
function serializeDotEnvLine(key, value) {
	const text = String(value);
	const hasDouble = text.includes("\"");
	const hasSingle = text.includes("'");
	const hasNewline = text.includes("\n");
	let literal;
	let reason;
	if (text.length === 0) {
		reason = "空值：写进 .env 后无法与\"未设置\"区分，凭据域也把空值视为未设置";
		literal = "\"\"";
	} else if (hasDouble && hasSingle) {
		reason = "值同时含双引号与单引号：.env 的两种引号都会在首个同类引号处截断，无解";
		literal = `"${text.replace(/\n/g, "\\n")}"`;
	} else if (hasDouble && hasNewline) {
		reason = "值同时含双引号与换行：双引号内引号无法转义，单引号又不能跨行表示";
		literal = `"${text.replace(/\n/g, "\\n")}"`;
	} else if (hasDouble) literal = `'${text}'`;
	else literal = `"${text.replace(/\n/g, "\\n")}"`;
	const line = `${key}=${literal}`;
	if (reason === void 0) representabilityIssues.delete(line);
	else representabilityIssues.set(line, {
		reason,
		lossy: text.length > 0
	});
	return line;
}
/**
* 查询某一行序列化结果的可表示性问题。
*
* 两种问题必须区分开：
*   - `lossy: true` —— 写下去再读回来**值就变了**，必须拒绝保存
*   - `lossy: false` —— 能读回原值，但与"未设置"无法区分（仅空值），必须提醒
*
* @param line - `serializeDotEnvLine` 的返回值。
* @returns `{ reason, lossy }`；可表示时为 undefined。
*/
function representabilityOf(line) {
	return representabilityIssues.get(line);
}
/**
* 解析 DSH home：显式配置 > `$DSH_HOME` > `~/.dsh`；空白值视为未设置。
*
* 与 `dsh-home-paths` 的 `resolveDshHome` 规则一致。
*
* @param env - 用于解析的环境，默认 `process.env`。
* @returns home 绝对路径。
*/
function resolveDshHome(env = process.env) {
	const configured = env.DSH_HOME;
	if (typeof configured === "string" && configured.trim().length > 0) return resolve(configured);
	return resolve(homedir(), ".dsh");
}
/**
* 读一个层的 `.env`，并收集解析诊断。
*
* @param path - 文件绝对路径。
* @param warnings - 诊断收集数组（会被就地追加）。
* @returns 文件存在时返回 `{ path, values }`，否则 undefined。读取失败不抛错。
*/
function readEnvFile(path, warnings) {
	let content;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return;
	}
	return {
		path,
		values: parseDotEnv(content, (warning) => {
			if (Array.isArray(warnings)) warnings.push({
				...warning,
				path
			});
		})
	};
}
/**
* 各层的写权限判断。
*
* **返回机器可读的 `blockedCode`，不返回文案。** 原因有二：
*   1. 传输体积：`process` 层每个变量都会命中同一条原因，101 个变量各带一份
*      中文说明会让一次响应多出 ~25 KB（实测 27.8 KB → 结构化后大幅下降）。
*   2. 职责：文案本地化是客户端的事，宿主只负责事实。
* 文案映射见 {@link BLOCKED_REASON_TEXT}。
*
* @param name - 变量名。
* @param layer - 层标识。
* @returns `{ writable, blockedCode? }`。
*/
function writabilityOf(name, layer) {
	if (layer === "process") return {
		writable: false,
		blockedCode: "process-inherited"
	};
	if (layer === "credential") return { writable: true };
	if (layer === "project-env" || layer === "user-env") {
		if (!isBootstrapOnly(name)) return { writable: true };
		const isProxy = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase());
		if (isProxy && layer === "user-env") return { writable: true };
		return {
			writable: false,
			blockedCode: isProxy ? "proxy-not-in-home" : "bootstrap-only"
		};
	}
	return {
		writable: false,
		blockedCode: "unknown-layer"
	};
}
/** `blockedCode` → 人类可读文案。客户端直接取用，宿主不再重复传输。 */
const BLOCKED_REASON_TEXT = {
	"process-inherited": "当前进程层只读",
	"proxy-not-in-home": "请在用户 .env 设置代理",
	"bootstrap-only": "请在启动 DSH 前设置",
	"unknown-layer": "不支持此环境层"
};
/**
* 构建复合环境视图：每个名字在每一层的取值、生效层与可写性。
*
* **这是 UI 的唯一数据来源。** 一个扁平列表会把"同名变量存在于多个权威层"
* 这个最关键的事实掩盖掉 —— 而那正是绝大多数环境变量问题的根因。
*
* @param options - 输入路径与环境。
* @param options.cwd - 项目层目录（`<cwd>/.env`）。
* @param options.home - DSH home；省略则走 `resolveDshHome`。
* @param options.env - 作为 `process` 层的环境，默认 `process.env`。
* @returns 按名字排序的复合变量数组。
*/
function buildEnvironmentModel(options = {}) {
	const cwd = resolve(options.cwd ?? process.cwd());
	const home = resolve(options.home ?? resolveDshHome(options.env ?? process.env));
	const processEnv = options.env ?? process.env;
	/** 解析诊断（当前只有 BOM）：UI 必须能显示它们，不能静默处理。 */
	const warnings = [];
	const projectFile = readEnvFile(resolve(cwd, ".env"), warnings);
	const userFile = home === cwd ? void 0 : readEnvFile(resolve(home, ".env"), warnings);
	/** name -> { layer -> { value, path } }，键按平台规则归一。 */
	const byName = /* @__PURE__ */ new Map();
	/** Windows 上环境名大小写不敏感，这里做同样的折叠。 */
	const fold = (name) => process.platform === "win32" ? name.toUpperCase() : name;
	const record = (layer, path, values) => {
		for (const [rawName, value] of Object.entries(values)) {
			if (value === void 0) continue;
			const key = fold(rawName);
			let entry = byName.get(key);
			if (entry === void 0) {
				entry = {
					name: rawName,
					layers: {}
				};
				byName.set(key, entry);
			}
			if (entry.layers[layer] === void 0) entry.layers[layer] = path === void 0 ? { value } : {
				value,
				path
			};
		}
	};
	record("process", void 0, processEnv);
	if (projectFile !== void 0) record("project-env", projectFile.path, projectFile.values);
	if (userFile !== void 0) record("user-env", userFile.path, userFile.values);
	const variables = [];
	for (const entry of byName.values()) {
		const layers = [];
		let effective;
		for (const layer of SOURCE_ORDER) {
			const hit = entry.layers[layer];
			if (hit === void 0) continue;
			if (effective === void 0) effective = layer;
			const { writable, blockedCode } = writabilityOf(entry.name, layer);
			layers.push({
				layer,
				value: hit.value,
				...hit.path === void 0 ? {} : { path: hit.path },
				writable,
				...blockedCode === void 0 ? {} : { blockedCode }
			});
		}
		variables.push({
			name: entry.name,
			layers,
			effective,
			/** 多层各有取值即视为"被遮蔽"场景，UI 需要折叠展示。 */
			shadowed: layers.length > 1,
			forbidden: isBootstrapOnly(entry.name),
			/** 敏感名形状：模型 shell 里看不到它（subprocess 会清洗）。 */
			sensitive: SENSITIVE_ENV_PATTERN.test(entry.name),
			runtimeManaged: entry.name.toUpperCase().startsWith("DSH_")
		});
	}
	variables.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return {
		cwd,
		home,
		projectFile,
		userFile,
		variables,
		warnings
	};
}
/**
* 人类可读的一行摘要，供 P1 的只读视图与诊断使用。
*
* @param variable - 复合变量。
* @returns 单行描述。
*/
function describeVariable(variable) {
	const marks = [];
	if (variable.shadowed) marks.push("被遮蔽");
	if (variable.forbidden) marks.push("禁止写入");
	if (variable.runtimeManaged) marks.push("运行时管理");
	if (variable.sensitive) marks.push("shell 不可见");
	const value = variable.layers.find((l) => l.layer === variable.effective)?.value ?? "";
	const shown = value.length > 60 ? `${value.slice(0, 57)}...` : value;
	return `${variable.name} = ${JSON.stringify(shown)} [${variable.effective}]${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
}
//#endregion
export { BLOCKED_REASON_TEXT, BOOTSTRAP_NAMES, BOOTSTRAP_PREFIXES, HOME_LAYER_PROXY_NAMES, SENSITIVE_ENV_PATTERN, SOURCE_ORDER, buildEnvironmentModel, describeVariable, isBootstrapOnly, parseDotEnv, readEnvFile, representabilityOf, resolveDshHome, serializeDotEnvLine, writabilityOf };
