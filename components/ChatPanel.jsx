'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { chatWithAI, fetchAIModels, fetchDriveFiles, fetchDriveFilesContent } from '@/lib/api';

/* ── Default system prompts for each function ── */
const DEFAULT_PROMPTS = {
  'vendor-question': `You are an AI assistant helping a government contracting company. We are government contractors who have reached out to a business to see if they could fulfill a specific government contract/solicitation. The vendor has responded to us with a question about the contract.

We are attaching all the files of the contract/solicitation for your reference.

IMPORTANT: The vendor does NOT have access to the solicitation files. They may only have received a brief description or summary of what we need. Keep this in mind when drafting your response.

Please analyze the vendor's question in the email below and provide:

1. **Analysis:** A brief explanation of the vendor's question and where the answer can be found in the contract documents. If the answer requires information not in the documents, clearly state that and suggest where to find it.

2. **Draft Email (HTML formatted):** Draft a professional response that I can send directly to the vendor. The response should:
- Directly answer their question based on the contract documents
- Reference specific sections, clauses, or details from the solicitation where applicable
- Do NOT assume the vendor has seen the solicitation files — write the email so it makes sense even without the attachments, but reference "the attached documents" where appropriate
- Be polite, professional, and thorough
- Format the email in clean HTML with proper structure (paragraphs, bullet lists, etc.) so it is ready to copy and send

3. **Recommended Attachments:** After the HTML draft, output a section with EXACTLY this format:

RECOMMENDED_ATTACHMENTS_START
- filename: [exact filename from the solicitation files] | reason: [why the vendor needs this file]
- filename: [exact filename] | reason: [why they need it]
RECOMMENDED_ATTACHMENTS_END

List which solicitation files from our folder should be attached to this email so the vendor has the context they need to understand our response.`,

  'full-partial-quote': `You are an AI assistant helping a government contracting company analyze vendor quotes/proposals. We are government contractors who have sent solicitations to businesses, and a vendor has responded with a quote or proposal.

We are attaching all the files of the contract/solicitation for your reference.

IMPORTANT: The vendor does NOT have access to the solicitation files. They may only have received a brief description or summary of what we need. Keep this in mind when analyzing their quote and drafting any response.

Please analyze whether this vendor's response is a FULL QUOTE or a PARTIAL QUOTE:
- FULL QUOTE: Covers all line items, requirements, and specifications in the solicitation
- PARTIAL QUOTE: Only covers some of the items or requirements

Provide a detailed breakdown of:
1. What items/requirements are covered in the quote
2. What items/requirements are missing (if any)
3. Your assessment: FULL or PARTIAL quote
4. Any concerns or notes about the quote's completeness

If it is a PARTIAL QUOTE, provide TWO things:

A) **Draft Email (HTML formatted):** Draft a professional response that I can send directly to the vendor. The response should:
- Thank them for their quote
- Clearly list the missing line items or requirements they did not address
- Politely request they provide pricing/details for the missing items
- Do NOT assume the vendor has seen the solicitation files — write the email so it makes sense even without the attachments, but reference "the attached documents" where appropriate
- Format the email in clean HTML with proper structure (paragraphs, bullet lists, etc.) so it is ready to copy and send

B) **Recommended Attachments:** After the HTML draft, output a section with EXACTLY this format:

RECOMMENDED_ATTACHMENTS_START
- filename: [exact filename from the solicitation files] | reason: [why the vendor needs this file]
- filename: [exact filename] | reason: [why they need it]
RECOMMENDED_ATTACHMENTS_END

List which solicitation files from our folder should be attached to this email so the vendor has the context they need to complete their quote.`,
};

/* ── Preset definitions ── */
const PROMPT_PRESETS = [
  {
    id: 'vendor-question',
    label: '💬 Answer Vendor Question',
    icon: '💬',
    description: 'Draft a response to a vendor\'s question about a contract',
  },
  {
    id: 'full-partial-quote',
    label: '📋 Check Full or Partial Quote',
    icon: '📋',
    description: 'Analyze if a vendor\'s quote covers all or some items',
  },
];

/* ── Parse recommended attachments from AI response ── */
function parseRecommendedAttachments(text) {
  const startTag = 'RECOMMENDED_ATTACHMENTS_START';
  const endTag = 'RECOMMENDED_ATTACHMENTS_END';
  const startIdx = text.indexOf(startTag);
  const endIdx = text.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return [];

  const block = text.substring(startIdx + startTag.length, endIdx).trim();
  const lines = block.split('\n').filter((l) => l.trim().startsWith('-'));
  return lines.map((line) => {
    const cleaned = line.replace(/^-\s*/, '');
    // Try to match "filename: X | reason: Y"
    const match = cleaned.match(/filename:\s*(.+?)\s*\|\s*reason:\s*(.+)/i);
    if (match) return { filename: match[1].trim(), reason: match[2].trim() };
    // Fallback: split on " — " or " - "
    const parts = cleaned.split(/\s[—–-]\s/);
    if (parts.length >= 2) return { filename: parts[0].trim(), reason: parts.slice(1).join(' — ').trim() };
    return { filename: cleaned.trim(), reason: '' };
  });
}

/**
 * Match recommended filenames to actual Drive files using fuzzy substring matching.
 * Returns an array of { filename, reason, driveFile } where driveFile may be null.
 */
function matchFilesToDrive(recommendations, driveFiles) {
  return recommendations.map((rec) => {
    const recName = rec.filename.toLowerCase().replace(/[^a-z0-9.]/g, '');
    // Exact match first
    let match = driveFiles.find((f) => f.name.toLowerCase() === rec.filename.toLowerCase());
    if (!match) {
      // Substring / fuzzy match
      match = driveFiles.find((f) => {
        const dName = f.name.toLowerCase().replace(/[^a-z0-9.]/g, '');
        return dName.includes(recName) || recName.includes(dName);
      });
    }
    if (!match) {
      // Looser keyword match – check if most words from the recommendation appear in a drive file name
      const recWords = rec.filename.toLowerCase().split(/[\s_\-.]+/).filter((w) => w.length > 2);
      match = driveFiles.find((f) => {
        const fLower = f.name.toLowerCase();
        const matchedWords = recWords.filter((w) => fLower.includes(w));
        return matchedWords.length >= Math.ceil(recWords.length * 0.5);
      });
    }
    return { ...rec, driveFile: match || null };
  });
}

/**
 * Renders the AI's recommended attachment list with download links
 * for matched Drive files.
 */
function AttachmentRecommendations({ recommendations, driveFiles }) {
  const matched = matchFilesToDrive(recommendations, driveFiles);

  if (matched.length === 0) return null;

  const buildDownloadUrl = (driveFile) =>
    `/api/drive/download/${driveFile.id}?name=${encodeURIComponent(driveFile.name)}&mime_type=${encodeURIComponent(driveFile.mimeType || '')}`;

  return (
    <div className="attachment-recs">
      <div className="attachment-recs__header">
        <span className="attachment-recs__icon">📎</span>
        <span className="attachment-recs__title">Recommended Files to Attach</span>
      </div>
      <div className="attachment-recs__list">
        {matched.map((item, idx) => (
          <div
            key={idx}
            className={`attachment-recs__item ${item.driveFile ? 'attachment-recs__item--matched' : 'attachment-recs__item--unmatched'}`}
          >
            <div className="attachment-recs__file-info">
              <span className="attachment-recs__file-icon">
                {item.driveFile ? '✅' : '❓'}
              </span>
              <div className="attachment-recs__file-details">
                <span className="attachment-recs__file-name">{item.filename}</span>
                {item.reason && (
                  <span className="attachment-recs__file-reason">{item.reason}</span>
                )}
              </div>
            </div>
            {item.driveFile ? (
              <a
                href={buildDownloadUrl(item.driveFile)}
                className="btn btn--small attachment-recs__download"
                download={item.driveFile.name}
                title={`Download ${item.driveFile.name}`}
              >
                ⬇️ Download
              </a>
            ) : (
              <span className="attachment-recs__not-found" title="Could not find this file in Google Drive">
                Not found in Drive
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="attachment-recs__hint">
        Download these files and attach them to your reply email.
      </div>
    </div>
  );
}

/**
 * Render AI message content. Detects ```html blocks and renders them
 * as a live preview + a dedicated "Copy HTML" button.
 * Also detects RECOMMENDED_ATTACHMENTS blocks and renders download cards.
 * Plain text / markdown portions are rendered normally.
 */
function AiMessageContent({ content, onCopyHtml, driveFiles }) {
  // Strip out the RECOMMENDED_ATTACHMENTS block from displayed text
  const recommendations = parseRecommendedAttachments(content);
  const cleanContent = content
    .replace(/RECOMMENDED_ATTACHMENTS_START[\s\S]*?RECOMMENDED_ATTACHMENTS_END/g, '')
    .trim();

  // Split on ```html ... ``` fenced code blocks
  const parts = cleanContent.split(/(```html[\s\S]*?```)/gi);

  const hasSpecialContent = parts.length > 1 || recommendations.length > 0;

  if (!hasSpecialContent) {
    // No HTML blocks or attachments – render as plain text with whitespace preserved
    return <div className="chat-bubble__text">{cleanContent}</div>;
  }

  return (
    <div className="chat-bubble__rich">
      {parts.map((part, idx) => {
        const htmlMatch = part.match(/^```html\s*\n?([\s\S]*?)\n?```$/i);
        if (htmlMatch) {
          const htmlCode = htmlMatch[1].trim();
          return (
            <div key={idx} className="chat-bubble__html-block">
              <div className="chat-bubble__html-toolbar">
                <span className="chat-bubble__html-label">📧 Draft Email Preview</span>
                <button
                  className="btn btn--small chat-bubble__copy-html"
                  onClick={() => onCopyHtml(htmlCode)}
                  title="Copy HTML email to clipboard"
                >
                  📋 Copy Email
                </button>
              </div>
              <div
                className="chat-bubble__html-preview"
                dangerouslySetInnerHTML={{ __html: htmlCode }}
              />
            </div>
          );
        }
        // Plain text portion
        if (!part.trim()) return null;
        return (
          <div key={idx} className="chat-bubble__text">
            {part}
          </div>
        );
      })}

      {/* Recommended Attachment Cards */}
      {recommendations.length > 0 && (
        <AttachmentRecommendations
          recommendations={recommendations}
          driveFiles={driveFiles || []}
        />
      )}
    </div>
  );
}

/** Read a file as text (for text files) or as a data URL description (for others) */
function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    if (
      file.type.startsWith('text/') ||
      file.type === 'application/json' ||
      file.type === 'application/xml' ||
      file.name.match(/\.(csv|tsv|md|txt|log|json|xml|yaml|yml|ini|cfg|html|htm|css|js|ts|py|java|c|cpp|h|rb|go|rs|sql)$/i)
    ) {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(`[Could not read file: ${file.name}]`);
      reader.readAsText(file);
    } else {
      // For binary files, just describe them
      resolve(`[Attached binary file: ${file.name} (${(file.size / 1024).toFixed(1)} KB, type: ${file.type || 'unknown'})]\nNote: Binary file content cannot be read as text. Please describe what you need help with regarding this file.`);
    }
  });
}

/**
 * In-dashboard AI chat panel with two government contracting functions.
 *
 * Props:
 *   emailContext – { from, to, subject, date, body } of the email
 *   opportunity  – matched opportunity object (may have drive_link)
 *   onClose      – callback to close the panel
 */
export default function ChatPanel({ emailContext, opportunity, onClose, onRecommendAttachments }) {
  // Phases: 'pick' → 'chat'
  const [phase, setPhase] = useState('pick');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // Model selection
  const [models, setModels] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('gemini');
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');

  // Prompt picker state
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  // Drive files state
  const [driveFiles, setDriveFiles] = useState([]); // metadata from Drive
  const [driveFilesContent, setDriveFilesContent] = useState([]); // downloaded content
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState(null);
  const [driveLoaded, setDriveLoaded] = useState(false);

  // Manual file attachments (user-uploaded)
  const [attachedFiles, setAttachedFiles] = useState([]); // { file, name, content }
  const fileInputRef = useRef(null);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Determine if we have a valid drive link
  const driveLink = opportunity?.drive_link && opportunity.drive_link.startsWith('http')
    ? opportunity.drive_link
    : null;

  const isGemini = selectedProvider === 'gemini';

  // Load available models on mount
  useEffect(() => {
    fetchAIModels()
      .then((m) => {
        setModels(m);
        if (m.length > 0) {
          setSelectedProvider(m[0].provider);
          setSelectedModel(m[0].model);
        }
      })
      .catch(() => {
        setModels([{ provider: 'gemini', model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' }]);
      });
  }, []);

  // When a preset is selected, set the default system prompt
  useEffect(() => {
    if (selectedPreset && DEFAULT_PROMPTS[selectedPreset]) {
      setSystemPrompt(DEFAULT_PROMPTS[selectedPreset]);
    }
  }, [selectedPreset]);

  // Auto-fetch Drive files when a preset is selected and we have a drive link
  useEffect(() => {
    if (selectedPreset && driveLink && !driveLoaded && !driveLoading) {
      loadDriveFiles();
    }
  }, [selectedPreset, driveLink]);

  const loadDriveFiles = async () => {
    if (!driveLink) return;
    setDriveLoading(true);
    setDriveError(null);
    try {
      const result = await fetchDriveFiles(driveLink);
      const files = result.files || [];
      setDriveFiles(files);
      setDriveLoaded(true);

      if (files.length === 0) {
        setDriveError('No files found in the Google Drive folder. The folder may be empty or not shared with the service account. Please upload files manually.');
        return;
      }

      // For Gemini: we only need file metadata – the backend downloads
      // raw bytes and attaches them natively via inline_data.
      // For OpenAI: download text content on the frontend.
      if (!isGemini) {
        const contentResult = await fetchDriveFilesContent(files);
        setDriveFilesContent(contentResult.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch Drive files:', err);
      setDriveError('Failed to load files from Google Drive. Please upload files manually.');
    } finally {
      setDriveLoading(false);
    }
  };

  // Check if we have any files at all (Drive + manual)
  // For Gemini: driveFiles metadata is enough (backend downloads bytes)
  // For OpenAI: need driveFilesContent (text already extracted)
  const driveFileCount = isGemini ? driveFiles.length : driveFilesContent.length;
  const totalFiles = driveFileCount + attachedFiles.length;
  const hasNoFiles = !driveLoading && totalFiles === 0;

  // Build the full user message from email context + file contents
  const buildContextMessage = useCallback(() => {
    const ctx = emailContext || {};
    let text = `Here is the vendor's email:\n\nFrom: ${ctx.from || 'Unknown'}\nTo: ${ctx.to || ''}\nSubject: ${ctx.subject || '(no subject)'}\nDate: ${ctx.date || ''}\n\n${ctx.body || '(no content)'}`;

    // Add Drive files content
    if (driveFilesContent.length > 0) {
      text += '\n\n========================================';
      text += '\nSOLICITATION / CONTRACT FILES';
      text += '\n========================================';
      for (const df of driveFilesContent) {
        text += `\n\n--- File: ${df.name} ---\n`;
        if (df.error) {
          text += `[Error loading file: ${df.error}]`;
        } else {
          text += df.content || '[Empty file]';
        }
      }
    }

    // Add manually uploaded files
    if (attachedFiles.length > 0) {
      text += '\n\n--- Additional Uploaded Files ---';
      for (const af of attachedFiles) {
        text += `\n\n📎 File: ${af.name}\n${af.content}`;
      }
    }

    return text;
  }, [emailContext, driveFilesContent, attachedFiles]);

  // Send a message to the AI
  // driveFileIds is passed ONLY on the first message (for Gemini native attach)
  const sendMessage = useCallback(
    async (text, prevMessages = [], driveFileIds = []) => {
      const userMsg = { role: 'user', content: text };
      const updated = [...prevMessages, userMsg];
      setMessages(updated);
      setInput('');
      setLoading(true);

      try {
        const { reply } = await chatWithAI(
          updated,
          selectedProvider,
          selectedModel,
          driveFileIds,
        );
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);

        // Auto-pass recommended Drive attachments to parent for use in Reply/Draft
        if (onRecommendAttachments && driveFiles.length > 0) {
          const recs = parseRecommendedAttachments(reply);
          if (recs.length > 0) {
            const matched = matchFilesToDrive(recs, driveFiles);
            const driveFilesMeta = matched
              .filter((m) => m.driveFile)
              .map((m) => ({ id: m.driveFile.id, name: m.driveFile.name, mimeType: m.driveFile.mimeType || '' }));
            if (driveFilesMeta.length > 0) {
              onRecommendAttachments(driveFilesMeta);
            }
          }
        }
      } catch (err) {
        console.error('AI chat error:', err);
        const detail = err?.response?.data?.details || err?.response?.data?.error || '';
        const isRateLimit = detail.toLowerCase().includes('rate-limit') || detail.includes('429');
        const errorMsg = isRateLimit
          ? '⚠️ All API keys are currently rate-limited. Please wait about a minute and try again.'
          : `⚠️ Failed to get a response. ${detail || 'Please try again.'}`;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: errorMsg },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [selectedProvider, selectedModel],
  );

  // Build a message with ONLY the email (no file text) – used for Gemini
  const buildEmailOnlyMessage = useCallback(() => {
    const ctx = emailContext || {};
    let text = `Here is the vendor's email:\n\nFrom: ${ctx.from || 'Unknown'}\nTo: ${ctx.to || ''}\nSubject: ${ctx.subject || '(no subject)'}\nDate: ${ctx.date || ''}\n\n${ctx.body || '(no content)'}`;

    // Even for Gemini, include manually-uploaded text files in the message
    if (attachedFiles.length > 0) {
      text += '\n\n--- Additional Uploaded Files ---';
      for (const af of attachedFiles) {
        text += `\n\n📎 File: ${af.name}\n${af.content}`;
      }
    }

    return text;
  }, [emailContext, attachedFiles]);

  // Start the chat after picking a prompt
  const handleStartChat = useCallback(() => {
    if (!selectedPreset) return;

    const finalSystemPrompt = systemPrompt.trim() || 'You are a helpful assistant.';

    // For Gemini: send only email text; files are attached natively via backend
    // For OpenAI: send email text + extracted file text in one big message
    const contextMessage = isGemini
      ? buildEmailOnlyMessage()
      : buildContextMessage();

    // For Gemini: pass Drive file metadata so backend downloads & attaches raw bytes
    const driveFileIds = isGemini
      ? driveFiles.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
      : [];

    const initialMessages = [
      { role: 'system', content: finalSystemPrompt },
    ];

    setMessages(initialMessages);
    setPhase('chat');

    // Send the email context + files as the first user message
    sendMessage(contextMessage, initialMessages, driveFileIds);
  }, [selectedPreset, systemPrompt, isGemini, buildEmailOnlyMessage, buildContextMessage, driveFiles, sendMessage]);

  // File attachment handler
  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const content = await readFileAsText(file);
      setAttachedFiles((prev) => [...prev, { file, name: file.name, content }]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (idx) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus the input when loading finishes
  useEffect(() => {
    if (!loading && inputRef.current && phase === 'chat') {
      inputRef.current.focus();
    }
  }, [loading, phase]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    sendMessage(input.trim(), messages);
  };

  const handleModelChange = (e) => {
    const [prov, mod] = e.target.value.split(':');
    setSelectedProvider(prov);
    setSelectedModel(mod);
  };

  const [copiedIdx, setCopiedIdx] = useState(null);

  // Copy just the HTML email as rich text (for pasting into email clients)
  const handleCopyHtml = async (htmlCode, msgIdx) => {
    try {
      const htmlBlob = new Blob([htmlCode], { type: 'text/html' });
      // Also create a plain-text fallback by stripping tags
      const tmp = document.createElement('div');
      tmp.innerHTML = htmlCode;
      const plainText = tmp.textContent || tmp.innerText || '';
      const textBlob = new Blob([plainText], { type: 'text/plain' });

      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob,
        }),
      ]);
      setCopiedIdx(msgIdx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      navigator.clipboard.writeText(htmlCode).catch(() => {});
      setCopiedIdx(msgIdx);
      setTimeout(() => setCopiedIdx(null), 2000);
    }
  };

  const handleCopyResponse = async (text, msgIdx) => {
    try {
      // Check if the response contains HTML tags
      const hasHtml = /<[a-z][\s\S]*>/i.test(text);

      if (hasHtml) {
        // Extract the HTML portion (between first < and last >)
        const htmlMatch = text.match(/([\s\S]*<\/[a-z]+>)/i);
        const htmlContent = htmlMatch ? htmlMatch[0] : text;

        // Copy as both HTML (for rich paste in email clients) and plain text
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const textBlob = new Blob([text], { type: 'text/plain' });
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': blob,
            'text/plain': textBlob,
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }

      setCopiedIdx(msgIdx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      // Fallback to plain text
      navigator.clipboard.writeText(text).catch(() => {});
      setCopiedIdx(msgIdx);
      setTimeout(() => setCopiedIdx(null), 2000);
    }
  };

  // Can only start if we have files (either from Drive or uploaded)
  const canStart = selectedPreset && totalFiles > 0 && !driveLoading;

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-panel__header">
        <span className="chat-panel__title">🤖 AI Assistant</span>
        <div className="chat-panel__header-controls">
          <select
            className="chat-panel__model-select"
            value={`${selectedProvider}:${selectedModel}`}
            onChange={handleModelChange}
            disabled={phase === 'chat'}
          >
            {models.map((m) => (
              <option
                key={`${m.provider}:${m.model}`}
                value={`${m.provider}:${m.model}`}
              >
                {m.label}
              </option>
            ))}
          </select>
          <button
            className="btn btn--icon chat-panel__close"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Phase 1: Prompt Picker ── */}
      {phase === 'pick' && (
        <div className="chat-panel__picker">
          {/* Function selector */}
          <div className="chat-picker__section">
            <div className="chat-picker__label">What would you like AI to do?</div>
            <div className="chat-picker__presets">
              {PROMPT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`chat-picker__preset ${selectedPreset === preset.id ? 'chat-picker__preset--active' : ''}`}
                  onClick={() => setSelectedPreset(preset.id)}
                >
                  <span className="chat-picker__preset-icon">{preset.icon}</span>
                  <div className="chat-picker__preset-text">
                    <div className="chat-picker__preset-label">{preset.label}</div>
                    <div className="chat-picker__preset-desc">{preset.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* System Prompt (shown when a preset is selected) */}
          {selectedPreset && (
            <div className="chat-picker__section">
              <div className="chat-picker__prompt-header">
                <div className="chat-picker__label">
                  System Prompt
                  <span className="chat-picker__label-hint"> (customize if needed)</span>
                </div>
                <button
                  className="btn btn--small chat-picker__toggle-prompt"
                  onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                >
                  {showSystemPrompt ? '▲ Hide' : '▼ Show & Edit'}
                </button>
              </div>
              {showSystemPrompt && (
              <textarea
                  className="chat-picker__system-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={8}
                  placeholder="Enter system prompt..."
                />
              )}
            </div>
          )}

          {/* Solicitation Files from Drive */}
          {selectedPreset && (
          <div className="chat-picker__section">
            <div className="chat-picker__label">
                📁 Solicitation Files
              </div>

              {/* Drive loading */}
              {driveLoading && (
                <div className="chat-picker__drive-status chat-picker__drive-status--loading">
                  <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  <span>Loading files from Google Drive…</span>
                </div>
              )}

              {/* Drive error */}
              {driveError && !driveLoading && (
                <div className="chat-picker__drive-status chat-picker__drive-status--error">
                  ⚠️ {driveError}
                </div>
              )}

              {/* No drive link available */}
              {!driveLink && !driveLoading && (
                <div className="chat-picker__drive-status chat-picker__drive-status--warning">
                  📂 No Google Drive link found for this solicitation.
                </div>
              )}

              {/* Drive files loaded successfully */}
              {!driveLoading && driveFileCount > 0 && (
                <div className="chat-picker__drive-files">
                  <div className="chat-picker__drive-files-header">
                    ✅ {driveFileCount} file{driveFileCount !== 1 ? 's' : ''} loaded from Google Drive
                    {isGemini && <span style={{ fontSize: '0.85em', opacity: 0.7 }}> (native attachment)</span>}
                  </div>
                  <div className="chat-picker__files">
                    {(isGemini ? driveFiles : driveFilesContent).map((df) => (
                      <div key={df.id} className="chat-picker__file chat-picker__file--drive">
                        <span className="chat-picker__file-name">📄 {df.name}</span>
                        {df.error && (
                          <span className="chat-picker__file-error" title={df.error}>⚠️</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Warning: no files at all */}
              {hasNoFiles && selectedPreset && !driveLoading && !driveError && (
                <div className="chat-picker__no-files-warning">
                  <div className="chat-picker__no-files-icon">⚠️</div>
                  <div className="chat-picker__no-files-text">
                    <strong>No solicitation files found.</strong>
                    <p>Please upload all the solicitation/contract files below before running the AI analysis.</p>
                  </div>
                </div>
              )}

              {/* Manual file uploads */}
              <div className="chat-picker__upload-section">
                <div className="chat-picker__label-small">
                  {driveFilesContent.length > 0
                    ? 'Upload additional files (optional)'
                    : 'Upload solicitation files'
                  }
            </div>
            <div className="chat-picker__files">
              {attachedFiles.map((af, idx) => (
                <div key={idx} className="chat-picker__file">
                  <span className="chat-picker__file-name">📎 {af.name}</span>
                  <button
                    className="chat-picker__file-remove"
                    onClick={() => removeFile(idx)}
                    title="Remove file"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="btn btn--small chat-picker__add-file"
                onClick={() => fileInputRef.current?.click()}
              >
                + Add File
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
            </div>
          </div>
            </div>
          )}

          {/* Go button */}
          <div className="chat-picker__actions">
            {hasNoFiles && selectedPreset && !driveLoading && (
              <span className="chat-picker__actions-hint">
                Upload files to continue
              </span>
            )}
            <button
              className="btn btn--tonal chat-picker__go"
              onClick={handleStartChat}
              disabled={!canStart}
            >
              🚀 Start Analysis
            </button>
          </div>
        </div>
      )}

      {/* ── Phase 2: Chat ── */}
      {phase === 'chat' && (
        <>
          <div className="chat-panel__messages">
            {messages
              .filter((m) => m.role !== 'system')
              .map((msg, i) => (
                <div key={i} className={`chat-bubble chat-bubble--${msg.role}`}>
                  <div className="chat-bubble__label">
                    {msg.role === 'user' ? '👤 You' : '🤖 AI'}
                  </div>
                  <div className="chat-bubble__content">
                    {msg.role === 'assistant' ? (
                      <AiMessageContent
                        content={msg.content}
                        onCopyHtml={(html) => handleCopyHtml(html, i)}
                        driveFiles={driveFiles}
                      />
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.role === 'assistant' && (
                    <button
                      className="chat-bubble__insert-btn"
                      onClick={() => handleCopyResponse(msg.content, i)}
                      title="Copy full response to clipboard"
                    >
                      {copiedIdx === i ? '✅ Copied!' : '📋 Copy All'}
                    </button>
                  )}
                </div>
              ))}

            {loading && (
              <div className="chat-bubble chat-bubble--assistant">
                <div className="chat-bubble__label">🤖 AI</div>
                <div className="chat-bubble__content chat-bubble__typing">
                  <span
                    className="spinner spinner--small"
                    style={{ width: 14, height: 14, borderWidth: 2 }}
                  />
                  Thinking…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form className="chat-panel__input-bar" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="chat-panel__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a follow-up…"
              disabled={loading}
            />
            <button
              type="submit"
              className="btn btn--tonal btn--small"
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
