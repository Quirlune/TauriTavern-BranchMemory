import { escapeHtml } from './core.js';

const choices = (options, current) => options.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('');
const roles = [['original', '保持原角色'], ['system', 'system'], ['user', 'user'], ['assistant', 'assistant']];
const sources = ['system', 'user', 'assistant', 'example_user', 'example_assistant'];
const field = (label, path, value) => `<label>${label}<input class="text_pole" data-setting="promptControl.${path}" value="${escapeHtml(value)}"></label>`;
const check = (label, path, value) => `<label class="ttbm-check"><input type="checkbox" data-setting="promptControl.${path}" ${value ? 'checked' : ''}>${label}</label>`;

export function promptControlHtml(config) {
    return `<section class="ttbm-section">
        <h3>处理范围与合并</h3>
        <p class="ttbm-hint">默认对正文使用所提供 mergeEditor 脚本的提示词格式。启用后请停用 JsRunner 中原来的 mergeEditor 脚本，避免重复处理。这里的规则在请求中生效，不改聊天记录。</p>
        <div class="ttbm-grid">${check('启用提示词控制', 'enabled', config.enabled)}
            ${[['body','正文'],['memory','总结'],['status','状态栏'],['image','图片规划']].map(([key,label]) => check(label, `scopes.${key}`, config.scopes[key])).join('')}</div>
        <div class="ttbm-grid">
            <label>处理方式<select class="text_pole" data-setting="promptControl.mode">${choices([['legacy','mergeEditor 兼容'],['roles','直接调整 API 角色']],config.mode)}</select></label>
            <label>合并方式<select class="text_pole" data-setting="promptControl.merge">${choices([['all','合并整块'],['adjacent','仅相邻同角色'],['none','不合并消息']],config.merge)}</select></label>
            <label>整块归属<select class="text_pole" data-setting="promptControl.mergedRole">${choices(roles.slice(1),config.mergedRole)}</select></label>
        </div>
    </section>
    <section class="ttbm-section"><h3>归属与角色标签</h3>
        <p class="ttbm-hint">先匹配下面的条目规则，再应用默认归属。兼容模式将角色转成文本标签，整块作为所选 API 角色发送；直接调整模式保留消息结构。</p>
        <div class="ttbm-role-table">${sources.map(role => `<div class="ttbm-grid"><strong>${role}</strong>
            <label>归于<select class="text_pole" data-setting="promptControl.roles.${role}">${choices(roles, config.roles[role])}</select></label>
            ${field('兼容文本标签', `prefixes.${role}`, config.prefixes[role])}</div>`).join('')}</div>
        <details class="ttbm-help" data-view-key="control/separators"><summary>兼容模式的分隔符与拼接</summary>
        <div class="ttbm-grid">${field('消息分隔符（兼容模式可填 \\n）','separator',config.separator)}${field('系统提示词分界文本','separator_system',config.separator_system)}</div>
        ${check('兼容脚本：最后拼接连续 user 消息','mergeUsers',config.mergeUsers)}
        </details>
    </section>
    <section class="ttbm-section"><h3>阻止处理的标记</h3>
        <p class="ttbm-hint">在提示词条目中加入任意一行标记，该消息保留原归属，并隔开前后合并块。默认兼容 &lt;|no-trans|&gt;。工具调用、多模态消息和额外协议字段自动保留。</p>
        <label>保护标记（每行一个）<textarea class="text_pole" rows="3" data-setting="promptControl.protectedMarkers">${escapeHtml(config.protectedMarkers)}</textarea></label>
        ${check('发送前移除保护标记','removeMarkers',config.removeMarkers)}
        <details class="ttbm-help" data-view-key="control/markers"><summary>兼容脚本标记说明</summary><p class="ttbm-hint">支持 &lt;|Merge Disable|&gt;、&lt;|Merge System Disable|&gt;、&lt;|Merge Human Disable|&gt;、&lt;|Merge Assistant Disable|&gt;、&lt;|join|&gt;、&lt;|space|&gt;、&lt;|curtail|&gt;、&lt;@N&gt;…&lt;/@N&gt; 与分阶段 &lt;regex&gt; 替换。数据捕获和存储标签功能不在本页范围内。</p></details>
    </section>
    <section class="ttbm-section"><div class="ttbm-section-head"><h3>条目规则（从上到下，首个匹配生效）</h3><button class="menu_button" type="button" data-add-control-rule>新增归属规则</button></div>
        <p class="ttbm-hint">“包含文本”是普通文本匹配。留空表示匹配该来源的全部条目；选择“保护”可阻止归属和合并处理。</p>
        ${config.rules.map((rule,index) => `<article class="ttbm-card" data-list-path="promptControl.rules" data-index="${index}">
            <div class="ttbm-grid"><label>原归属<select class="text_pole" data-control-field="source">${choices([['*','任意'],...sources.map(role=>[role,role])],rule.source)}</select></label>
            <label>包含文本<input class="text_pole" data-control-field="contains" value="${escapeHtml(rule.contains)}"></label>
            <label>归于<select class="text_pole" data-control-field="target">${choices([['keep','保护（阻止处理）'],...roles],rule.target)}</select></label>
            <label class="ttbm-check"><input type="checkbox" data-control-field="enabled" ${rule.enabled !== false ? 'checked' : ''}>启用</label></div>
            <div class="ttbm-card-actions"><button class="menu_button ttbm-move-up" type="button">上移</button><button class="menu_button ttbm-move-down" type="button">下移</button><button class="menu_button ttbm-remove-entry" type="button">删除</button></div>
        </article>`).join('') || '<p class="ttbm-empty">暂无条目规则，当前使用上方的默认归属。</p>'}
    </section>
    <details class="ttbm-section ttbm-disclosure" data-view-key="control/preview"><summary><span><strong>试处理与兼容配置</strong><small>预览转换结果，或导入原脚本的格式设置</small></span></summary><div class="ttbm-disclosure-body">
        <p class="ttbm-hint">贴入 messages JSON 数组可查看处理结果。导入接受原脚本的配置 JSON（user、assistant 等字段），只导入提示词格式设置。</p>
        <label>messages 数组 / 脚本配置 JSON<textarea id="ttbm-control-input" class="text_pole" rows="5" placeholder='[{"role":"user","content":"你好"}]'></textarea></label>
        <div class="ttbm-card-actions"><button class="menu_button" type="button" data-control-action="preview">试处理正文</button><button class="menu_button" type="button" data-control-action="import">导入脚本配置 JSON</button></div>
        <pre id="ttbm-control-output" class="ttbm-prompt-text" aria-live="polite"></pre>
    </div></details>`;
}
