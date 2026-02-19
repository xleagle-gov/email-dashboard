'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { fetchAIModels, chatWithAI } from '@/lib/api';

/* ── Default system prompt for draft formatting ── */
const DEFAULT_DRAFT_PROMPT = `You are an AI assistant helping format and improve a draft email for a government contracting company.

Please:
1. Fix grammar, spelling, and punctuation
2. Improve professional tone and clarity
3. Keep the original intent, information, and meaning intact
4. Output the improved email as HTML wrapped in \`\`\`html fences

IMPORTANT — Gmail HTML constraints (this email will be sent through Gmail):
- Use ONLY simple inline styles if needed (no <style> blocks, no CSS classes)
- Use simple elements: <p>, <br>, <b>, <strong>, <em>, <i>, <ul>, <ol>, <li>, <a>, <table>
- NO divs with complex styling, no flexbox, no grid
- Keep formatting minimal and clean — Gmail strips most advanced CSS
- Use <br> for line breaks within a section, <p> for paragraph separation

SIGNATURE & OPT-OUT LINE:
- The account's signature and opt-out line are provided below the draft.
- If the draft does NOT already contain the opt-out line, add it near the end of the email BEFORE the signature.
- If the draft does NOT already contain the signature, add it at the very end.
- Do NOT duplicate them if they already exist in the draft.
- The opt-out line should appear as a normal paragraph, not in a special style.`;

/**
 * Extract HTML code from AI response text (from ```html fences).
 */
function extractHtmlFromResponse(text) {
  const match = text.match(/```html\s*\n?([\s\S]*?)\n?```/i);
  return match ? match[1].trim() : null;
}

/**
 * Render AI message content with rendered HTML preview + "Apply to Draft" button.
 */
function DraftAiMessageContent({ content, onApplyHtml }) {
  const parts = content.split(/(```html[\s\S]*?```)/gi);
  const hasHtml = parts.length > 1;

  if (!hasHtml) {
    return <div className="chat-bubble__text" style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
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
                <span className="chat-bubble__html-label">📧 Formatted Email</span>
                <button
                  className="btn btn--primary btn--small"
                  onClick={() => onApplyHtml(htmlCode)}
                  title="Apply this HTML to the draft editor"
                >
                  ✅ Apply to Draft
                </button>
              </div>
              <div
                className="chat-bubble__html-preview"
                dangerouslySetInnerHTML={{ __html: htmlCode }}
              />
            </div>
          );
        }
        if (!part.trim()) return null;
        return (
          <div key={idx} className="chat-bubble__text" style={{ whiteSpace: 'pre-wrap' }}>
            {part}
          </div>
        );
      })}
    </div>
  );
}

/**
 * DraftChatPanel – simplified AI panel for drafts.
 *
 * Props:
 *   draftContext   – { subject, to, from, body, signature, optOutLine }
 *   onApplyHtml   – (htmlString) => void — apply formatted HTML to the editor
 *   onClose       – () => void
 *   autoStart     – if true, skip setup and immediately run analysis + auto-apply
 */
export default function DraftChatPanel({ draftContext, onApplyHtml, onClose, autoStart = false }) {
  const [phase, setPhase] = useState(autoStart ? 'chat' : 'setup');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DRAFT_PROMPT);
  const [showPrompt, setShowPrompt] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('gemini');
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
  const [models, setModels] = useState([]);
  const [autoApplied, setAutoApplied] = useState(false);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const hasAutoStarted = useRef(false);
  const shouldAutoApply = useRef(autoStart);

  // Build the context message with draft content + signature + opt-out
  const buildContextMessage = useCallback(() => {
    const ctx = draftContext || {};
    let text = `Here is the draft email to format:\n\n`;
    text += `Subject: ${ctx.subject || '(no subject)'}\n`;
    text += `To: ${ctx.to || '(no recipient)'}\n`;
    text += `From: ${ctx.from || ''}\n\n`;
    text += ctx.body || '(empty draft)';

    if (ctx.signature) {
      text += `\n\n---\nSIGNATURE FOR THIS ACCOUNT:\n${ctx.signature}`;
    }

    if (ctx.optOutLine) {
      text += `\n\nOPT-OUT LINE:\n${ctx.optOutLine}`;
    }

    return text;
  }, [draftContext]);

  // Run analysis (shared by autoStart and manual Start Analysis button)
  const runAnalysis = useCallback(async (prompt, provider, model) => {
    const finalPrompt = prompt.trim() || 'You are a helpful email formatting assistant.';
    const contextMessage = buildContextMessage();

    const initialMessages = [
      { role: 'system', content: finalPrompt },
      { role: 'user', content: contextMessage },
    ];

    setMessages(initialMessages);
    setPhase('chat');
    setLoading(true);

    try {
      const { reply } = await chatWithAI(initialMessages, provider, model);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);

      // Auto-apply the first AI response directly to the editor
      if (shouldAutoApply.current) {
        shouldAutoApply.current = false;
        const html = extractHtmlFromResponse(reply);
        if (html) {
          onApplyHtml(html);
          setAutoApplied(true);
        }
      }
    } catch (err) {
      console.error('AI error:', err);
      const detail = err?.response?.data?.details || err?.response?.data?.error || '';
      const isRateLimit = detail.toLowerCase().includes('rate-limit') || detail.includes('429');
      const errorMsg = isRateLimit
        ? '⚠️ All API keys are currently rate-limited. Please wait about a minute and try again.'
        : `⚠️ Failed to get a response. ${detail || 'Please try again.'}`;
      setMessages(prev => [...prev, { role: 'assistant', content: errorMsg }]);
    } finally {
      setLoading(false);
    }
  }, [buildContextMessage, onApplyHtml]);

  // Load available models, then auto-start if needed
  useEffect(() => {
    fetchAIModels()
      .then((m) => {
        setModels(m);
        const prov = m.length > 0 ? m[0].provider : 'gemini';
        const mod = m.length > 0 ? m[0].model : 'gemini-3-flash-preview';
        setSelectedProvider(prov);
        setSelectedModel(mod);

        // Auto-start analysis immediately after models load
        if (autoStart && !hasAutoStarted.current) {
          hasAutoStarted.current = true;
          runAnalysis(DEFAULT_DRAFT_PROMPT, prov, mod);
        }
      })
      .catch(() => {
        setModels([{ provider: 'gemini', model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' }]);
        if (autoStart && !hasAutoStarted.current) {
          hasAutoStarted.current = true;
          runAnalysis(DEFAULT_DRAFT_PROMPT, 'gemini', 'gemini-3-flash-preview');
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when AI finishes
  useEffect(() => {
    if (!loading && inputRef.current && phase === 'chat') {
      inputRef.current.focus();
    }
  }, [loading, phase]);

  const handleModelChange = (e) => {
    const [prov, mod] = e.target.value.split(':');
    setSelectedProvider(prov);
    setSelectedModel(mod);
  };

  const handleStartAnalysis = () => {
    runAnalysis(systemPrompt, selectedProvider, selectedModel);
  };

  // Send follow-up
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    const text = input.trim();
    setInput('');

    const userMsg = { role: 'user', content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setLoading(true);

    try {
      const { reply } = await chatWithAI(updated, selectedProvider, selectedModel);
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      console.error('AI follow-up error:', err);
      const detail = err?.response?.data?.details || err?.response?.data?.error || '';
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ Error: ${detail || 'Please try again.'}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="draft-chat-panel">
      {/* Header */}
      <div className="draft-chat-panel__header">
        <span className="draft-chat-panel__title">🤖 AI Draft Assistant</span>
        <div className="draft-chat-panel__header-controls">
          {phase === 'setup' && (
            <select
              className="chat-panel__model-select"
              value={`${selectedProvider}:${selectedModel}`}
              onChange={handleModelChange}
            >
              {models.map((m) => (
                <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn--icon" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Auto-applied banner */}
      {autoApplied && (
        <div className="draft-chat-panel__auto-applied">
          ✅ Formatted email has been applied to the editor. Send follow-ups below to refine.
        </div>
      )}

      {/* ── Setup phase (only shown if not autoStart) ── */}
      {phase === 'setup' && (
        <div className="draft-chat-panel__setup">
          <div className="draft-chat-panel__prompt-section">
            <div className="draft-chat-panel__prompt-header">
              <span className="draft-chat-panel__label">
                Format Prompt
                <span style={{ fontWeight: 400, opacity: 0.6 }}> (customize if needed)</span>
              </span>
              <button
                className="btn btn--small"
                onClick={() => setShowPrompt(!showPrompt)}
              >
                {showPrompt ? '▲ Hide' : '▼ Show & Edit'}
              </button>
            </div>
            {showPrompt && (
              <textarea
                className="draft-chat-panel__prompt-textarea"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={10}
              />
            )}
          </div>

          <div className="draft-chat-panel__context-info">
            <span>📄 Draft:</span> {draftContext?.subject || '(no subject)'}
            {draftContext?.signature && <span className="draft-chat-panel__context-tag">✓ Signature</span>}
            {draftContext?.optOutLine && <span className="draft-chat-panel__context-tag">✓ Opt-out</span>}
          </div>

          <button
            className="btn btn--primary draft-chat-panel__start"
            onClick={handleStartAnalysis}
            disabled={loading}
          >
            🚀 Start Analysis
          </button>
        </div>
      )}

      {/* ── Chat phase ── */}
      {phase === 'chat' && (
        <>
          <div className="draft-chat-panel__messages">
            {messages
              .filter((m) => m.role !== 'system')
              .map((msg, i) => (
                <div key={i} className={`chat-bubble chat-bubble--${msg.role}`}>
                  <div className="chat-bubble__label">
                    {msg.role === 'user' ? '👤 You' : '🤖 AI'}
                  </div>
                  <div className="chat-bubble__content">
                    {msg.role === 'assistant' ? (
                      <DraftAiMessageContent
                        content={msg.content}
                        onApplyHtml={onApplyHtml}
                      />
                    ) : (
                      <div className="chat-bubble__text" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden', fontSize: '0.82rem', opacity: 0.7 }}>
                        {msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content}
                      </div>
                    )}
                  </div>
                </div>
              ))}

            {loading && (
              <div className="chat-bubble chat-bubble--assistant">
                <div className="chat-bubble__label">🤖 AI</div>
                <div className="chat-bubble__content chat-bubble__typing">
                  <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  {autoStart && messages.length <= 2 ? 'Formatting your draft…' : 'Thinking…'}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form className="draft-chat-panel__input-bar" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="draft-chat-panel__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a follow-up (e.g. 'make it shorter', 'more formal')…"
              disabled={loading}
            />
            <button type="submit" className="btn btn--tonal btn--small" disabled={loading || !input.trim()}>
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
