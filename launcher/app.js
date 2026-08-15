/**
 * MC AI Companion — Launcher 前端逻辑
 *
 * 三个页面共享：
 *   index.html  — 三步配置流程
 *   editor.html — 高级 SOUL 编辑器
 *   dashboard.html — 独立使用，WebSocket 连接
 */

// ══════════════════════════════════════════════════════════════
// 全局状态
// ══════════════════════════════════════════════════════════════

let selectedPreset = null;
let chosenName = "";
let activeSoulYaml = null; // 编辑器产出的自定义 YAML

const PRESET_META = {
  tsundere: { emoji: "🎭", label: "傲娇", personality: "嘴硬心软，毒舌但可靠", preview: "（回头瞥了你一眼）别死了啊笨蛋。" },
  sweet:    { emoji: "🌸", label: "甜妹", personality: "天然积极，阳光感染力", preview: "哇，你好厉害耶！" },
  cold:     { emoji: "❄️", label: "高冷", personality: "话少但句句在点上", preview: "……嗯。" },
  warm:     { emoji: "🔥", label: "暖心", personality: "主动细腻，同理心强", preview: "累了？我帮你。" },
};

// ══════════════════════════════════════════════════════════════
// 步骤管理
// ══════════════════════════════════════════════════════════════

function showStep(n) {
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById(`step-${i}`);
    const stepIndicator = document.querySelector(`.step[data-step="${i}"]`);
    if (panel) panel.classList.toggle("hidden", i !== n);
    if (stepIndicator) {
      stepIndicator.classList.remove("active", "done");
      if (i < n) stepIndicator.classList.add("done");
      if (i === n) stepIndicator.classList.add("active");
    }
  }
}

// ══════════════════════════════════════════════════════════════
// 步骤 1：起名
// ══════════════════════════════════════════════════════════════

const nameInput = document.getElementById("name-input");
const toStep2Btn = document.getElementById("to-step-2");
const nameHint = document.getElementById("name-hint");

if (nameInput) {
  nameInput.addEventListener("input", () => {
    const val = nameInput.value.trim();
    toStep2Btn.disabled = val.length === 0;
    if (val.length > 16) {
      nameHint.textContent = "名字最多 16 个字符（Minecraft 限制）";
      nameInput.value = val.slice(0, 16);
    } else if (val.length > 0 && val.length <= 16) {
      nameHint.textContent = "MC 用户名最多 16 个字符";
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && nameInput.value.trim().length > 0) {
      goToStep2();
    }
  });

  toStep2Btn?.addEventListener("click", goToStep2);
}

function goToStep2() {
  chosenName = nameInput.value.trim();
  if (!chosenName) return;

  // 更新步骤 2 和 3 中的名字
  document.getElementById("show-name").textContent = chosenName;
  document.getElementById("done-name").textContent = chosenName;
  document.getElementById("done-name2").textContent = chosenName;

  // 加载预设卡片（如果还没加载）
  if (!document.querySelector(".preset-card")) {
    loadPresetCards();
  }
  // 如果有自定义 YAML，清除预设选择
  selectedPreset = null;

  showStep(2);
}

// ══════════════════════════════════════════════════════════════
// 步骤 2：人格卡片
// ══════════════════════════════════════════════════════════════

function loadPresetCards() {
  const grid = document.getElementById("preset-grid");
  if (!grid) return;

  grid.innerHTML = Object.entries(PRESET_META).map(([id, meta]) => `
    <div class="preset-card" data-preset="${id}">
      <div class="preset-emoji">${meta.emoji}</div>
      <div class="preset-label">${meta.label}</div>
      <div class="preset-personality">${meta.personality}</div>
      <div class="preset-preview">"${meta.preview}"</div>
    </div>
  `).join("");

  // 点击卡片选中
  grid.querySelectorAll(".preset-card").forEach(card => {
    card.addEventListener("click", () => {
      grid.querySelectorAll(".preset-card").forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedPreset = card.dataset.preset;
      document.getElementById("confirm-persona").disabled = false;

      // 更新完成页预览
      document.getElementById("done-preset").textContent = PRESET_META[selectedPreset].label;
      document.getElementById("done-preview").textContent = `"${PRESET_META[selectedPreset].preview}"`;
    });
  });

  // 编辑器链接带上名字
  const editorLink = document.getElementById("editor-link");
  if (editorLink && chosenName) {
    editorLink.href = `editor.html?name=${encodeURIComponent(chosenName)}`;
  }
}

// 确认人格 → 步骤 3
document.getElementById("confirm-persona")?.addEventListener("click", () => {
  if (!selectedPreset) return;
  activeSoulYaml = null; // 使用预设，不是自定义
  showStep(3);
});

// 返回步骤 1
document.getElementById("back-to-1")?.addEventListener("click", () => {
  showStep(1);
});

// ══════════════════════════════════════════════════════════════
// 步骤 3：完成 & 启动
// ══════════════════════════════════════════════════════════════

document.getElementById("start-bot")?.addEventListener("click", () => {
  document.getElementById("mc-config-modal").classList.remove("hidden");
});

document.getElementById("cancel-start")?.addEventListener("click", () => {
  document.getElementById("mc-config-modal").classList.add("hidden");
});

document.getElementById("reconfigure")?.addEventListener("click", () => {
  showStep(1);
});

document.getElementById("confirm-start")?.addEventListener("click", async () => {
  const modal = document.getElementById("mc-config-modal");
  const status = document.getElementById("start-status");

  const mcHost = document.getElementById("mc-host").value || "localhost";
  const mcPort = parseInt(document.getElementById("mc-port").value) || 25565;
  const llmKey = document.getElementById("llm-key").value || "";

  // 1. 保存配置
  status.textContent = "正在保存配置…";
  status.style.color = "";

  let soulYaml = null;
  if (activeSoulYaml) {
    soulYaml = activeSoulYaml;
  }

  try {
    const res = await fetch("/api/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: chosenName,
        preset: activeSoulYaml ? null : selectedPreset,
        soulYaml: activeSoulYaml,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
  } catch (err) {
    status.textContent = `配置失败: ${err.message}`;
    status.style.color = "var(--danger)";
    return;
  }

  // 2. 启动 bot
  status.textContent = "正在连接 MC 服务器…";
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mcHost,
        mcPort,
        llmApiKey: llmKey,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    status.textContent = "✅ Bot 已启动！打开 Minecraft 和他说话吧。";
    status.style.color = "var(--success)";
    modal.classList.add("hidden");
  } catch (err) {
    status.textContent = `连接失败: ${err.message}`;
    status.style.color = "var(--danger)";
  }
});

// ─── 从编辑器返回时恢复状态 ───────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const configured = urlParams.get("configured");
const editorName = urlParams.get("name");
if (configured === "1" && editorName) {
  // 编辑器已保存配置，直接跳到步骤 3（完成页）
  chosenName = editorName;
  fetch("/api/config").then(r => r.json()).then(data => {
    if (data.config) {
      activeSoulYaml = null; // 服务器已保存
      document.getElementById("done-name").textContent = chosenName;
      document.getElementById("done-name2").textContent = chosenName;
      document.getElementById("done-preset").textContent = "自定义";
      document.getElementById("done-preview").textContent = "（自定义人格）";
      showStep(3);
    }
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// 编辑器页逻辑
// ══════════════════════════════════════════════════════════════

const presetSelect = document.getElementById("preset-select");
const yamlEditor = document.getElementById("yaml-editor");
const editorStatus = document.getElementById("editor-status");

// 从 URL 获取名字
const editName = urlParams.get("name") || "未命名";

// 加载预设到编辑器
document.getElementById("load-preset")?.addEventListener("click", async () => {
  const preset = presetSelect.value;
  if (!preset) { editorStatus.textContent = "请先选择预设"; return; }

  try {
    const res = await fetch(`/api/soul?preset=${preset}`);
    const data = await res.json();
    if (data.soul) {
      yamlEditor.value = data.soul.replace(/\{\{NAME\}\}/g, editName);
      editorStatus.textContent = `已加载「${PRESET_META[preset]?.label ?? preset}」预设`;
      editorStatus.style.color = "var(--success)";
    }
  } catch (err) {
    editorStatus.textContent = `加载失败: ${err.message}`;
    editorStatus.style.color = "var(--danger)";
  }
});

// 保存并返回（POST 到服务器保存，避免 URL 超长）
document.getElementById("save-soul")?.addEventListener("click", async () => {
  const yaml = yamlEditor.value.trim();
  if (!yaml) {
    editorStatus.textContent = "YAML 不能为空";
    editorStatus.style.color = "var(--danger)";
    return;
  }
  try {
    const res = await fetch("/api/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, preset: null, soulYaml: yaml }),
    });
    if (res.ok) {
      window.location.href = `index.html?configured=1&name=${encodeURIComponent(editName)}`;
    } else {
      const err = await res.json();
      editorStatus.textContent = `保存失败: ${err.error}`;
      editorStatus.style.color = "var(--danger)";
    }
  } catch (err) {
    editorStatus.textContent = `保存失败: ${err.message}`;
    editorStatus.style.color = "var(--danger)";
  }
});

// 导出 YAML 文件
document.getElementById("export-yaml")?.addEventListener("click", () => {
  const yaml = yamlEditor.value.trim();
  if (!yaml) {
    editorStatus.textContent = "YAML 不能为空";
    editorStatus.style.color = "var(--danger)";
    return;
  }
  const blob = new Blob([yaml], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${editName}_SOUL.yaml`;
  a.click();
  URL.revokeObjectURL(url);
  editorStatus.textContent = "已导出 YAML 文件";
  editorStatus.style.color = "var(--success)";
});
