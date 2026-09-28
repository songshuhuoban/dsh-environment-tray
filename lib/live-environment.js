import { SENSITIVE_ENV_PATTERN, buildEnvironmentModel, isBootstrapOnly } from "./env-model.js";
import { OsEnvironmentLayer } from "./registry.js";
//#region src/live-environment.ts
/** 持久化成功后更新子进程下一次启动所读取的环境。 */
var LiveEnvironment = class {
	options;
	original;
	pending = Promise.resolve();
	constructor(options) {
		this.options = options;
		this.original = { ...options.env ?? process.env };
	}
	sync(change) {
		const run = this.pending.then(() => this.apply(change));
		this.pending = run.catch(() => {});
		return run;
	}
	async apply(change) {
		try {
			const env = this.options.env ?? process.env;
			const model = buildEnvironmentModel({
				cwd: change.cwd,
				home: change.home,
				env: {}
			});
			const fold = (name) => process.platform === "win32" ? name.toUpperCase() : name;
			const next = /* @__PURE__ */ new Map();
			let os;
			if ((change.layer.startsWith("os-") || change.names.some((name) => !model.variables.some((v) => fold(v.name) === fold(name)))) && this.options.osLayer.supported) {
				os = await this.options.osLayer.readAll();
				if (Object.values(os).some((scope) => scope.error)) return {
					appliedToProcess: false,
					restartRequired: true
				};
			}
			for (const name of change.names) {
				const key = fold(name);
				let value = model.variables.find((v) => fold(v.name) === key)?.layers[0]?.value;
				if (value === void 0 && os !== void 0) {
					const osValue = (scope) => {
						const entry = os[scope].entries.find((entry) => fold(entry.name) === key);
						if (entry === void 0) return void 0;
						let expanded = entry.value;
						if (entry.type === "REG_EXPAND_SZ") expanded = expanded.replace(/%([^%]+)%/g, (match, reference) => {
							const referenced = Object.keys(env).find((candidate) => fold(candidate) === fold(reference));
							return referenced === void 0 ? match : env[referenced] ?? match;
						});
						return expanded;
					};
					const userValue = osValue("os-user");
					const machineValue = osValue("os-machine");
					value = process.platform === "win32" && key === "PATH" ? userValue === void 0 && machineValue === void 0 ? void 0 : OsEnvironmentLayer.mergePath(userValue, machineValue).combined : userValue ?? machineValue;
				}
				if (value === void 0) {
					const inherited = this.options.launch?.getFrom(name, ["process"]);
					const originalName = Object.keys(this.original).find((candidate) => fold(candidate) === key);
					const original = inherited?.value ?? (this.options.launch === void 0 && originalName !== void 0 ? this.original[originalName] : void 0);
					value = change.removed !== void 0 && fold(change.removed.name) === key && original === change.removed.value ? void 0 : original;
				}
				const envName = Object.keys(env).find((candidate) => fold(candidate) === key) ?? name;
				if (envName.includes("\0") || envName.includes("=") || value?.includes("\0")) return {
					appliedToProcess: false,
					restartRequired: true
				};
				next.set(envName, value);
			}
			for (const [name, value] of next) if (value === void 0) delete env[name];
			else env[name] = value;
			return {
				appliedToProcess: true,
				restartRequired: change.names.some((name) => SENSITIVE_ENV_PATTERN.test(name) || isBootstrapOnly(name))
			};
		} catch {
			return {
				appliedToProcess: false,
				restartRequired: true
			};
		}
	}
};
//#endregion
export { LiveEnvironment };
