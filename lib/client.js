window.__ModuleLoader__.load({
	id: "@lanbaolu/dsh-fail-soft",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		/**
		* @lanbaolu/dsh-fail-soft — client 设置面板（settings.section slot）。
		*
		* 在 DSH 设置面板注册「Fail-soft 隔离」区域：
		* - 显示当前启用状态 / 持久化开关状态 / 内核补丁健康 / 被隔离插件；
		* - 提供 fail-soft 持久化开关（写 ~/.dsh/fail-soft.json，重启后生效），
		*   App / 终端用户都无需设置 DSH_FAIL_SOFT 环境变量。
		*
		* 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader 包装）。
		*/
		const inject = ["slots"];
		/** 设置面板里的 fail-soft 区域。 */
		function FailSoftSettingsSection() {
			const [status, setStatus] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [message, setMessage] = react.useState("");
			const refresh = async () => {
				try {
					const res = await fetch("/api/fail-soft/status");
					setStatus(await res.json());
				} catch {
					setStatus(null);
				}
			};
			react.useEffect(() => {
				refresh();
			}, []);
			const toggle = async () => {
				const next = !(status?.switchEnabled === true);
				setSaving(true);
				setMessage("");
				try {
					const result = await (await fetch("/api/fail-soft/set-enabled", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ enabled: next })
					})).json();
					if (result?.ok) {
						setMessage(next ? "✅ 已开启，重启 dsh 后生效" : "✅ 已关闭，重启 dsh 后生效");
						await refresh();
					} else setMessage("❌ " + (result?.error || "设置失败"));
				} catch {
					setMessage("❌ 请求失败");
				}
				setSaving(false);
			};
			const switchOn = status?.switchEnabled === true;
			const enabled = status?.enabled === true;
			const quarantined = status?.quarantined ?? [];
			const patch = status?.patch ?? {};
			const patchText = patch.status === "ok" ? "✅ 正常" : patch.status === "checking" ? "检测中…" : patch.status === "repaired" ? "✅ 已自动重打（重启后生效）" : patch.status === "needs-adaptation" || patch.status === "failed" || patch.status === "no-install" ? "⚠️ 需适配" : String(patch.status ?? "?");
			const row = {
				display: "flex",
				alignItems: "center",
				gap: 10,
				marginBottom: 8
			};
			const label = {
				fontSize: 13,
				fontWeight: 600
			};
			const hint = {
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary, #999)",
				marginBottom: 8,
				lineHeight: 1.5
			};
			const btn = {
				padding: "6px 14px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2, #ddd)",
				background: switchOn ? "#2c5f2c" : "#5f2c2c",
				color: "#fff",
				cursor: "pointer",
				fontSize: 13
			};
			const badge = {
				padding: "2px 10px",
				borderRadius: 999,
				fontSize: 12,
				background: enabled ? "#1d3a1d" : "#3a1d1d",
				color: enabled ? "#6fce6f" : "#ff8f8f"
			};
			return react.createElement("div", { style: { padding: "4px 0" } }, react.createElement("div", { style: {
				fontSize: 13,
				marginBottom: 8
			} }, "🔧 fail-soft：插件错误自动隔离（坏插件被隔离，其余插件照常启动）"), react.createElement("div", { style: row }, react.createElement("span", { style: badge }, enabled ? "✅ 已启用" : "未启用"), react.createElement("span", { style: label }, switchOn ? "开关：开" : "开关：关"), react.createElement("button", {
				onClick: () => void toggle(),
				disabled: saving || !status,
				style: btn
			}, saving ? "…" : switchOn ? "关闭 fail-soft" : "开启 fail-soft")), react.createElement("div", { style: hint }, "开关写入 ~/.dsh/fail-soft.json，内核启动时读取；App / 终端都无需设置环境变量。切换后请重启 dsh 生效。"), message ? react.createElement("div", { style: {
				fontSize: 12,
				marginBottom: 8,
				color: "#8f8fff"
			} }, message) : null, react.createElement("div", { style: hint }, "🧩 内核补丁：" + patchText), quarantined.length > 0 ? react.createElement("div", { style: {
				fontSize: 12,
				color: "#ff8f8f",
				marginTop: 6
			} }, "⛔ 已隔离 " + quarantined.length + " 个插件：" + quarantined.map((q) => q.id).join(", ")) : null);
		}
		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "settings.section",
				id: "dsh-fail-soft",
				label: () => "Fail-soft 隔离",
				inject: () => ({})
			}, () => react.createElement(FailSoftSettingsSection)), "@lanbaolu/dsh-fail-soft: settings section");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map