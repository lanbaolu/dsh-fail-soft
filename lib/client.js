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
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/client/index.ts
		/**
		* @lanbaolu/dsh-fail-soft — client 设置面板（settings.section slot）。
		*
		* 在 DSH 设置面板注册「Fail-soft 隔离」区域，使用官方
		* @deepseek-ai/dsh-client-ui-primitives（Button / Pill / StateDot）保持与
		* DSH 主题一致：
		* - 状态卡（fail-soft 是否生效 + 内核补丁健康）；
		* - 一键开关（写 ~/.dsh/fail-soft.json，重启后生效）；
		* - 被隔离插件提示。
		*
		* 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader 包装）。
		*/
		const inject = ["slots"];
		const cardStyle = {
			background: "var(--dsw-alias-surface-2, #fafafa)",
			border: "1px solid var(--dsw-alias-border-l2, #e6e6e6)",
			borderRadius: 10,
			padding: "12px 14px",
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			fontSize: 13,
			color: "var(--dsw-alias-label-secondary, #555)"
		};
		const hintStyle = {
			fontSize: 12,
			color: "var(--dsw-alias-label-tertiary, #999)",
			lineHeight: 1.5
		};
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
			const patchOk = patch.status === "ok" || patch.status === "repaired";
			const patchText = patch.status === "ok" ? "正常" : patch.status === "checking" ? "检测中…" : patch.status === "repaired" ? "已自动重打（重启后生效）" : patch.status === "needs-adaptation" || patch.status === "failed" || patch.status === "no-install" ? "需适配" : String(patch.status ?? "?");
			return react.createElement("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 12
			} }, react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 10
			} }, react.createElement("span", { style: {
				fontSize: 15,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary, #111)"
			} }, "🔧 Fail-soft 隔离"), react.createElement(_deepseek_ai_dsh_client_ui_primitives.Pill, { active: switchOn }, switchOn ? "开关：开" : "开关：关")), react.createElement("div", { style: cardStyle }, react.createElement("div", { style: rowStyle }, react.createElement(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: enabled ? "done" : "error" }), react.createElement("span", null, enabled ? "fail-soft 已启用（坏插件会被自动隔离，服务照常启动）" : "fail-soft 未启用（坏插件可能导致整个服务起不来）")), react.createElement("div", { style: rowStyle }, react.createElement(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: patchOk ? "done" : "warning" }), react.createElement("span", null, "内核补丁：" + patchText)), quarantined.length > 0 ? react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				fontSize: 13,
				color: "#ff6b6b",
				fontWeight: 600
			} }, react.createElement(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" }), react.createElement("span", null, `已隔离 ${quarantined.length} 个插件：${quarantined.map((q) => q.id).join("、")}`)) : null), react.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8
			} }, react.createElement(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: switchOn ? "outline" : "primary",
				size: "md",
				onClick: () => void toggle(),
				disabled: saving || !status
			}, saving ? "处理中…" : switchOn ? "关闭 fail-soft" : "开启 fail-soft")), react.createElement("div", { style: hintStyle }, "开关写入 ~/.dsh/fail-soft.json，内核启动时读取；App / 终端都无需设置环境变量。切换后请重启 dsh 生效。"), message ? react.createElement("div", { style: {
				fontSize: 12,
				color: "#8f8fff"
			} }, message) : null);
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