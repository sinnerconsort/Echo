/**
 * Echo v3 — Persona Impersonation Engine
 * Per-reply generation (each option gets its own API call).
 * Lexicon world context + Codex character state integration.
 * Two-layer persistence: persona profiles (global) + per-chat context.
 */
import {
    getContext,
    extension_settings
} from '../../../extensions.js';

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    generateRaw,
    saveChatDebounced
} from '../../../../script.js';

const extensionName = 'Echo';
const EXT_VERSION = '3.0.0';

// ═══════════════════════════════════════
//  PROFILE TEMPLATE
// ═══════════════════════════════════════

function newProfile(name) {
    return {
        id: 'echo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'New Persona',
        persona_name: name || '',
        persona_age: '', persona_description: '', persona_appearance: '',
        persona_personality: '', persona_history: '',
        persona_mannerisms: '', persona_quirks: '', persona_speech_patterns: '',
        persona_dialogue: []
    };
}

// ═══════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════

const defaultSettings = {
    enabled: true,
    selectedProfile: 'current',
    replyCount: 3,
    replyLength: 2,
    contextDepth: 6,
    useLexicon: true,
    useCodex: true,
    activeProfileId: null,
    profiles: []
};

let extensionSettings = {};
let isGenerating = false;
let currentTab = 'reply';
let sessionMoodTags = [];
let chatContext = { relationship: '', last_session: '' };

function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings[extensionName]) context.extensionSettings[extensionName] = { ...defaultSettings };
    extensionSettings = context.extensionSettings[extensionName];
    for (const [key, val] of Object.entries(defaultSettings)) {
        if (extensionSettings[key] === undefined) extensionSettings[key] = val;
    }
    if (!Array.isArray(extensionSettings.profiles)) extensionSettings.profiles = [];
    migrateOldData();
    if (extensionSettings.profiles.length === 0) {
        const p = newProfile('Default');
        extensionSettings.profiles.push(p);
        extensionSettings.activeProfileId = p.id;
        saveSettings();
    }
    if (!getActiveProfile()) extensionSettings.activeProfileId = extensionSettings.profiles[0]?.id || null;
}

function migrateOldData() {
    if (extensionSettings.persona_name || extensionSettings.persona_description) {
        const p = newProfile(extensionSettings.persona_name || 'Migrated Persona');
        const fields = ['persona_name','persona_age','persona_description','persona_appearance','persona_personality','persona_history','persona_mannerisms','persona_quirks','persona_speech_patterns','persona_dialogue'];
        for (const f of fields) { if (extensionSettings[f] !== undefined) { p[f] = extensionSettings[f]; delete extensionSettings[f]; } }
        if (!Array.isArray(p.persona_dialogue)) p.persona_dialogue = [];
        extensionSettings.profiles.push(p);
        extensionSettings.activeProfileId = p.id;
        delete extensionSettings.mood_tags; delete extensionSettings.mood_context; delete extensionSettings.custom_prompt;
    }
}

function saveSettings() { const ctx = getContext(); ctx.extensionSettings[extensionName] = extensionSettings; saveSettingsDebounced(); }
function getActiveProfile() { return extensionSettings.profiles?.find(p => p.id === extensionSettings.activeProfileId) || null; }
function setActiveProfile(id) { extensionSettings.activeProfileId = id; saveSettings(); refreshIdentityTab(); refreshVoiceTab(); refreshDialogueTab(); refreshProfileDropdown(); }

function loadChatContext() {
    const meta = getContext().chat_metadata;
    chatContext.relationship = meta?.echo?.relationship || '';
    chatContext.last_session = meta?.echo?.last_session || '';
    $('#echo-chat-relationship').val(chatContext.relationship);
    $('#echo-chat-lastsession').val(chatContext.last_session);
}

function saveChatContext() {
    const ctx = getContext();
    if (!ctx.chat_metadata) return;
    ctx.chat_metadata.echo = { relationship: chatContext.relationship, last_session: chatContext.last_session };
    saveChatDebounced();
}

// ═══════════════════════════════════════
//  AI COMMUNICATION
// ═══════════════════════════════════════

async function callAI(prompt, maxTokens = 1500) {
    const ctx = getContext();
    if (ctx?.ConnectionManagerRequestService && extensionSettings.selectedProfile !== 'fallback') {
        const profileId = getConnectionProfileId(extensionSettings.selectedProfile);
        if (profileId) {
            try {
                const response = await ctx.ConnectionManagerRequestService.sendRequest(
                    profileId, [{ role: 'user', content: prompt }], maxTokens,
                    { extractData: true, includePreset: true, includeInstruct: false }, {}
                );
                if (response?.content) return response.content;
            } catch (err) { console.warn('[Echo] CMRS failed:', err.message); }
        }
    }
    return await generateRaw(prompt, null, false, false, '', maxTokens);
}

function getConnectionProfileId(profileName) {
    const cm = getContext().extensionSettings?.connectionManager;
    if (!cm) return null;
    if (profileName === 'current') return cm.selectedProfile;
    return cm.profiles?.find(p => p.name === profileName)?.id || null;
}

// ═══════════════════════════════════════
//  CONTEXT EXTRACTION
// ═══════════════════════════════════════

function getRecentChat() {
    const context = getContext();
    if (!context.chat?.length) return null;
    const depth = Math.max(2, Math.min(20, extensionSettings.contextDepth || 6));
    const recent = context.chat.slice(-depth);
    const messages = recent.map(msg => {
        let text = msg.mes || '';
        text = text.replace(/<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
        text = text.replace(/<[^>]*>/g, '').trim();
        return `${msg.name}: ${text.substring(0, 3000)}`;
    }).join('\n\n');
    return { messages, charName: context.name2 || 'Character', userName: context.name1 || 'User', messageCount: recent.length };
}

// ═══════════════════════════════════════
//  PERSONA & CONTEXT BLOCKS
// ═══════════════════════════════════════

function buildPersonaBlock() {
    const p = getActiveProfile();
    if (!p) return '';
    let block = '';
    if (p.persona_name) block += `Name: ${p.persona_name}\n`;
    if (p.persona_age) block += `Age: ${p.persona_age}\n`;
    if (p.persona_description) block += `Description: ${p.persona_description}\n`;
    if (p.persona_appearance) block += `Appearance: ${p.persona_appearance}\n`;
    if (p.persona_personality) block += `Personality: ${p.persona_personality}\n`;
    if (p.persona_history) block += `Background: ${p.persona_history}\n`;
    if (p.persona_mannerisms) block += `Mannerisms: ${p.persona_mannerisms}\n`;
    if (p.persona_quirks) block += `Quirks: ${p.persona_quirks}\n`;
    if (p.persona_speech_patterns) block += `Speech patterns: ${p.persona_speech_patterns}\n`;
    if (p.persona_dialogue?.length > 0) {
        block += `\nDialogue reference (TONAL — don't copy verbatim):\n`;
        for (const d of p.persona_dialogue) {
            if (d.situation && d.example) block += `  When ${d.situation}: "${d.example}"\n`;
        }
    }
    return block.trim();
}

function buildChatContextBlock() {
    const rel = chatContext.relationship || ($('#echo-chat-relationship').val() || '').trim();
    const last = chatContext.last_session || ($('#echo-chat-lastsession').val() || '').trim();
    let block = '';
    if (rel) block += `Relationship with this character: ${rel}\n`;
    if (last) block += `Where things left off: ${last}\n`;
    return block ? `\nCHAT-SPECIFIC CONTEXT:\n${block}` : '';
}

function buildMoodBlock() {
    const tags = sessionMoodTags;
    const moodContext = ($('#echo-mood-context').val() || '').trim();
    if (!tags.length && !moodContext) return '';
    let block = '\nCURRENT EMOTIONAL STATE:\n';
    if (tags.length > 0) block += `Mood: ${tags.join(', ')}\n`;
    if (moodContext) block += `Internal context: ${moodContext}\n`;
    return block;
}

function buildCustomBlock() {
    const custom = ($('#echo-custom-prompt').val() || '').trim();
    return custom ? `\nADDITIONAL DIRECTION:\n${custom}\n` : '';
}

// ═══════════════════════════════════════
//  LEXICON / CODEX INTEGRATION
// ═══════════════════════════════════════

async function buildLexiconBlock() {
    if (!extensionSettings.useLexicon || !window.LexiconAPI?.isActive?.()) return '';
    try {
        const block = await window.LexiconAPI.getLoreContextBlock(6);
        return block?.trim() ? `\nWORLD CONTEXT (ground your reply in established lore):\n${block}\n` : '';
    } catch { return ''; }
}

async function buildCodexBlock(charName) {
    if (!extensionSettings.useCodex || !window.CodexAPI?.isActive?.()) return '';
    try {
        // Get the character state for the NPC we're talking to
        const charState = await window.CodexAPI.getCharacterState(charName);
        if (!charState?.directive) return '';

        let block = `\nCHARACTER INTELLIGENCE — ${charName}:\n`;
        block += `Current state: ${charState.directive}\n`;
        if (charState.currentMood) block += `Their mood: ${charState.currentMood}\n`;
        if (charState.activeGoal) block += `Their goal: ${charState.activeGoal}\n`;
        if (charState.hiding && charState.hiding !== 'nothing') block += `They're hiding: ${charState.hiding}\n`;

        // Get relationship from NPC's perspective toward the persona
        const profile = getActiveProfile();
        if (profile?.persona_name) {
            const rel = await window.CodexAPI.getRelationship(charName, profile.persona_name);
            if (rel?.stance) block += `How they see ${profile.persona_name}: ${rel.stance} (tension ${rel.tension}/10)\n`;
        }

        block += `Use this to inform how you react to ${charName} — if they're guarded, you might notice tension. If they're hiding something, you might sense unease.\n`;
        return block;
    } catch { return ''; }
}

// ═══════════════════════════════════════
//  REPLY GENERATION — PER-REPLY CALLS
// ═══════════════════════════════════════

const REPLY_ANGLES = [
    'Take the most natural, in-character approach. This is the default response.',
    'Take a more emotionally vulnerable or introspective angle. Show internal conflict or deeper feeling.',
    'Take a bolder, more assertive or confrontational angle. Push back or take initiative.',
    'Take an unexpected or deflecting angle — humor, avoidance, changing the subject, or a surprising reaction.',
    'Take a cautious, guarded approach. Hold back, test the waters, reveal less.',
];

async function generateReplies() {
    if (isGenerating) return;

    const chat = getRecentChat();
    if (!chat) { toastr.warning('No chat history — start a conversation first', 'Echo'); return; }

    chatContext.relationship = $('#echo-chat-relationship').val() || '';
    chatContext.last_session = $('#echo-chat-lastsession').val() || '';
    saveChatContext();

    const count = Math.max(2, Math.min(5, extensionSettings.replyCount || 3));
    const personaBlock = buildPersonaBlock();
    const profile = getActiveProfile();
    const personaName = profile?.persona_name || chat.userName;
    const chatContextBlock = buildChatContextBlock();
    const moodBlock = buildMoodBlock();
    const customBlock = buildCustomBlock();
    const lexiconBlock = await buildLexiconBlock();
    const codexBlock = await buildCodexBlock(chat.charName);

    const lengthLabels = {
        1: 'Keep replies SHORT — 1-2 sentences max. Punchy and concise.',
        2: 'Write MEDIUM length replies — 1-2 short paragraphs.',
        3: 'Write LONGER replies — 2-3 paragraphs with detail.',
        4: 'Write DETAILED replies — 3-4 paragraphs with rich description, internal thoughts, and actions.'
    };
    const lengthInstruction = lengthLabels[extensionSettings.replyLength || 2];

    // Token budget per reply scales with length setting
    const tokenBudgets = { 1: 400, 2: 800, 3: 1200, 4: 1800 };
    const maxTokens = tokenBudgets[extensionSettings.replyLength || 2];

    isGenerating = true;
    showProgressState(0, count);

    const replies = [];

    for (let i = 0; i < count; i++) {
        const angle = REPLY_ANGLES[i] || REPLY_ANGLES[0];

        const prompt = `You are ghostwriting a roleplay reply AS a specific persona character. You are NOT the AI — you ARE ${personaName}.

RULES:
- Write ONLY as ${personaName}, from their perspective, in their voice.
- Stay consistent with their personality, speech patterns, and mannerisms.
- React to what ${chat.charName} said/did in the most recent message.
- Include actions, thoughts, and dialogue as appropriate.
- ${lengthInstruction}
- Do NOT include any meta-commentary, option labels, thinking, reasoning, or preamble.
- Start directly with the reply — no "Option 1:" or "Here's a reply:" or similar.

PERSONA:
${personaBlock || `Name: ${personaName}\n(No detailed persona provided — write naturally)`}
${chatContextBlock}${moodBlock}${customBlock}${lexiconBlock}${codexBlock}
RECENT CONVERSATION:
${chat.messages}

ANGLE FOR THIS REPLY: ${angle}

Write ONE reply as ${personaName}. Output ONLY the in-character reply text.`;

        try {
            let response = await callAI(prompt, maxTokens);
            response = cleanReply(response);
            if (response && response.length > 15) {
                replies.push(response);
            }
        } catch (err) {
            console.warn(`[Echo] Reply ${i + 1} generation failed:`, err);
        }

        showProgressState(i + 1, count);
    }

    isGenerating = false;

    if (replies.length === 0) {
        showErrorState('No replies generated — check your API connection');
    } else {
        showResults(replies);
    }
}

/**
 * Aggressively clean AI output: strip thinking tags, meta-labels, preamble.
 */
function cleanReply(text) {
    if (!text) return '';
    let cleaned = text;

    // Strip thinking/reasoning blocks (various tag names)
    cleaned = cleaned.replace(/<(thought|think|thinking|reasoning|reflection|inner_monologue|analysis)>[\s\S]*?<\/\1>/gi, '');

    // Strip any remaining XML-like tags
    cleaned = cleaned.replace(/<\/?[a-z_]+>/gi, '');

    // Strip option/reply labels at the start
    cleaned = cleaned.replace(/^\s*(?:Option|Reply|Response|Version|Approach)\s*\d+[:\.\)\-]\s*/i, '');
    cleaned = cleaned.replace(/^\s*---\s*(?:REPLY|OPTION)\s*\d+\s*---\s*/i, '');
    cleaned = cleaned.replace(/^\s*\*\*(?:Option|Reply)\s*\d+\*\*[:\s]*/i, '');

    // Strip "Here's a reply" / "Here is my response" style preamble
    cleaned = cleaned.replace(/^\s*(?:Here(?:'s| is) (?:a|my|the) (?:reply|response|answer)[:\.\!]?\s*)/i, '');
    cleaned = cleaned.replace(/^\s*(?:Sure[,!]?\s*(?:here(?:'s| is))?[:\s]*)/i, '');

    // Strip Paramnesia/preset bleed — Final Review, QC checks, Director meta
    cleaned = cleaned.replace(/\n?\s*(?:Final Review|Quality Check|Review against|Compliance check|Director Note|DIRECTOR NOTE|HECKLE)[\s\S]*/si, '');
    cleaned = cleaned.replace(/\n?\s*\[(?:PLANT|FIRED|DIRECTOR NOTE|HECKLE)[:\s][^\]]*\]\s*/gi, '');

    // Strip lines that are clearly meta/evaluation (start with * and read like notes)
    cleaned = cleaned.replace(/\n\s*\*\s*(?:The |This |Note:|Check:|Ensure|Connection|Review)[\s\S]*/si, '');

    // Strip trailing meta-comments
    cleaned = cleaned.replace(/\n\s*(?:\*?\*?Note\*?\*?|---|\[End\]|This reply|T\+\d).*/si, '');

    // Strip any remaining content that's clearly not prose (bullet lists of rules/checks)
    cleaned = cleaned.replace(/\n\s*[-•]\s*(?:Avoid|Ensure|Check|Verify|Remember|Rule|Must|Should|Don't).*$/gim, '');

    return cleaned.trim();
}

// ═══════════════════════════════════════
//  UI — RESULTS
// ═══════════════════════════════════════

function showResults(replies) {
    const container = $('#echo-results');
    container.empty();

    if (replies.length === 0) {
        container.html('<div class="echo-status"><i class="fa-solid fa-comment-dots"></i><span>Generate replies to see options here</span></div>');
        return;
    }

    replies.forEach((text, i) => {
        const preview = text.substring(0, 60).replace(/\n/g, ' ');
        const card = $(`
            <div class="echo-reply-card" data-index="${i}">
                <div class="echo-reply-label">OPTION ${i + 1}</div>
                <div class="echo-reply-preview">${escapeHtml(preview)}${text.length > 60 ? '…' : ''}</div>
                <div class="echo-reply-text" style="display:none;">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
                <div class="echo-reply-actions">
                    <button class="echo-use menu_button menu_button_icon" title="Use this reply"><i class="fa-solid fa-check"></i> Use</button>
                    <button class="echo-copy menu_button menu_button_icon" title="Copy"><i class="fa-solid fa-copy"></i></button>
                </div>
            </div>
        `);

        // Toggle expand on card click
        card.on('click', function (e) {
            if ($(e.target).closest('.echo-use, .echo-copy').length) return;
            $(this).find('.echo-reply-preview').toggle();
            $(this).find('.echo-reply-text').toggle();
        });

        card.find('.echo-use').on('click', (e) => { e.stopPropagation(); pasteToInput(text); });
        card.find('.echo-copy').on('click', (e) => { e.stopPropagation(); copyToClipboard(text); });
        container.append(card);
    });
}

function showProgressState(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const label = current >= total ? 'Finishing up...' : `Writing reply ${current + 1} of ${total}...`;
    $('#echo-results').html(`
        <div class="echo-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>${label}</span>
            <div class="echo-progress-bar"><div class="echo-progress-fill" style="width:${pct}%"></div></div>
        </div>
    `);
}

function showErrorState(message) {
    $('#echo-results').html(`<div class="echo-status echo-error"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(message)}</span></div>`);
}

// ═══════════════════════════════════════
//  UI — MOOD TAGS
// ═══════════════════════════════════════

function renderMoodTags() {
    const container = $('#echo-mood-tags');
    container.empty();
    sessionMoodTags.forEach((tag, i) => {
        const pill = $(`<span class="echo-mood-pill">${escapeHtml(tag)}<i class="fa-solid fa-xmark echo-mood-remove" data-index="${i}"></i></span>`);
        pill.find('.echo-mood-remove').on('click', function () { sessionMoodTags.splice(i, 1); renderMoodTags(); });
        container.append(pill);
    });
}

function addMoodTag(tag) {
    const clean = tag.trim().toLowerCase();
    if (!clean || sessionMoodTags.includes(clean)) return;
    if (sessionMoodTags.length >= 8) { toastr.warning('Maximum 8 mood tags', 'Echo'); return; }
    sessionMoodTags.push(clean);
    renderMoodTags();
}

// ═══════════════════════════════════════
//  UI — PROFILES
// ═══════════════════════════════════════

function refreshProfileDropdown() {
    const select = $('#echo-profile-select');
    if (!select.length) return;
    select.empty();
    for (const p of extensionSettings.profiles) {
        select.append(`<option value="${p.id}" ${p.id === extensionSettings.activeProfileId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`);
    }
}

function refreshIdentityTab() {
    const p = getActiveProfile();
    if (!p) return;
    $('#echo-p-name').val(p.persona_name || ''); $('#echo-p-age').val(p.persona_age || '');
    $('#echo-p-description').val(p.persona_description || ''); $('#echo-p-appearance').val(p.persona_appearance || '');
    $('#echo-p-personality').val(p.persona_personality || ''); $('#echo-p-history').val(p.persona_history || '');
}

function refreshVoiceTab() {
    const p = getActiveProfile();
    if (!p) return;
    $('#echo-p-mannerisms').val(p.persona_mannerisms || ''); $('#echo-p-quirks').val(p.persona_quirks || '');
    $('#echo-p-speech').val(p.persona_speech_patterns || '');
}

function refreshDialogueTab() { renderDialogueExamples(); }

function renderDialogueExamples() {
    const container = $('#echo-dialogue-list');
    if (!container.length) return;
    container.empty();
    const p = getActiveProfile();
    if (!p) return;
    (p.persona_dialogue || []).forEach((d, i) => {
        const row = $(`<div class="echo-dialogue-row"><input class="echo-dialogue-situation" placeholder="Situation" value="${escapeHtml(d.situation || '')}"><textarea class="echo-dialogue-example" placeholder="How they'd talk..." rows="2">${escapeHtml(d.example || '')}</textarea><button class="echo-dialogue-remove menu_button menu_button_icon" title="Remove"><i class="fa-solid fa-trash"></i></button></div>`);
        row.find('.echo-dialogue-situation').on('blur', function () { const pr = getActiveProfile(); if (pr) { pr.persona_dialogue[i].situation = $(this).val(); saveSettings(); } });
        row.find('.echo-dialogue-example').on('blur', function () { const pr = getActiveProfile(); if (pr) { pr.persona_dialogue[i].example = $(this).val(); saveSettings(); } });
        row.find('.echo-dialogue-remove').on('click', function () { const pr = getActiveProfile(); if (pr) { pr.persona_dialogue.splice(i, 1); saveSettings(); renderDialogueExamples(); } });
        container.append(row);
    });
}

function saveProfileField(fieldName, value) {
    const p = getActiveProfile();
    if (!p) return;
    p[fieldName] = value;
    if (fieldName === 'persona_name') { p.name = value || 'Unnamed'; refreshProfileDropdown(); }
    saveSettings();
}

// ═══════════════════════════════════════
//  UI — TABS & ACTIONS
// ═══════════════════════════════════════

function switchTab(tabName) {
    currentTab = tabName;
    $('.echo-tab-btn').removeClass('active');
    $(`.echo-tab-btn[data-tab="${tabName}"]`).addClass('active');
    $('.echo-tab-content').hide();
    $(`#echo-tab-${tabName}`).show();
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Copied!', 'Echo', { timeOut: 1500 });
    }).catch(() => {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        toastr.success('Copied!', 'Echo', { timeOut: 1500 });
    });
}

function pasteToInput(text) {
    const textarea = $('#send_textarea');
    if (!textarea.length) { toastr.warning('No chat input found', 'Echo'); return; }
    textarea.val(text); textarea.trigger('input');
    const el = textarea[0];
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    toastr.success('Reply pasted — review and send!', 'Echo', { timeOut: 2000 });
    togglePanel(false);
}

// ═══════════════════════════════════════
//  UI — PANEL
// ═══════════════════════════════════════

function createPanel() {
    if ($('#echo-panel').length) return;
    const p = getActiveProfile() || {};

    const panelHtml = `
<div id="echo-panel" class="echo-panel" style="display: none;">
    <div class="echo-header">
        <span class="echo-title">🔊 Echo <span style="font-size:10px;opacity:0.5;">v3</span></span>
        <button id="echo-close" class="menu_button menu_button_icon" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="echo-tabs">
        <button class="echo-tab-btn active" data-tab="reply">Reply</button>
        <button class="echo-tab-btn" data-tab="identity">Identity</button>
        <button class="echo-tab-btn" data-tab="voice">Voice</button>
        <button class="echo-tab-btn" data-tab="dialogue">Dialogue</button>
    </div>

    <div id="echo-tab-reply" class="echo-tab-content echo-tab-reply">
        <div class="echo-section-toggle" id="echo-toggle-chatctx"><i class="fa-solid fa-link"></i><span>Chat Context</span><span class="echo-badge" id="echo-chatctx-badge" style="display:none;">saved</span><i class="fa-solid fa-chevron-down echo-chevron"></i></div>
        <div class="echo-section-body" id="echo-chatctx-body" style="display:none;">
            <textarea id="echo-chat-relationship" class="echo-textarea" placeholder="Relationship with this character..." rows="2"></textarea>
            <textarea id="echo-chat-lastsession" class="echo-textarea" placeholder="Where you left off..." rows="2" style="margin-top:4px;"></textarea>
            <div class="echo-chatctx-hint">Saves per chat automatically</div>
        </div>

        <div class="echo-section-toggle" id="echo-toggle-mood"><i class="fa-solid fa-masks-theater"></i><span>Mood & Tone</span><i class="fa-solid fa-chevron-down echo-chevron"></i></div>
        <div class="echo-section-body" id="echo-mood-body" style="display:none;">
            <div class="echo-mood-input-row"><input type="text" id="echo-mood-input" class="echo-input" placeholder="Type a mood and press Enter..."></div>
            <div id="echo-mood-tags" class="echo-mood-tags"></div>
            <textarea id="echo-mood-context" class="echo-textarea" placeholder="Internal context..." rows="2"></textarea>
        </div>

        <div class="echo-section-toggle" id="echo-toggle-custom"><i class="fa-solid fa-pen"></i><span>Custom Direction</span><i class="fa-solid fa-chevron-down echo-chevron"></i></div>
        <div class="echo-section-body" id="echo-custom-body" style="display:none;">
            <textarea id="echo-custom-prompt" class="echo-textarea" placeholder="Specific direction for this reply..." rows="2"></textarea>
        </div>

        <div class="echo-length-bar">
            <i class="fa-solid fa-text-height" title="Reply length"></i>
            <input type="range" id="echo-reply-length" min="1" max="4" value="${extensionSettings.replyLength || 2}" step="1">
            <span id="echo-reply-length-label" class="echo-length-label">${['','Short','Medium','Long','Detailed'][extensionSettings.replyLength || 2]}</span>
        </div>

        <button id="echo-generate" class="echo-generate-btn"><i class="fa-solid fa-comment-dots"></i> Generate Replies</button>
        <div id="echo-results" class="echo-results"><div class="echo-status"><i class="fa-solid fa-comment-dots"></i><span>Generate replies to see options here</span></div></div>
    </div>

    <div id="echo-tab-identity" class="echo-tab-content" style="display:none;">
        <div class="echo-form-scroll">
            <div class="echo-profile-bar">
                <select id="echo-profile-select" class="echo-input echo-profile-dropdown"></select>
                <button id="echo-profile-new" class="menu_button menu_button_icon" title="New"><i class="fa-solid fa-plus"></i></button>
                <button id="echo-profile-dupe" class="menu_button menu_button_icon" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
                <button id="echo-profile-delete" class="menu_button menu_button_icon" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
            <label class="echo-label">Name</label><input type="text" id="echo-p-name" class="echo-input" value="${escapeHtml(p.persona_name || '')}">
            <label class="echo-label">Age</label><input type="text" id="echo-p-age" class="echo-input" value="${escapeHtml(p.persona_age || '')}">
            <label class="echo-label">Description</label><textarea id="echo-p-description" class="echo-textarea" rows="3">${escapeHtml(p.persona_description || '')}</textarea>
            <label class="echo-label">Appearance</label><textarea id="echo-p-appearance" class="echo-textarea" rows="2">${escapeHtml(p.persona_appearance || '')}</textarea>
            <label class="echo-label">Personality</label><textarea id="echo-p-personality" class="echo-textarea" rows="3">${escapeHtml(p.persona_personality || '')}</textarea>
            <label class="echo-label">History</label><textarea id="echo-p-history" class="echo-textarea" rows="3">${escapeHtml(p.persona_history || '')}</textarea>
        </div>
    </div>

    <div id="echo-tab-voice" class="echo-tab-content" style="display:none;">
        <div class="echo-form-scroll">
            <label class="echo-label">Mannerisms</label><textarea id="echo-p-mannerisms" class="echo-textarea" rows="3">${escapeHtml(p.persona_mannerisms || '')}</textarea>
            <label class="echo-label">Quirks</label><textarea id="echo-p-quirks" class="echo-textarea" rows="3">${escapeHtml(p.persona_quirks || '')}</textarea>
            <label class="echo-label">Speech Patterns</label><textarea id="echo-p-speech" class="echo-textarea" rows="3">${escapeHtml(p.persona_speech_patterns || '')}</textarea>
        </div>
    </div>

    <div id="echo-tab-dialogue" class="echo-tab-content" style="display:none;">
        <div class="echo-form-scroll">
            <p class="echo-hint">Tonal references — the AI captures the voice, not the words.</p>
            <div id="echo-dialogue-list"></div>
            <button id="echo-dialogue-add-btn" class="echo-dialogue-add menu_button menu_button_icon"><i class="fa-solid fa-plus"></i> Add example</button>
        </div>
    </div>
</div>`;

    const targets = ['#form_sheld', '#sheld', '#chat', 'body'];
    for (const sel of targets) { const t = $(sel); if (t.length) { t.append(panelHtml); break; } }

    // Wire events
    $('#echo-close').on('click', () => togglePanel(false));
    $('.echo-tab-btn').on('click', function () { switchTab($(this).data('tab')); });
    $('#echo-generate').on('click', generateReplies);

    const lengthNames = ['', 'Short', 'Medium', 'Long', 'Detailed'];
    $('#echo-reply-length').on('input', function () { extensionSettings.replyLength = parseInt($(this).val()); $('#echo-reply-length-label').text(lengthNames[extensionSettings.replyLength]); saveSettings(); });

    $('#echo-toggle-chatctx').on('click', function () { $('#echo-chatctx-body').slideToggle(150); $(this).find('.echo-chevron').toggleClass('echo-chevron-open'); });
    $('#echo-toggle-mood').on('click', function () { $('#echo-mood-body').slideToggle(150); $(this).find('.echo-chevron').toggleClass('echo-chevron-open'); });
    $('#echo-toggle-custom').on('click', function () { $('#echo-custom-body').slideToggle(150); $(this).find('.echo-chevron').toggleClass('echo-chevron-open'); });

    $('#echo-mood-input').on('keydown', function (e) { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); const val = $(this).val().replace(/,/g, '').trim(); if (val) { addMoodTag(val); $(this).val(''); } } });

    $('#echo-chat-relationship').on('blur', function () { chatContext.relationship = $(this).val(); saveChatContext(); updateChatContextBadge(); });
    $('#echo-chat-lastsession').on('blur', function () { chatContext.last_session = $(this).val(); saveChatContext(); updateChatContextBadge(); });

    refreshProfileDropdown();
    $('#echo-profile-select').on('change', function () { setActiveProfile($(this).val()); });
    $('#echo-profile-new').on('click', () => { const p = newProfile('New Persona'); extensionSettings.profiles.push(p); setActiveProfile(p.id); toastr.success('Created new persona', 'Echo'); });
    $('#echo-profile-dupe').on('click', () => { const src = getActiveProfile(); if (!src) return; const d = JSON.parse(JSON.stringify(src)); d.id = 'echo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8); d.name = src.name + ' (copy)'; extensionSettings.profiles.push(d); setActiveProfile(d.id); toastr.success(`Duplicated "${src.name}"`, 'Echo'); });
    $('#echo-profile-delete').on('click', () => { if (extensionSettings.profiles.length <= 1) { toastr.warning('Cannot delete last persona', 'Echo'); return; } const p = getActiveProfile(); if (!p || !confirm(`Delete "${p.name}"?`)) return; extensionSettings.profiles = extensionSettings.profiles.filter(x => x.id !== p.id); setActiveProfile(extensionSettings.profiles[0].id); saveSettings(); toastr.info(`Deleted "${p.name}"`, 'Echo'); });

    const identityMap = { 'echo-p-name': 'persona_name', 'echo-p-age': 'persona_age', 'echo-p-description': 'persona_description', 'echo-p-appearance': 'persona_appearance', 'echo-p-personality': 'persona_personality', 'echo-p-history': 'persona_history' };
    for (const [id, key] of Object.entries(identityMap)) { $(`#${id}`).on('blur', function () { saveProfileField(key, $(this).val()); }); }

    const voiceMap = { 'echo-p-mannerisms': 'persona_mannerisms', 'echo-p-quirks': 'persona_quirks', 'echo-p-speech': 'persona_speech_patterns' };
    for (const [id, key] of Object.entries(voiceMap)) { $(`#${id}`).on('blur', function () { saveProfileField(key, $(this).val()); }); }

    $('#echo-dialogue-add-btn').on('click', () => { const pr = getActiveProfile(); if (pr) { pr.persona_dialogue.push({ situation: '', example: '' }); saveSettings(); renderDialogueExamples(); } });

    renderDialogueExamples();
    renderMoodTags();
    loadChatContext();
    updateChatContextBadge();
}

function updateChatContextBadge() {
    const has = (chatContext.relationship || '').trim() || (chatContext.last_session || '').trim();
    $('#echo-chatctx-badge').toggle(!!has);
}

function createChatButton() {
    if ($('#echo-chat-btn').length) return;
    const btn = $(`<button id="echo-chat-btn" class="echo-chat-btn menu_button menu_button_icon" title="Echo — Generate persona reply"><i class="fa-solid fa-user-pen"></i></button>`);
    const targets = ['#leftSendForm', '#send_form'];
    let placed = false;
    for (const sel of targets) { const t = $(sel); if (t.length) { t.append(btn); placed = true; break; } }
    if (!placed) $('body').append(btn);
    btn.on('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
}

function togglePanel(forceState) {
    const panel = $('#echo-panel');
    if (!panel.length) return;
    const isVisible = panel.is(':visible');
    const shouldShow = forceState !== undefined ? forceState : !isVisible;
    if (shouldShow) {
        if (window.innerWidth <= 1000) panel.css({ right: '', left: '', bottom: '' });
        panel.fadeIn(150);
        switchTab('reply');
        loadChatContext();
        updateChatContextBadge();
    } else { panel.fadeOut(150); }
}

// ═══════════════════════════════════════
//  EXTENSION SETTINGS PANEL
// ═══════════════════════════════════════

function addSettingsPanel() {
    const profiles = getAvailableConnectionProfiles();
    const profileOptions = profiles.map(p => `<option value="${escapeHtml(p)}" ${extensionSettings.selectedProfile === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');

    const html = `
<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🔊 Echo</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="echo-enabled" ${extensionSettings.enabled ? 'checked' : ''}><span>Enable</span></label>
    <hr>
    <label><small>Connection Profile</small></label>
    <select id="echo-connection-profile" class="text_pole"><option value="current" ${extensionSettings.selectedProfile === 'current' ? 'selected' : ''}>Use Current</option><option value="fallback" ${extensionSettings.selectedProfile === 'fallback' ? 'selected' : ''}>Use Main (generateRaw)</option>${profileOptions}</select>
    <hr>
    <label><small>Reply options per generation</small></label>
    <input type="range" id="echo-reply-count" min="2" max="5" value="${extensionSettings.replyCount}" step="1"><span id="echo-reply-count-val">${extensionSettings.replyCount}</span>
    <hr>
    <label><small>Chat context depth (messages)</small></label>
    <input type="range" id="echo-context-depth" min="2" max="20" value="${extensionSettings.contextDepth}" step="1"><span id="echo-context-depth-val">${extensionSettings.contextDepth}</span>
    <hr>
    <div style="margin-top:4px;"><small><b>Ecosystem Integration:</b></small>
    <label class="checkbox_label"><input type="checkbox" id="echo-use-lexicon" ${extensionSettings.useLexicon ? 'checked' : ''}><span>Use Lexicon world context</span></label>
    <label class="checkbox_label"><input type="checkbox" id="echo-use-codex" ${extensionSettings.useCodex ? 'checked' : ''}><span>Use Codex character intel</span></label>
    <small style="opacity:0.5;display:block;margin-top:2px;">When active, replies are grounded in world lore and informed by NPC psychology.</small></div>
</div></div>`;

    $('#extensions_settings2').append(html);

    $('#echo-enabled').on('change', function () { extensionSettings.enabled = $(this).prop('checked'); saveSettings(); if (extensionSettings.enabled) { createChatButton(); createPanel(); } else { $('#echo-chat-btn, #echo-panel').remove(); } });
    $('#echo-connection-profile').on('change', function () { extensionSettings.selectedProfile = $(this).val(); saveSettings(); });
    $('#echo-reply-count').on('input', function () { extensionSettings.replyCount = parseInt($(this).val()); $('#echo-reply-count-val').text(extensionSettings.replyCount); saveSettings(); });
    $('#echo-context-depth').on('input', function () { extensionSettings.contextDepth = parseInt($(this).val()); $('#echo-context-depth-val').text(extensionSettings.contextDepth); saveSettings(); });
    $('#echo-use-lexicon').on('change', function () { extensionSettings.useLexicon = $(this).prop('checked'); saveSettings(); });
    $('#echo-use-codex').on('change', function () { extensionSettings.useCodex = $(this).prop('checked'); saveSettings(); });
}

function getAvailableConnectionProfiles() {
    try { return (getContext().extensionSettings?.connectionManager?.profiles || []).map(p => p.name).filter(Boolean); } catch { return []; }
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════

function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════

jQuery(async () => {
    try {
        console.log(`[Echo] v${EXT_VERSION} init…`);
        loadSettings();
        addSettingsPanel();
        if (extensionSettings.enabled) {
            createChatButton();
            createPanel();
            eventSource.on(event_types.CHAT_CHANGED, () => { loadChatContext(); updateChatContextBadge(); });
        }
        console.log(`[Echo] 🔊 v${EXT_VERSION} Ready`);
    } catch (error) {
        console.error('[Echo] Init failed:', error);
        toastr.error('Echo failed to initialize', 'Echo');
    }
});
