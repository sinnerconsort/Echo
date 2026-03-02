/**
 * Echo — Persona Impersonation Engine (v2)
 * Two-layer persistence:
 *   - Persona Profiles (global) — identity, voice, dialogue examples
 *   - Per-Chat Context (chat_metadata) — relationship, last session notes
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

import { power_user } from '../../../power-user.js';

const extensionName = 'Echo';

// ─── Empty profile template ───
function newProfile(name) {
    return {
        id: 'echo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'New Persona',
        // Identity
        persona_name: name || '',
        persona_age: '',
        persona_description: '',
        persona_appearance: '',
        persona_personality: '',
        persona_history: '',
        // Voice
        persona_mannerisms: '',
        persona_quirks: '',
        persona_speech_patterns: '',
        // Dialogue
        persona_dialogue: []
    };
}

// ─── Default settings (no persona fields here — those live in profiles) ───
const defaultSettings = {
    enabled: true,
    selectedProfile: 'current',     // connection profile
    replyCount: 3,
    replyLength: 2,
    contextDepth: 6,
    // Profiles
    activeProfileId: null,
    profiles: []
};

let extensionSettings = {};
let isGenerating = false;
let currentTab = 'reply';
let sessionMoodTags = [];

// Per-chat context (loaded from chat_metadata)
let chatContext = {
    relationship: '',
    last_session: ''
};

// ═══════════════════════════════════════
//  SETTINGS & PERSISTENCE
// ═══════════════════════════════════════

function loadSettings() {
    const context = getContext();
    if (!context.extensionSettings[extensionName]) {
        context.extensionSettings[extensionName] = { ...defaultSettings };
    }
    extensionSettings = context.extensionSettings[extensionName];
    for (const [key, val] of Object.entries(defaultSettings)) {
        if (extensionSettings[key] === undefined) extensionSettings[key] = val;
    }
    if (!Array.isArray(extensionSettings.profiles)) {
        extensionSettings.profiles = [];
    }
    migrateOldData();
    // Ensure at least one profile exists
    if (extensionSettings.profiles.length === 0) {
        const p = newProfile('Default');
        extensionSettings.profiles.push(p);
        extensionSettings.activeProfileId = p.id;
        saveSettings();
    }
    // Ensure activeProfileId is valid
    if (!getActiveProfile()) {
        extensionSettings.activeProfileId = extensionSettings.profiles[0]?.id || null;
    }
}

function migrateOldData() {
    // Migrate flat persona fields from v1 into a profile
    if (extensionSettings.persona_name || extensionSettings.persona_description) {
        const p = newProfile(extensionSettings.persona_name || 'Migrated Persona');
        const fields = [
            'persona_name', 'persona_age', 'persona_description', 'persona_appearance',
            'persona_personality', 'persona_history', 'persona_mannerisms',
            'persona_quirks', 'persona_speech_patterns', 'persona_dialogue'
        ];
        for (const f of fields) {
            if (extensionSettings[f] !== undefined) {
                p[f] = extensionSettings[f];
                delete extensionSettings[f];
            }
        }
        if (!Array.isArray(p.persona_dialogue)) p.persona_dialogue = [];
        extensionSettings.profiles.push(p);
        extensionSettings.activeProfileId = p.id;
        // Clean up old keys
        delete extensionSettings.mood_tags;
        delete extensionSettings.mood_context;
        delete extensionSettings.custom_prompt;
        console.log('[Echo] Migrated v1 persona data into profile:', p.name);
    }
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}

function getActiveProfile() {
    if (!extensionSettings.activeProfileId) return null;
    return extensionSettings.profiles.find(p => p.id === extensionSettings.activeProfileId) || null;
}

function setActiveProfile(profileId) {
    extensionSettings.activeProfileId = profileId;
    saveSettings();
    refreshIdentityTab();
    refreshVoiceTab();
    refreshDialogueTab();
    refreshProfileDropdown();
}

// ─── Per-Chat Context (chat_metadata) ───

function loadChatContext() {
    const context = getContext();
    const meta = context.chat_metadata;
    if (meta && meta.echo) {
        chatContext.relationship = meta.echo.relationship || '';
        chatContext.last_session = meta.echo.last_session || '';
    } else {
        chatContext.relationship = '';
        chatContext.last_session = '';
    }
    // Update UI if panel is open
    $('#echo-chat-relationship').val(chatContext.relationship);
    $('#echo-chat-lastsession').val(chatContext.last_session);
}

function saveChatContext() {
    const context = getContext();
    if (!context.chat_metadata) return;
    context.chat_metadata.echo = {
        relationship: chatContext.relationship,
        last_session: chatContext.last_session
    };
    saveChatDebounced();
}

// ═══════════════════════════════════════
//  CONNECTION PROFILE (API)
// ═══════════════════════════════════════

function getConnectionProfileId(profileName) {
    const ctx = getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return null;
    if (profileName === 'current') return cm.selectedProfile;
    const profile = cm.profiles?.find(p => p.name === profileName);
    return profile ? profile.id : null;
}

async function generateViaProfile(prompt, maxTokens = 1000) {
    const ctx = getContext();

    if (ctx.ConnectionManagerRequestService && extensionSettings.selectedProfile !== 'fallback') {
        const profileId = getConnectionProfileId(extensionSettings.selectedProfile);
        if (profileId) {
            const response = await ctx.ConnectionManagerRequestService.sendRequest(
                profileId,
                [{ role: 'user', content: prompt }],
                maxTokens,
                { extractData: true, includePreset: true, includeInstruct: false },
                {}
            );
            if (response?.content) return response.content;
        }
    }

    return await generateRaw(prompt, null, false, false);
}

// ═══════════════════════════════════════
//  CHAT HISTORY EXTRACTION
// ═══════════════════════════════════════

function getRecentChat() {
    const context = getContext();
    const chatHistory = context.chat;
    if (!chatHistory || chatHistory.length === 0) return null;

    const depth = Math.max(2, Math.min(20, extensionSettings.contextDepth || 6));
    const recent = chatHistory.slice(-depth);

    const messages = recent.map(msg => {
        let text = msg.mes || '';
        text = text.replace(/<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
        text = text.replace(/<[^>]*>/g, '').trim();
        return `${msg.name}: ${text.substring(0, 3000)}`;
    }).join('\n\n');

    return {
        messages,
        charName: context.name2 || 'Character',
        userName: context.name1 || 'User',
        messageCount: recent.length
    };
}

// ═══════════════════════════════════════
//  PERSONA BLOCK BUILDING
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

    if (p.persona_dialogue && p.persona_dialogue.length > 0) {
        block += `\nDialogue reference (TONAL REFERENCES — do NOT copy verbatim, use to understand voice):\n`;
        for (const d of p.persona_dialogue) {
            if (d.situation && d.example) {
                block += `  When ${d.situation}: "${d.example}"\n`;
            }
        }
    }

    return block.trim();
}

function buildChatContextBlock() {
    let block = '';
    const rel = chatContext.relationship || ($('#echo-chat-relationship').val() || '').trim();
    const last = chatContext.last_session || ($('#echo-chat-lastsession').val() || '').trim();

    if (rel) block += `Relationship with this character: ${rel}\n`;
    if (last) block += `Where things left off: ${last}\n`;

    return block ? `\nCHAT-SPECIFIC CONTEXT:\n${block}` : '';
}

// ═══════════════════════════════════════
//  PROMPT BUILDING
// ═══════════════════════════════════════

function buildReplyPrompt(chat) {
    const count = extensionSettings.replyCount || 3;
    const personaBlock = buildPersonaBlock();
    const profile = getActiveProfile();
    const personaName = profile?.persona_name || chat.userName;
    const chatContextBlock = buildChatContextBlock();

    // Mood
    let moodSection = '';
    const tags = sessionMoodTags;
    const moodContext = $('#echo-mood-context').val() || '';
    if (tags.length > 0 || moodContext) {
        moodSection = '\nCURRENT EMOTIONAL STATE:\n';
        if (tags.length > 0) moodSection += `Mood: ${tags.join(', ')}\n`;
        if (moodContext) moodSection += `Internal context: ${moodContext}\n`;
    }

    // Custom
    const customPrompt = ($('#echo-custom-prompt').val() || '').trim();
    let customSection = '';
    if (customPrompt) customSection = `\nADDITIONAL DIRECTION:\n${customPrompt}\n`;

    // Length
    const lengthLabels = {
        1: 'Keep replies SHORT — 1-2 sentences max. Punchy and concise.',
        2: 'Write MEDIUM length replies — 1-2 short paragraphs.',
        3: 'Write LONGER replies — 2-3 paragraphs with detail.',
        4: 'Write DETAILED replies — 3-4 paragraphs with rich description, internal thoughts, and actions.'
    };
    const lengthInstruction = lengthLabels[extensionSettings.replyLength || 2];

    return `You are a skilled roleplay writer. Your job is to write replies AS a specific persona character in a roleplay conversation. You are NOT the AI — you are ghostwriting for the USER's character.

CRITICAL RULES:
- Write ONLY as ${personaName}. Every reply must be from their perspective, in their voice.
- Stay consistent with the persona's personality, speech patterns, and mannerisms.
- React to what ${chat.charName} said/did in the most recent message.
- Your dialogue examples are TONAL REFERENCES — capture the style and energy, never copy them word-for-word.
- Each reply option should take a slightly different approach or emotional angle while staying in character.
- Include actions, thoughts, and dialogue as appropriate for the scene.
- LENGTH: ${lengthInstruction}

PERSONA:
${personaBlock || `Name: ${personaName}\n(No detailed persona provided — write naturally as this character)`}
${chatContextBlock}${moodSection}${customSection}
RECENT CONVERSATION:
${chat.messages}

Generate exactly ${count} distinct reply options for ${personaName}. Each should take a different angle on how ${personaName} might respond in this moment.

Format each reply with a separator line. Use this exact format:
---REPLY 1---
(reply text)
---REPLY 2---
(reply text)
${count > 2 ? `---REPLY 3---\n(reply text)\n` : ''}${count > 3 ? `---REPLY 4---\n(reply text)\n` : ''}${count > 4 ? `---REPLY 5---\n(reply text)\n` : ''}
Output ONLY the formatted replies, nothing else.`;
}

// ═══════════════════════════════════════
//  GENERATION
// ═══════════════════════════════════════

async function generateReplies() {
    if (isGenerating) return;

    const chat = getRecentChat();
    if (!chat) {
        showResults([]);
        toastr.warning('No chat history found — start a conversation first', 'Echo');
        return;
    }

    // Save per-chat context from UI before generating
    chatContext.relationship = $('#echo-chat-relationship').val() || '';
    chatContext.last_session = $('#echo-chat-lastsession').val() || '';
    saveChatContext();

    const prompt = buildReplyPrompt(chat);

    isGenerating = true;
    showLoadingState();

    try {
        const response = await generateViaProfile(prompt, 2000);

        if (!response || typeof response !== 'string') {
            throw new Error('Empty response from API');
        }

        const replies = parseReplies(response);
        if (replies.length === 0) throw new Error('Could not parse any replies');

        showResults(replies);
    } catch (err) {
        console.error('[Echo] Generation failed:', err);
        showErrorState(err.message || 'Generation failed');
    } finally {
        isGenerating = false;
    }
}

// ═══════════════════════════════════════
//  PARSING
// ═══════════════════════════════════════

function parseReplies(text) {
    const replies = [];

    const blocks = text.split(/---\s*REPLY\s*\d+\s*---/i);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (trimmed.length > 20) replies.push(trimmed);
    }

    if (replies.length === 0) {
        const numbered = text.split(/\n\s*(?:Option|Reply|Response)\s*\d+[:\.\)]/i);
        for (const block of numbered) {
            const trimmed = block.trim();
            if (trimmed.length > 20) replies.push(trimmed);
        }
    }

    if (replies.length === 0) {
        const chunks = text.split(/\n{3,}/).map(c => c.trim()).filter(c => c.length > 20);
        replies.push(...chunks);
    }

    if (replies.length === 0 && text.trim().length > 20) {
        replies.push(text.trim());
    }

    return replies;
}

// ═══════════════════════════════════════
//  UI — RESULTS
// ═══════════════════════════════════════

function showResults(replies) {
    const container = $('#echo-results');
    container.empty();

    if (replies.length === 0) {
        container.html(`<div class="echo-status"><i class="fa-solid fa-comment-dots"></i><span>Generate replies to see options here</span></div>`);
        return;
    }

    replies.forEach((text, i) => {
        const card = $(`
            <div class="echo-reply-card" data-index="${i}">
                <div class="echo-reply-label">Option ${i + 1}</div>
                <div class="echo-reply-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
                <div class="echo-reply-actions">
                    <button class="echo-use menu_button menu_button_icon" title="Use this reply"><i class="fa-solid fa-check"></i> Use</button>
                    <button class="echo-copy menu_button menu_button_icon" title="Copy"><i class="fa-solid fa-copy"></i></button>
                </div>
            </div>
        `);

        card.find('.echo-use').on('click', (e) => { e.stopPropagation(); pasteToInput(text); });
        card.find('.echo-copy').on('click', (e) => { e.stopPropagation(); copyToClipboard(text); });
        container.append(card);
    });
}

function showLoadingState() {
    $('#echo-results').html(`<div class="echo-status"><i class="fa-solid fa-spinner fa-spin"></i><span>Writing replies...</span></div>`);
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
        pill.find('.echo-mood-remove').on('click', function () {
            sessionMoodTags.splice(i, 1);
            renderMoodTags();
        });
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
//  UI — PROFILE MANAGEMENT
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
    $('#echo-p-name').val(p.persona_name || '');
    $('#echo-p-age').val(p.persona_age || '');
    $('#echo-p-description').val(p.persona_description || '');
    $('#echo-p-appearance').val(p.persona_appearance || '');
    $('#echo-p-personality').val(p.persona_personality || '');
    $('#echo-p-history').val(p.persona_history || '');
}

function refreshVoiceTab() {
    const p = getActiveProfile();
    if (!p) return;
    $('#echo-p-mannerisms').val(p.persona_mannerisms || '');
    $('#echo-p-quirks').val(p.persona_quirks || '');
    $('#echo-p-speech').val(p.persona_speech_patterns || '');
}

function refreshDialogueTab() {
    renderDialogueExamples();
}

function renderDialogueExamples() {
    const container = $('#echo-dialogue-list');
    if (!container.length) return;
    container.empty();

    const p = getActiveProfile();
    if (!p) return;
    const examples = p.persona_dialogue || [];

    examples.forEach((d, i) => {
        const row = $(`
            <div class="echo-dialogue-row">
                <input class="echo-dialogue-situation" placeholder="Situation (e.g. surprised, angry)" value="${escapeHtml(d.situation || '')}">
                <textarea class="echo-dialogue-example" placeholder="How they'd talk..." rows="2">${escapeHtml(d.example || '')}</textarea>
                <button class="echo-dialogue-remove menu_button menu_button_icon" title="Remove"><i class="fa-solid fa-trash"></i></button>
            </div>
        `);

        row.find('.echo-dialogue-situation').on('blur', function () {
            const profile = getActiveProfile();
            if (profile) { profile.persona_dialogue[i].situation = $(this).val(); saveSettings(); }
        });
        row.find('.echo-dialogue-example').on('blur', function () {
            const profile = getActiveProfile();
            if (profile) { profile.persona_dialogue[i].example = $(this).val(); saveSettings(); }
        });
        row.find('.echo-dialogue-remove').on('click', function () {
            const profile = getActiveProfile();
            if (profile) { profile.persona_dialogue.splice(i, 1); saveSettings(); renderDialogueExamples(); }
        });

        container.append(row);
    });
}

function saveProfileField(fieldName, value) {
    const p = getActiveProfile();
    if (!p) return;
    p[fieldName] = value;
    // If name changed, update dropdown too
    if (fieldName === 'persona_name') {
        p.name = value || 'Unnamed';
        refreshProfileDropdown();
    }
    saveSettings();
}

// ═══════════════════════════════════════
//  UI — TABS
// ═══════════════════════════════════════

function switchTab(tabName) {
    currentTab = tabName;
    $('.echo-tab-btn').removeClass('active');
    $(`.echo-tab-btn[data-tab="${tabName}"]`).addClass('active');
    $('.echo-tab-content').hide();
    $(`#echo-tab-${tabName}`).show();
}

// ═══════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        toastr.success('Copied!', 'Echo', { timeOut: 1500 });
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toastr.success('Copied!', 'Echo', { timeOut: 1500 });
    });
}

function pasteToInput(text) {
    const textarea = $('#send_textarea');
    if (!textarea.length) { toastr.warning('No chat input found', 'Echo'); return; }
    textarea.val(text);
    textarea.trigger('input');
    const el = textarea[0];
    if (el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
                <span class="echo-title">🔊 Echo</span>
                <button id="echo-close" class="menu_button menu_button_icon" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="echo-tabs">
                <button class="echo-tab-btn active" data-tab="reply">Reply</button>
                <button class="echo-tab-btn" data-tab="identity">Identity</button>
                <button class="echo-tab-btn" data-tab="voice">Voice</button>
                <button class="echo-tab-btn" data-tab="dialogue">Dialogue</button>
            </div>

            <!-- TAB: Reply -->
            <div id="echo-tab-reply" class="echo-tab-content echo-tab-reply">
                <div class="echo-section-toggle" id="echo-toggle-chatctx">
                    <i class="fa-solid fa-link"></i>
                    <span>Chat Context</span>
                    <span class="echo-badge" id="echo-chatctx-badge" style="display:none;">saved</span>
                    <i class="fa-solid fa-chevron-down echo-chevron"></i>
                </div>
                <div class="echo-section-body" id="echo-chatctx-body" style="display: none;">
                    <textarea id="echo-chat-relationship" class="echo-textarea" placeholder="Relationship with this character... (e.g. 'childhood rivals who secretly care about each other')" rows="2"></textarea>
                    <textarea id="echo-chat-lastsession" class="echo-textarea" placeholder="Where you left off... (e.g. 'Nova just discovered Alastor's secret')" rows="2" style="margin-top:4px;"></textarea>
                    <div class="echo-chatctx-hint">Saves per chat automatically</div>
                </div>

                <div class="echo-section-toggle" id="echo-toggle-mood">
                    <i class="fa-solid fa-masks-theater"></i>
                    <span>Mood & Tone</span>
                    <i class="fa-solid fa-chevron-down echo-chevron"></i>
                </div>
                <div class="echo-section-body" id="echo-mood-body" style="display: none;">
                    <div class="echo-mood-input-row">
                        <input type="text" id="echo-mood-input" class="echo-input" placeholder="Type a mood and press Enter...">
                    </div>
                    <div id="echo-mood-tags" class="echo-mood-tags"></div>
                    <textarea id="echo-mood-context" class="echo-textarea" placeholder="Internal context... (e.g. 'pretending to be fine but barely holding it together')" rows="2"></textarea>
                </div>

                <div class="echo-section-toggle" id="echo-toggle-custom">
                    <i class="fa-solid fa-pen"></i>
                    <span>Custom Direction</span>
                    <i class="fa-solid fa-chevron-down echo-chevron"></i>
                </div>
                <div class="echo-section-body" id="echo-custom-body" style="display: none;">
                    <textarea id="echo-custom-prompt" class="echo-textarea" placeholder="Specific direction for this reply..." rows="2"></textarea>
                </div>

                <div class="echo-length-bar">
                    <i class="fa-solid fa-text-height" title="Reply length"></i>
                    <input type="range" id="echo-reply-length" min="1" max="4" value="${extensionSettings.replyLength}" step="1">
                    <span id="echo-reply-length-label" class="echo-length-label">${['', 'Short', 'Medium', 'Long', 'Detailed'][extensionSettings.replyLength || 2]}</span>
                </div>

                <button id="echo-generate" class="echo-generate-btn">
                    <i class="fa-solid fa-comment-dots"></i> Generate Replies
                </button>

                <div id="echo-results" class="echo-results">
                    <div class="echo-status"><i class="fa-solid fa-comment-dots"></i><span>Generate replies to see options here</span></div>
                </div>
            </div>

            <!-- TAB: Identity -->
            <div id="echo-tab-identity" class="echo-tab-content" style="display: none;">
                <div class="echo-form-scroll">
                    <div class="echo-profile-bar">
                        <select id="echo-profile-select" class="echo-input echo-profile-dropdown"></select>
                        <button id="echo-profile-new" class="menu_button menu_button_icon" title="New persona"><i class="fa-solid fa-plus"></i></button>
                        <button id="echo-profile-dupe" class="menu_button menu_button_icon" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
                        <button id="echo-profile-delete" class="menu_button menu_button_icon" title="Delete persona"><i class="fa-solid fa-trash"></i></button>
                    </div>

                    <label class="echo-label">Name</label>
                    <input type="text" id="echo-p-name" class="echo-input" placeholder="Character name" value="${escapeHtml(p.persona_name || '')}">

                    <label class="echo-label">Age</label>
                    <input type="text" id="echo-p-age" class="echo-input" placeholder="Age or age range" value="${escapeHtml(p.persona_age || '')}">

                    <label class="echo-label">Description</label>
                    <textarea id="echo-p-description" class="echo-textarea" placeholder="General vibe, who they are, core traits..." rows="3">${escapeHtml(p.persona_description || '')}</textarea>

                    <label class="echo-label">Appearance</label>
                    <textarea id="echo-p-appearance" class="echo-textarea" placeholder="How they look, what they wear..." rows="2">${escapeHtml(p.persona_appearance || '')}</textarea>

                    <label class="echo-label">Personality</label>
                    <textarea id="echo-p-personality" class="echo-textarea" placeholder="Deeper personality traits, values, flaws..." rows="3">${escapeHtml(p.persona_personality || '')}</textarea>

                    <label class="echo-label">History</label>
                    <textarea id="echo-p-history" class="echo-textarea" placeholder="Backstory, key events, formative experiences..." rows="3">${escapeHtml(p.persona_history || '')}</textarea>
                </div>
            </div>

            <!-- TAB: Voice -->
            <div id="echo-tab-voice" class="echo-tab-content" style="display: none;">
                <div class="echo-form-scroll">
                    <label class="echo-label">Mannerisms</label>
                    <textarea id="echo-p-mannerisms" class="echo-textarea" placeholder="Body language habits, gestures, tics..." rows="3">${escapeHtml(p.persona_mannerisms || '')}</textarea>

                    <label class="echo-label">Quirks</label>
                    <textarea id="echo-p-quirks" class="echo-textarea" placeholder="Unique behaviors, catchphrases, habits..." rows="3">${escapeHtml(p.persona_quirks || '')}</textarea>

                    <label class="echo-label">Speech Patterns</label>
                    <textarea id="echo-p-speech" class="echo-textarea" placeholder="How they talk — formal, casual, clipped, rambling, accent notes..." rows="3">${escapeHtml(p.persona_speech_patterns || '')}</textarea>
                </div>
            </div>

            <!-- TAB: Dialogue -->
            <div id="echo-tab-dialogue" class="echo-tab-content" style="display: none;">
                <div class="echo-form-scroll">
                    <p class="echo-hint">Add examples of how your character talks in different situations. These are <b>tonal references</b> — the AI won't copy them verbatim but will capture the voice.</p>
                    <div id="echo-dialogue-list"></div>
                    <button id="echo-dialogue-add-btn" class="echo-dialogue-add menu_button menu_button_icon">
                        <i class="fa-solid fa-plus"></i> Add example
                    </button>
                </div>
            </div>
        </div>
    `;

    const targets = ['#form_sheld', '#sheld', '#chat', 'body'];
    for (const selector of targets) {
        const target = $(selector);
        if (target.length) { target.append(panelHtml); break; }
    }

    // ─── Wire up events ───
    $('#echo-close').on('click', () => togglePanel(false));
    $('.echo-tab-btn').on('click', function () { switchTab($(this).data('tab')); });
    $('#echo-generate').on('click', generateReplies);

    // Length slider
    const lengthNames = ['', 'Short', 'Medium', 'Long', 'Detailed'];
    $('#echo-reply-length').on('input', function () {
        extensionSettings.replyLength = parseInt($(this).val());
        $('#echo-reply-length-label').text(lengthNames[extensionSettings.replyLength]);
        saveSettings();
    });

    // Section toggles
    $('#echo-toggle-chatctx').on('click', function () {
        $('#echo-chatctx-body').slideToggle(150);
        $(this).find('.echo-chevron').toggleClass('echo-chevron-open');
    });
    $('#echo-toggle-mood').on('click', function () {
        $('#echo-mood-body').slideToggle(150);
        $(this).find('.echo-chevron').toggleClass('echo-chevron-open');
    });
    $('#echo-toggle-custom').on('click', function () {
        $('#echo-custom-body').slideToggle(150);
        $(this).find('.echo-chevron').toggleClass('echo-chevron-open');
    });

    // Mood tag input
    $('#echo-mood-input').on('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const val = $(this).val().replace(/,/g, '').trim();
            if (val) { addMoodTag(val); $(this).val(''); }
        }
    });

    // Per-chat context — save on blur
    $('#echo-chat-relationship').on('blur', function () {
        chatContext.relationship = $(this).val();
        saveChatContext();
        updateChatContextBadge();
    });
    $('#echo-chat-lastsession').on('blur', function () {
        chatContext.last_session = $(this).val();
        saveChatContext();
        updateChatContextBadge();
    });

    // ─── Profile management ───
    refreshProfileDropdown();

    $('#echo-profile-select').on('change', function () {
        setActiveProfile($(this).val());
    });

    $('#echo-profile-new').on('click', () => {
        const p = newProfile('New Persona');
        extensionSettings.profiles.push(p);
        setActiveProfile(p.id);
        toastr.success('Created new persona', 'Echo');
    });

    $('#echo-profile-dupe').on('click', () => {
        const src = getActiveProfile();
        if (!src) return;
        const dupe = JSON.parse(JSON.stringify(src));
        dupe.id = 'echo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        dupe.name = src.name + ' (copy)';
        extensionSettings.profiles.push(dupe);
        setActiveProfile(dupe.id);
        toastr.success(`Duplicated "${src.name}"`, 'Echo');
    });

    $('#echo-profile-delete').on('click', () => {
        if (extensionSettings.profiles.length <= 1) {
            toastr.warning('Cannot delete last persona', 'Echo');
            return;
        }
        const p = getActiveProfile();
        if (!p) return;
        if (!confirm(`Delete persona "${p.name}"? This cannot be undone.`)) return;
        extensionSettings.profiles = extensionSettings.profiles.filter(x => x.id !== p.id);
        setActiveProfile(extensionSettings.profiles[0].id);
        saveSettings();
        toastr.info(`Deleted "${p.name}"`, 'Echo');
    });

    // ─── Identity fields → save to active profile on blur ───
    const identityMap = {
        'echo-p-name': 'persona_name',
        'echo-p-age': 'persona_age',
        'echo-p-description': 'persona_description',
        'echo-p-appearance': 'persona_appearance',
        'echo-p-personality': 'persona_personality',
        'echo-p-history': 'persona_history'
    };
    for (const [id, key] of Object.entries(identityMap)) {
        $(`#${id}`).on('blur', function () { saveProfileField(key, $(this).val()); });
    }

    // Voice fields
    const voiceMap = {
        'echo-p-mannerisms': 'persona_mannerisms',
        'echo-p-quirks': 'persona_quirks',
        'echo-p-speech': 'persona_speech_patterns'
    };
    for (const [id, key] of Object.entries(voiceMap)) {
        $(`#${id}`).on('blur', function () { saveProfileField(key, $(this).val()); });
    }

    // Dialogue
    $('#echo-dialogue-add-btn').on('click', () => {
        const profile = getActiveProfile();
        if (profile) {
            profile.persona_dialogue.push({ situation: '', example: '' });
            saveSettings();
            renderDialogueExamples();
        }
    });

    renderDialogueExamples();
    renderMoodTags();
    loadChatContext();
    updateChatContextBadge();
}

function updateChatContextBadge() {
    const hasContent = (chatContext.relationship || '').trim() || (chatContext.last_session || '').trim();
    $('#echo-chatctx-badge').toggle(!!hasContent);
}

function createChatButton() {
    if ($('#echo-chat-btn').length) return;

    const btn = $(`<button id="echo-chat-btn" class="echo-chat-btn menu_button menu_button_icon" title="Echo — Generate persona reply"><i class="fa-solid fa-user-pen"></i></button>`);

    const leftButtons = $('#leftSendForm');
    const impersonateBtn = $('#option_impersonate');
    const sendForm = $('#send_form');

    if (leftButtons.length) leftButtons.append(btn);
    else if (impersonateBtn.length) impersonateBtn.after(btn);
    else if (sendForm.length) sendForm.prepend(btn);
    else $('body').append(btn);

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
    } else {
        panel.fadeOut(150);
    }
}

// ═══════════════════════════════════════
//  SETTINGS PANEL (Extensions drawer)
// ═══════════════════════════════════════

function addSettingsPanel() {
    const profiles = getAvailableConnectionProfiles();
    const profileOptions = profiles.map(p =>
        `<option value="${escapeHtml(p)}" ${extensionSettings.selectedProfile === p ? 'selected' : ''}>${escapeHtml(p)}</option>`
    ).join('');

    const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔊 Echo</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="echo-enabled" ${extensionSettings.enabled ? 'checked' : ''}>
                    <span>Enable</span>
                </label>
                <hr>
                <label><small>Connection Profile</small></label>
                <select id="echo-connection-profile" class="text_pole">
                    <option value="current" ${extensionSettings.selectedProfile === 'current' ? 'selected' : ''}>Use Current Connection</option>
                    <option value="fallback" ${extensionSettings.selectedProfile === 'fallback' ? 'selected' : ''}>Use Main (generateRaw)</option>
                    ${profileOptions}
                </select>
                <hr>
                <label><small>Reply options per generation</small></label>
                <input type="range" id="echo-reply-count" min="2" max="5" value="${extensionSettings.replyCount}" step="1">
                <span id="echo-reply-count-val">${extensionSettings.replyCount}</span>
                <hr>
                <label><small>Chat context depth (messages)</small></label>
                <input type="range" id="echo-context-depth" min="2" max="20" value="${extensionSettings.contextDepth}" step="1">
                <span id="echo-context-depth-val">${extensionSettings.contextDepth}</span>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

    $('#echo-enabled').on('change', function () {
        extensionSettings.enabled = $(this).prop('checked');
        saveSettings();
        if (extensionSettings.enabled) { createChatButton(); createPanel(); }
        else { $('#echo-chat-btn').remove(); $('#echo-panel').remove(); }
    });

    $('#echo-connection-profile').on('change', function () {
        extensionSettings.selectedProfile = $(this).val();
        saveSettings();
    });

    $('#echo-reply-count').on('input', function () {
        extensionSettings.replyCount = parseInt($(this).val());
        $('#echo-reply-count-val').text(extensionSettings.replyCount);
        saveSettings();
    });

    $('#echo-context-depth').on('input', function () {
        extensionSettings.contextDepth = parseInt($(this).val());
        $('#echo-context-depth-val').text(extensionSettings.contextDepth);
        saveSettings();
    });
}

function getAvailableConnectionProfiles() {
    try {
        const ctx = getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        if (!cm?.profiles || !Array.isArray(cm.profiles)) return [];
        return cm.profiles.map(p => p.name).filter(Boolean);
    } catch (e) { return []; }
}

// ═══════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════

function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadChatContext();
        updateChatContextBadge();
    });
}

// ═══════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════

jQuery(async () => {
    try {
        console.log('[Echo] Initializing...');
        loadSettings();
        addSettingsPanel();

        if (extensionSettings.enabled) {
            createChatButton();
            createPanel();
            registerEvents();
        }

        console.log('[Echo] 🔊 Ready');
    } catch (error) {
        console.error('[Echo] Init failed:', error);
        toastr.error('Echo failed to initialize', 'Echo');
    }
});
