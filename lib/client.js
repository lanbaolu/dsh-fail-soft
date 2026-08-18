window.__ModuleLoader__.load({
	id: "@lanbaolu/dsh-fail-soft",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		const inject = ["slots"];
		function el(tag, text, className) {
			const node = document.createElement(tag);
			if (text !== void 0) node.textContent = text;
			if (className) node.className = className;
			return node;
		}
		function renderPanel() {
			const root = el("div", void 0, "dsh-fail-soft-panel");
			root.style.cssText = "padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6;";
			const title = el("div", "🔧 @lanbaolu/dsh-fail-soft — 插件错误隔离", void 0);
			title.style.cssText = "font-weight:700;margin-bottom:8px;";
			root.appendChild(title);
			const statusLine = el("div", "状态：读取中…", void 0);
			statusLine.style.cssText = "margin-bottom:10px;color:#888;";
			root.appendChild(statusLine);
			const patchLine = el("div", "", void 0);
			patchLine.style.cssText = "margin-bottom:10px;color:#888;font-size:12px;";
			root.appendChild(patchLine);
			const listBox = el("div", void 0, void 0);
			listBox.style.cssText = "display:flex;flex-direction:column;gap:6px;";
			root.appendChild(listBox);
			async function refresh() {
				try {
					const status = await (await fetch("/api/fail-soft/status")).json();
					const p = status.patch ?? {};
					if (p.status === "ok") {
						patchLine.textContent = `🧩 内核补丁：正常（DSH ${p.version ?? "?"}）`;
						patchLine.style.color = "#4a9a4a";
					} else if (p.status === "checking") {
						patchLine.textContent = "🧩 内核补丁：检测中…";
						patchLine.style.color = "#888";
					} else if (p.status === "repaired") {
						patchLine.textContent = `🧩 内核补丁：已自动重打（${(p.applied ?? []).join(", ")}）——重启后生效`;
						patchLine.style.color = "#d0a030";
					} else if (p.status === "needs-adaptation" || p.status === "failed" || p.status === "no-install") {
						patchLine.textContent = `🧩 内核补丁：⚠️ 需要适配（${p.error ?? p.status}）`;
						patchLine.style.color = "#ff6b6b";
					} else patchLine.textContent = `🧩 内核补丁：${p.status}`;
					const damaged = (status.quarantined ?? []).length;
					if (damaged > 0) {
						statusLine.textContent = `⚠️ 有 ${damaged} 个插件已损坏，已被自动隔离（其余插件不受影响）`;
						statusLine.style.cssText = "margin-bottom:10px;color:#ff6b6b;font-weight:700;background:#2a1518;border:1px solid #7a2a2a;border-radius:6px;padding:8px 10px;";
						title.textContent = `🔧 @lanbaolu/dsh-fail-soft — ⚠️ ${damaged} 个插件已损坏`;
						title.style.color = "#ff6b6b";
					} else {
						statusLine.textContent = `状态：${status.enabled ? "✅ fail-soft 已启用" : "⚠️ 未启用（启动时设置 DSH_FAIL_SOFT=1）"} ｜ 无损坏插件`;
						statusLine.style.cssText = "margin-bottom:10px;color:#888;";
						title.textContent = "🔧 @lanbaolu/dsh-fail-soft — 插件错误隔离";
						title.style.color = "";
					}
					listBox.replaceChildren();
					if (damaged === 0) {
						listBox.appendChild(el("div", "（没有被隔离的插件）", void 0));
						return;
					}
					for (const item of status.quarantined) {
						const row = el("div", void 0, void 0);
						row.style.cssText = "display:flex;align-items:center;gap:8px;background:#2a1518;border:1px solid #7a2a2a;border-radius:6px;padding:6px 10px;";
						const info = el("span", `⛔ ${item.id}（已损坏，已隔离）`, void 0);
						info.style.cssText = "font-weight:600;color:#ff6b6b;flex:1;";
						row.appendChild(info);
						if (item.reason) {
							const reason = el("span", (item.reason || "").slice(0, 90), void 0);
							reason.style.cssText = "color:#999;font-size:12px;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
							row.appendChild(reason);
						}
						const btn = el("button", "恢复", void 0);
						btn.style.cssText = "background:#2c5f2c;color:#fff;border:none;border-radius:4px;padding:3px 10px;cursor:pointer;";
						btn.addEventListener("click", async () => {
							btn.disabled = true;
							btn.textContent = "…";
							try {
								const result = await (await fetch("/api/fail-soft/restore", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ id: item.id })
								})).json();
								if (result.ok) btn.textContent = "✅ 已恢复（重启后重新装配）";
								else {
									btn.textContent = "❌ " + (result.error || "失败");
									btn.disabled = false;
								}
							} catch {
								btn.textContent = "❌ 请求失败";
								btn.disabled = false;
							}
							await new Promise((resolve) => setTimeout(resolve, 1200));
							refresh();
						});
						row.appendChild(btn);
						listBox.appendChild(row);
					}
				} catch {
					statusLine.textContent = "状态：无法连接 host API（/api/fail-soft）";
					statusLine.style.color = "#c03030";
				}
			}
			refresh();
			const timer = setInterval(() => void refresh(), 15e3);
			root.addEventListener("disconnected", () => clearInterval(timer));
			return root;
		}
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "dsh-fail-soft-panel",
				label: () => "@lanbaolu/dsh-fail-soft",
				component: () => ({ render: renderPanel })
			})), "@lanbaolu/dsh-fail-soft: panel");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map