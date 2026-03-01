/**
 * Echo — Persona Impersonation Engine
 * Generates in-character replies for the user's persona using a separate
 * connection profile. Provides multiple response options with mood/tone control.
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
    chat
} from '../../../../script.js';

import { power_user } from '../../../power-user.js';

const extensionName = 'Echo';

// ─── Default Settings ───
const defaultSettings = {
    enabled: true,
    // Connection
    selectedProfile: 'current',
    // Generation
    replyCount: 3,
    replyLength: 2,     // 1-4: short/medium/long/extra
    contextDepth: 6,
    // Persona — Identity
    persona_name: '',
    persona_age: '',
    persona_description: '',
    persona_appearance: '',
    persona_personality: '',
    persona_history: '',
    // Persona — Voice
    persona_mannerisms: '',
    persona_quirks: '',
    persona_speech_patterns: '',
    // Persona — Dialogue examples
    persona_dialogue: [],  // [{situation, example}]
    // Mood (per-session, not saved)
    mood_tags: [],
    mood_context: '',
    // Custom prompt
    custom_prompt: ''
};

let extensionSettings = { ...defaultSettings };
let isGenerating = false;
let currentTab = 'reply';
let sessionMoodTags = [];

// ═══════════════════════════════════════
//  SETTINGS
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
    if (!Array.isArray(extensionSettings.persona_dialogue)) {
        extensionSettings.persona_dialogue = [];
    }
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}

// ═══════════════════════════════════════
//  CONNECTION PROFILE
// ═══════════════════════════════════════

function getProfileIdByName(profileName) {
    const ctx = getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return null;

    if (profileName === 'current') {
        return cm.selectedProfile;
    }

    const profile = cm.profiles?.find(p => p.name === profileName);
    return profile ? profile.id : null;
}

function getProfileById(profileId) {
    if (!profileId) return null;
    const ctx = getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    return cm?.profiles?.find(p => p.id === profileId) || null;
}

async function generateViaProfile(prompt, maxTokens = 1000) {
    const ctx = getContext();

    // Try connection profile first
    if (ctx.ConnectionManagerRequestService && extensionSettings.selectedProfile !== 'fallback') {
        const profileId = getProfileIdByName(extensionSettings.selectedProfile);
        if (profileId) {
            const response = await ctx.ConnectionManagerRequestService.sendRequest(
                profileId,
                [{ role: 'user', content: prompt }],
                maxTokens,
                {
                    extractData: true,
                    includePreset: true,
                    includeInstruct: false
                },
                {}
            );
            if (response?.content) return response.content;
        }
    }

    // Fallback to generateRaw
    return await generateRaw(prompt, null, false, false);
}

// ═══════════════════════════════════════
//  CHAT CONTEXT
// ═══════════════════════════════════════

function getChatContext() {
    const context = getContext();
    const chatHistory = context.chat;
    if (!chatHistory || chatHistory.length === 0) return null;

    const depth = Math.max(2, Math.min(20, extensionSettings.contextDepth || 6));
    const recent = chatHistory.slice(-depth);

    const messages = recent.map(msg => {
        let text = msg.mes || '';
        // Strip HTML and thinking tags
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
    const s = extensionSettings;
    let block = '';

    // Identity
    if (s.persona_name) block += `Name: ${s.persona_name}\n`;
    if (s.persona_age) block += `Age: ${s.persona_age}\n`;
    if (s.persona_description) block += `Description: ${s.persona_description}\n`;
    if (s.persona_appearance) block += `Appearance: ${s.persona_appearance}\n`;
    if (s.persona_personality) block += `Personality: ${s.persona_personality}\n`;
    if (s.persona_history) block += `Background: ${s.persona_history}\n`;

    // Voice
    if (s.persona_mannerisms) block += `Mannerisms: ${s.persona_mannerisms}\n`;
    if (s.persona_quirks) block += `Quirks: ${s.persona_quirks}\n`;
    if (s.persona_speech_patterns) block += `Speech patterns: ${s.persona_speech_patterns}\n`;

    // Dialogue examples
    if (s.persona_dialogue && s.persona_dialogue.length > 0) {
        block += `\nDialogue reference (these are TONAL REFERENCES showing how this character speaks in different situations — do NOT copy them verbatim, use them to understand the character's voice):\n`;
        for (const d of s.persona_dialogue) {
            if (d.situation && d.example) {
                block += `  When ${d.situation}: "${d.example}"\n`;
            }
        }
    }

    return block.trim();
}

// ═══════════════════════════════════════
//  PROMPT BUILDING
// ═══════════════════════════════════════

function buildReplyPrompt(chatContext) {
    const count = extensionSettings.replyCount || 3;
    const personaBlock = buildPersonaBlock();
    const personaName = extensionSettings.persona_name || chatContext.userName;

    // Mood section
    let moodSection = '';
    const tags = sessionMoodTags;
    const moodContext = $('#echo-mood-context').val() || '';

    if (tags.length > 0 || moodContext) {
        moodSection = '\nCURRENT EMOTIONAL STATE:\n';
        if (tags.length > 0) {
            moodSection += `Mood: ${tags.join(', ')}\n`;
        }
        if (moodContext) {
            moodSection += `Internal context: ${moodContext}\n`;
        }
    }

    // Custom prompt
    const customPrompt = ($('#echo-custom-prompt').val() || '').trim();
    let customSection = '';
    if (customPrompt) {
        customSection = `\nADDITIONAL DIRECTION:\n${customPrompt}\n`;
    }

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
- React to what ${chatContext.charName} said/did in the most recent message.
- Your dialogue examples are TONAL REFERENCES — capture the style and energy, never copy them word-for-word.
- Each reply option should take a slightly different approach or emotional angle while staying in character.
- Include actions, thoughts, and dialogue as appropriate for the scene.
- LENGTH: ${lengthInstruction}

PERSONA:
${personaBlock || `Name: ${personaName}\n(No detailed persona provided — write naturally as this character)`}
${moodSection}${customSection}
RECENT CONVERSATION:
${chatContext.messages}

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

    const chatContext = getChatContext();
    if (!chatContext) {
        showResults([]);
        toastr.warning('No chat history found — start a conversation first', 'Echo');
        return;
    }

    const prompt = buildReplyPrompt(chatContext);

    isGenerating = true;
    showLoadingState();

    try {
        const response = await generateViaProfile(prompt, 2000);

        if (!response || typeof response !== 'string') {
            throw new Error('Empty response from API');
        }

        const replies = parseReplies(response);

        if (replies.length === 0) {
            throw new Error('Could not parse any replies');
        }

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

    // Try structured format first: ---REPLY N---
    const blocks = text.split(/---\s*REPLY\s*\d+\s*---/i);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (trimmed.length > 20) {
            replies.push(trimmed);
        }
    }

    // Fallback: split by numbered headers
    if (replies.length === 0) {
        const numbered = text.split(/\n\s*(?:Option|Reply|Response)\s*\d+[:\.\)]/i);
        for (const block of numbered) {
            const trimmed = block.trim();
            if (trimmed.length > 20) {
                replies.push(trimmed);
            }
        }
    }

    // Last fallback: split by triple newlines
    if (replies.length === 0) {
        const chunks = text.split(/\n{3,}/).map(c => c.trim()).filter(c => c.length > 20);
        replies.push(...chunks);
    }

    // Ultimate fallback: just use the whole thing
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
        container.html(`
            <div class="echo-status">
                <i class="fa-solid fa-comment-dots"></i>
                <span>Generate replies to see options here</span>
            </div>
        `);
        return;
    }

    replies.forEach((text, i) => {
        const card = $(`
            <div class="echo-reply-card" data-index="${i}">
                <div class="echo-reply-label">Option ${i + 1}</div>
                <div class="echo-reply-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
                <div class="echo-reply-actions">
                    <button class="echo-use menu_button menu_button_icon" title="Use this reply">
                        <i class="fa-solid fa-check"></i> Use
                    </button>
                    <button class="echo-copy menu_button menu_button_icon" title="Copy">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
        `);

        card.find('.echo-use').on('click', (e) => {
            e.stopPropagation();
            pasteToInput(text);
        });

        card.find('.echo-copy').on('click', (e) => {
            e.stopPropagation();
            copyToClipboard(text);
        });

        container.append(card);
    });
}

function showLoadingState() {
    const container = $('#echo-results');
    container.html(`
        <div class="echo-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Writing replies...</span>
        </div>
    `);
}

function showErrorState(message) {
    const container = $('#echo-results');
    container.html(`
        <div class="echo-status echo-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>${escapeHtml(message)}</span>
        </div>
    `);
}

// ═══════════════════════════════════════
//  UI — MOOD TAGS
// ═══════════════════════════════════════

function renderMoodTags() {
    const container = $('#echo-mood-tags');
    container.empty();

    sessionMoodTags.forEach((tag, i) => {
        const pill = $(`
            <span class="echo-mood-pill">
                ${escapeHtml(tag)}
                <i class="fa-solid fa-xmark echo-mood-remove" data-index="${i}"></i>
            </span>
        `);

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
    if (sessionMoodTags.length >= 8) {
        toastr.warning('Maximum 8 mood tags', 'Echo');
        return;
    }
    sessionMoodTags.push(clean);
    renderMoodTags();
}

// ═══════════════════════════════════════
//  UI — DIALOGUE EXAMPLES
// ═══════════════════════════════════════

function renderDialogueExamples() {
    const container = $('#echo-dialogue-list');
    container.empty();

    const examples = extensionSettings.persona_dialogue || [];

    examples.forEach((d, i) => {
        const row = $(`
            <div class="echo-dialogue-row">
                <input class="echo-dialogue-situation" placeholder="Situation (e.g. surprised, angry)" value="${escapeHtml(d.situation || '')}">
                <textarea class="echo-dialogue-example" placeholder="How they'd talk..." rows="2">${escapeHtml(d.example || '')}</textarea>
                <button class="echo-dialogue-remove menu_button menu_button_icon" title="Remove" data-index="${i}">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `);

        row.find('.echo-dialogue-situation').on('blur', function () {
            extensionSettings.persona_dialogue[i].situation = $(this).val();
            saveSettings();
        });

        row.find('.echo-dialogue-example').on('blur', function () {
            extensionSettings.persona_dialogue[i].example = $(this).val();
            saveSettings();
        });

        row.find('.echo-dialogue-remove').on('click', function () {
            extensionSettings.persona_dialogue.splice(i, 1);
            saveSettings();
            renderDialogueExamples();
        });

        container.append(row);
    });

    // Add button
    if (!container.find('.echo-dialogue-add').length) {
        const addBtn = $(`
            <button class="echo-dialogue-add menu_button menu_button_icon">
                <i class="fa-solid fa-plus"></i> Add example
            </button>
        `);
        addBtn.on('click', () => {
            extensionSettings.persona_dialogue.push({ situation: '', example: '' });
            saveSettings();
            renderDialogueExamples();
        });
        container.after(addBtn);
    }
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
    if (!textarea.length) {
        toastr.warning('No chat input found', 'Echo');
        return;
    }
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

    const panelHtml = `
        <div id="echo-panel" class="echo-panel" style="display: none;">
            <div class="echo-header">
                <span class="echo-title">🔊 Echo</span>
                <button id="echo-close" class="menu_button menu_button_icon" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="echo-tabs">
                <button class="echo-tab-btn active" data-tab="reply">Reply</button>
                <button class="echo-tab-btn" data-tab="identity">Identity</button>
                <button class="echo-tab-btn" data-tab="voice">Voice</button>
                <button class="echo-tab-btn" data-tab="dialogue">Dialogue</button>
            </div>

            <!-- TAB: Reply -->
            <div id="echo-tab-reply" class="echo-tab-content echo-tab-reply">
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
                    <textarea id="echo-custom-prompt" class="echo-textarea" placeholder="Specific direction for this reply... (e.g. 'respond with a question about their past')" rows="2"></textarea>
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
                    <div class="echo-status">
                        <i class="fa-solid fa-comment-dots"></i>
                        <span>Generate replies to see options here</span>
                    </div>
                </div>
            </div>

            <!-- TAB: Identity -->
            <div id="echo-tab-identity" class="echo-tab-content" style="display: none;">
                <div class="echo-form-scroll">
                    <label class="echo-label">Name</label>
                    <input type="text" id="echo-p-name" class="echo-input" placeholder="Character name" value="${escapeHtml(extensionSettings.persona_name || '')}">

                    <label class="echo-label">Age</label>
                    <input type="text" id="echo-p-age" class="echo-input" placeholder="Age or age range" value="${escapeHtml(extensionSettings.persona_age || '')}">

                    <label class="echo-label">Description</label>
                    <textarea id="echo-p-description" class="echo-textarea" placeholder="General vibe, who they are, core traits..." rows="3">${escapeHtml(extensionSettings.persona_description || '')}</textarea>

                    <label class="echo-label">Appearance</label>
                    <textarea id="echo-p-appearance" class="echo-textarea" placeholder="How they look, what they wear..." rows="2">${escapeHtml(extensionSettings.persona_appearance || '')}</textarea>

                    <label class="echo-label">Personality</label>
                    <textarea id="echo-p-personality" class="echo-textarea" placeholder="Deeper personality traits, values, flaws..." rows="3">${escapeHtml(extensionSettings.persona_personality || '')}</textarea>

                    <label class="echo-label">History</label>
                    <textarea id="echo-p-history" class="echo-textarea" placeholder="Backstory, key events, formative experiences..." rows="3">${escapeHtml(extensionSettings.persona_history || '')}</textarea>
                </div>
            </div>

            <!-- TAB: Voice -->
            <div id="echo-tab-voice" class="echo-tab-content" style="display: none;">
                <div class="echo-form-scroll">
                    <label class="echo-label">Mannerisms</label>
                    <textarea id="echo-p-mannerisms" class="echo-textarea" placeholder="Body language habits, gestures, tics..." rows="3">${escapeHtml(extensionSettings.persona_mannerisms || '')}</textarea>

                    <label class="echo-label">Quirks</label>
                    <textarea id="echo-p-quirks" class="echo-textarea" placeholder="Unique behaviors, catchphrases, habits..." rows="3">${escapeHtml(extensionSettings.persona_quirks || '')}</textarea>

                    <label class="echo-label">Speech Patterns</label>
                    <textarea id="echo-p-speech" class="echo-textarea" placeholder="How they talk — formal, casual, clipped, rambling, accent notes..." rows="3">${escapeHtml(extensionSettings.persona_speech_patterns || '')}</textarea>
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
        if (target.length) {
            target.append(panelHtml);
            break;
        }
    }

    // Wire up events
    $('#echo-close').on('click', () => togglePanel(false));

    // Tabs
    $('.echo-tab-btn').on('click', function () {
        switchTab($(this).data('tab'));
    });

    // Generate
    $('#echo-generate').on('click', generateReplies);

    // Reply length slider
    const lengthNames = ['', 'Short', 'Medium', 'Long', 'Detailed'];
    $('#echo-reply-length').on('input', function () {
        extensionSettings.replyLength = parseInt($(this).val());
        $('#echo-reply-length-label').text(lengthNames[extensionSettings.replyLength]);
        saveSettings();
    });

    // Mood toggles
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
            if (val) {
                addMoodTag(val);
                $(this).val('');
            }
        }
    });

    // Identity fields — save on blur
    const identityMap = {
        'echo-p-name': 'persona_name',
        'echo-p-age': 'persona_age',
        'echo-p-description': 'persona_description',
        'echo-p-appearance': 'persona_appearance',
        'echo-p-personality': 'persona_personality',
        'echo-p-history': 'persona_history'
    };

    for (const [id, key] of Object.entries(identityMap)) {
        $(`#${id}`).on('blur', function () {
            extensionSettings[key] = $(this).val();
            saveSettings();
        });
    }

    // Voice fields
    const voiceMap = {
        'echo-p-mannerisms': 'persona_mannerisms',
        'echo-p-quirks': 'persona_quirks',
        'echo-p-speech': 'persona_speech_patterns'
    };

    for (const [id, key] of Object.entries(voiceMap)) {
        $(`#${id}`).on('blur', function () {
            extensionSettings[key] = $(this).val();
            saveSettings();
        });
    }

    // Dialogue examples
    $('#echo-dialogue-add-btn').on('click', () => {
        extensionSettings.persona_dialogue.push({ situation: '', example: '' });
        saveSettings();
        renderDialogueExamples();
    });

    renderDialogueExamples();
    renderMoodTags();
}

function createChatButton() {
    if ($('#echo-chat-btn').length) return;

    // Insert near the send button area
    const btn = $(`
        <button id="echo-chat-btn" class="echo-chat-btn menu_button menu_button_icon" title="Echo — Generate persona reply">
            <i class="fa-solid fa-user-pen"></i>
        </button>
    `);

    // Try to place it next to the impersonate button or send form
    const impersonateBtn = $('#option_impersonate');
    const sendForm = $('#send_form');
    const leftButtons = $('#leftSendForm');

    if (leftButtons.length) {
        leftButtons.append(btn);
    } else if (impersonateBtn.length) {
        impersonateBtn.after(btn);
    } else if (sendForm.length) {
        sendForm.prepend(btn);
    } else {
        $('body').append(btn);
    }

    btn.on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
    });
}

function togglePanel(forceState) {
    const panel = $('#echo-panel');
    if (!panel.length) return;

    const isVisible = panel.is(':visible');
    const shouldShow = forceState !== undefined ? forceState : !isVisible;

    if (shouldShow) {
        if (window.innerWidth <= 1000) {
            panel.css({ right: '', left: '', bottom: '' });
        }
        panel.fadeIn(150);
        // Always show reply tab when opening from chat button
        switchTab('reply');
    } else {
        panel.fadeOut(150);
    }
}

// ═══════════════════════════════════════
//  SETTINGS PANEL
// ═══════════════════════════════════════

function addSettingsPanel() {
    const profiles = getAvailableProfiles();
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
                <select id="echo-profile" class="text_pole">
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

    // Wire up
    $('#echo-enabled').on('change', function () {
        extensionSettings.enabled = $(this).prop('checked');
        saveSettings();
        if (extensionSettings.enabled) {
            createChatButton();
            createPanel();
        } else {
            $('#echo-chat-btn').remove();
            $('#echo-panel').remove();
        }
    });

    $('#echo-profile').on('change', function () {
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

function getAvailableProfiles() {
    try {
        const ctx = getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        if (!cm?.profiles || !Array.isArray(cm.profiles)) return [];
        return cm.profiles.map(p => p.name).filter(Boolean);
    } catch (e) {
        return [];
    }
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
        }

        console.log('[Echo] 🔊 Ready');
    } catch (error) {
        console.error('[Echo] Init failed:', error);
        toastr.error('Echo failed to initialize', 'Echo');
    }
});
