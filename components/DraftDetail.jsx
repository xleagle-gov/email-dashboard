'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { updateDraft, sendDraft, deleteDraft } from '@/lib/api';

/* ------------------------------------------------------------------ */
/*  HtmlIframe – renders HTML in a sandboxed iframe that auto-sizes   */
/* ------------------------------------------------------------------ */
function HtmlIframe({ html, minHeight = 200 }) {
  const ref = useRef(null);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe || !html) return;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    const wrapped = html.trim().startsWith('<!') || html.trim().startsWith('<html')
      ? html
      : `<!DOCTYPE html><html><head><style>
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1f1f1f;margin:0;padding:16px;word-wrap:break-word}
a{color:#1967d2}img{max-width:100%;height:auto}table{max-width:100%}
blockquote{border-left:3px solid #ddd;margin:8px 0;padding:4px 12px;color:#666}
pre{white-space:pre-wrap;font-size:13px;background:#f5f5f5;padding:8px;border-radius:4px}
</style></head><body>${html}</body></html>`;

    doc.open();
    doc.write(wrapped);
    doc.close();

    const resize = () => {
      try {
        const h = doc.documentElement?.scrollHeight || doc.body?.scrollHeight || minHeight;
        iframe.style.height = Math.max(h + 20, minHeight) + 'px';
      } catch { /* cross-origin */ }
    };
    setTimeout(resize, 80);
    setTimeout(resize, 400);

    const imgs = doc.querySelectorAll('img');
    if (imgs.length) {
      let n = 0;
      imgs.forEach(i => {
        i.addEventListener('load', () => { if (++n >= imgs.length) resize(); });
        i.addEventListener('error', () => { if (++n >= imgs.length) resize(); });
      });
    }
  }, [html, minHeight]);

  if (!html) return <p style={{ color: 'var(--color-text-tertiary)', padding: 16 }}>(empty draft)</p>;

  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      title="Draft email content"
      className="draft-body-iframe"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  DraftBodyEditor – TipTap WYSIWYG editor (Gmail-style)            */
/* ------------------------------------------------------------------ */
function DraftBodyEditor({ content, onChange }) {
  // Track what content has been synced to avoid re-applying on user typing
  const lastSynced = useRef(content);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: 'Write your email here...' }),
    ],
    content: content || '',
    editorProps: {
      attributes: { class: 'compose-editor__tiptap' },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      lastSynced.current = html;
      onChange(html);
    },
  });

  // Sync external content changes (e.g. AI apply) into the editor
  useEffect(() => {
    if (editor && content !== lastSynced.current) {
      lastSynced.current = content;
      editor.commands.setContent(content || '', false);
      const normalised = editor.getHTML();
      lastSynced.current = normalised;
      onChange(normalised);
    }
  }, [content, editor, onChange]);

  if (!editor) return null;

  return (
    <div className="draft-compose">
      <div className="draft-compose__body">
        <EditorContent editor={editor} />
      </div>
      <div className="draft-compose__toolbar">
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBold().run()} title="Bold (Ctrl+B)">
          <strong>B</strong></button>
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic (Ctrl+I)">
          <em>I</em></button>
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('underline') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline (Ctrl+U)">
          <u>U</u></button>
        <span className="compose-toolbar-sep" />
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">•≡</button>
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">1.</button>
        <span className="compose-toolbar-sep" />
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Quote">❝</button>
        <button type="button" className="compose-toolbar-btn"
          onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">─</button>
        <span className="compose-toolbar-sep" />
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading">H</button>
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('link') ? 'active' : ''}`}
          onClick={() => {
            const url = window.prompt('Enter URL');
            if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
          }} title="Insert link">🔗</button>
        <button type="button" className={`compose-toolbar-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Code block">{'</>'}</button>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  DraftDetail – Gmail-style draft viewer / editor with AI           */
/* ================================================================== */
const OPT_OUT_LINE = "If these sorts of requests aren't a fit, reply and we'll remove you from future quote requests.";

const DEFAULT_SIGNATURES = {
  'abhiram@vsmflows.com': 'Thanks,\nAbhiram Koganti\nChief Operating Officer\nVSM\n(832)380-5845\n\u{1F4CD} 2021 Guadalupe St, Suite 260, Austin, TX 78705\nhttps://www.vsmflows.com/',
};

export default function DraftDetail({
  draft,
  visible,
  onBack,
  onDraftUpdated,
  onDraftDeleted,
  accounts,
  signatures,
  aiJob,
  onStartAiFormat,
  onDismissAiJob,
}) {
  const [editing, setEditing] = useState(true);
  const [editTo, setEditTo] = useState('');
  const [editBcc, setEditBcc] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);
  const [aiAppliedForJob, setAiAppliedForJob] = useState(null);

  useEffect(() => {
    if (draft) {
      setEditTo(draft.to || '');
      setEditBcc(draft.bcc || '');
      setEditSubject(draft.subject || '');
      setEditBody(draft.body_html || draft.body_plain || '');
      setEditing(false);
      setActionMessage(null);
    }
  }, [draft?.draftId]);

  const showMessage = useCallback((msg, type = 'success') => {
    setActionMessage({ text: msg, type });
    setTimeout(() => setActionMessage(null), 5000);
  }, []);

  // Auto-apply AI result when the job completes
  useEffect(() => {
    if (aiJob && !aiJob.loading && aiJob.html && aiAppliedForJob !== aiJob.draftId) {
      setEditBody(aiJob.html);
      setEditing(true);
      setAiAppliedForJob(aiJob.draftId);
      showMessage('AI formatting applied! Review and Send when ready.');
      if (onDismissAiJob) onDismissAiJob(aiJob.draftId);
    } else if (aiJob && !aiJob.loading && aiJob.error && aiAppliedForJob !== aiJob.draftId) {
      setAiAppliedForJob(aiJob.draftId);
      showMessage(aiJob.error, 'error');
      if (onDismissAiJob) onDismissAiJob(aiJob.draftId);
    }
  }, [aiJob, aiAppliedForJob, showMessage, onDismissAiJob]);

  /* ---------- Empty state ---------- */
  if (!draft) {
    return (
      <div className={`email-detail ${visible ? 'email-detail--visible' : ''}`}>
        <div className="draft-detail__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
            style={{ width: 64, height: 64, opacity: 0.3, marginBottom: 16 }}>
            <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <p style={{ fontWeight: 700, fontSize: '1.15rem' }}>Select a draft</p>
          <p style={{ color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Choose a draft from the list to view and edit it.
          </p>
        </div>
      </div>
    );
  }

  const accountSig = signatures?.[draft.account] || DEFAULT_SIGNATURES[draft.account] || '';

  /* ---------- Actions ---------- */
  const handleSave = async () => {
    setSaving(true);
    try {
      await updateDraft({
        draftId: draft.draftId,
        account: draft.account,
        htmlBody: editBody,
      });
      showMessage('Draft saved successfully!');
      setEditing(false);
      if (onDraftUpdated) onDraftUpdated();
    } catch (err) {
      console.error('Failed to save draft:', err);
      showMessage('Failed to save draft.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSend = async () => {
    if (!confirm('Send this draft now?')) return;
    setSending(true);
    try {
      // Auto-save current content first so Gmail has exactly what the user sees
      await updateDraft({
        draftId: draft.draftId,
        account: draft.account,
        htmlBody: editBody,
      });
      await sendDraft(draft.draftId, draft.account);
      showMessage('Draft sent successfully!');
      if (onDraftDeleted) onDraftDeleted(draft.draftId);
    } catch (err) {
      console.error('Failed to send draft:', err);
      showMessage('Failed to send draft.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this draft permanently?')) return;
    setDeleting(true);
    try {
      await deleteDraft(draft.draftId, draft.account);
      showMessage('Draft deleted.');
      if (onDraftDeleted) onDraftDeleted(draft.draftId);
    } catch (err) {
      console.error('Failed to delete draft:', err);
      showMessage('Failed to delete draft.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  /* ---------- Signature + Opt-out ---------- */
  const handleAddSignatureAndOptOut = () => {
    const body = editing ? editBody : (draft.body_html || draft.body_plain || '');
    let appendHtml = '';
    appendHtml += `<p>${OPT_OUT_LINE}</p>`;
    const sig = accountSig;
    if (sig) {
      const lines = sig.split('\n').filter(Boolean);
      appendHtml += '<hr>';
      appendHtml += '<p>' + lines.join('<br>') + '</p>';
    }
    const newBody = body + appendHtml;
    setEditBody(newBody);
    if (!editing) setEditing(true);
    showMessage('Signature & opt-out line added. Click Save to update.');
  };

  /* ---------- One-click AI Format (parallel, parent-managed) ---------- */
  const handleAiFormat = () => {
    if (!onStartAiFormat || !draft) return;
    const body = editing ? editBody : (draft.body_html || draft.body_plain || '');
    onStartAiFormat(draft.draftId, draft.subject, draft.account, draft.to, body, accountSig);
  };

  // Always use editBody for viewing — it's initialized from draft data and
  // kept up-to-date by the editor / AI apply, so it survives save -> view toggle
  const viewBody = editBody || draft.body_html || draft.body_plain || '';

  /* ---------- Render ---------- */
  return (
    <div className={`email-detail ${visible ? 'email-detail--visible' : ''}`}>
      {/* Toast */}
      {actionMessage && (
        <div className={`draft-action-toast draft-action-toast--${actionMessage.type}`}>
          {actionMessage.type === 'success' ? '✅' : '⚠️'} {actionMessage.text}
        </div>
      )}

      {/* Gmail-style compose card */}
      <div className="draft-gmail-card">
        {/* Title bar */}
        <div className="draft-gmail-card__titlebar">
          <button className="btn btn--icon" onClick={onBack} title="Back" style={{ color: '#fff' }}>←</button>
          <span className="draft-gmail-card__title">{draft.subject || '(no subject)'}</span>
          <div className="draft-gmail-card__titlebar-actions">
            {!editing ? (
              <button className="btn btn--small draft-gmail-card__action" onClick={() => setEditing(true)}>✏️ Edit</button>
            ) : (
              <button className="btn btn--small draft-gmail-card__action" onClick={() => setEditing(false)}>✕ Cancel</button>
            )}
          </div>
        </div>

        {/* Header fields */}
        <div className="draft-gmail-card__fields">
          <div className="draft-gmail-card__field">
            <label>From</label>
            <span className="draft-gmail-card__field-value">{draft.account}</span>
          </div>
          {editing ? (
            <>
              <div className="draft-gmail-card__field">
                <label>To</label>
                <input type="text" value={editTo} onChange={e => setEditTo(e.target.value)}
                  placeholder="Recipients" className="draft-gmail-card__input" />
              </div>
              <div className="draft-gmail-card__field">
                <label>BCC</label>
                <input type="text" value={editBcc} onChange={e => setEditBcc(e.target.value)}
                  placeholder="BCC recipients (optional)" className="draft-gmail-card__input" />
              </div>
              <div className="draft-gmail-card__field">
                <label>Subject</label>
                <input type="text" value={editSubject} onChange={e => setEditSubject(e.target.value)}
                  placeholder="Subject" className="draft-gmail-card__input" />
              </div>
            </>
          ) : (
            <>
              <div className="draft-gmail-card__field">
                <label>To</label>
                <span className="draft-gmail-card__field-value">{draft.to || '(no recipient)'}</span>
              </div>
              {editBcc && (
                <div className="draft-gmail-card__field">
                  <label>BCC</label>
                  <span className="draft-gmail-card__field-value">{editBcc}</span>
                </div>
              )}
              <div className="draft-gmail-card__field">
                <label>Subject</label>
                <span className="draft-gmail-card__field-value">{draft.subject || '(no subject)'}</span>
              </div>
            </>
          )}
        </div>

        {/* Body */}
        <div className="draft-gmail-card__body">
          {editing ? (
            <DraftBodyEditor content={editBody} onChange={setEditBody} />
          ) : (
            <HtmlIframe html={viewBody} minHeight={250} />
          )}
        </div>

        {/* Attachments */}
        {draft.attachments && draft.attachments.length > 0 && (
          <div className="draft-gmail-card__attachments">
            {draft.attachments.map((att, i) => (
              <div key={i} className="draft-gmail-card__attachment">
                <span>📎</span>
                <span className="draft-gmail-card__attachment-name">{att.filename}</span>
                <span className="draft-gmail-card__attachment-size">
                  {att.size ? `${(att.size / 1024).toFixed(1)} KB` : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Footer actions */}
        <div className="draft-gmail-card__footer">
          <div className="draft-gmail-card__footer-left">
            {editing && (
              <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
                {saving ? '💾 Saving…' : '💾 Save Draft'}
              </button>
            )}
            <button className="btn btn--success" onClick={handleSend} disabled={sending}>
              {sending ? '📤 Sending…' : '📤 Send'}
            </button>
            <button className="btn btn--ai-format" onClick={handleAiFormat} disabled={aiJob?.loading}
              title="One-click AI format — instantly formats and applies to editor">
              {aiJob?.loading ? '⏳ Formatting…' : '🤖 Ask AI'}
            </button>
            <button className="btn btn--tonal" onClick={handleAddSignatureAndOptOut}
              title="Append signature and opt-out line to the draft">
              ✍ Sig + Opt-out
            </button>
          </div>
          <div className="draft-gmail-card__footer-right">
            <button className="btn btn--danger btn--small" onClick={handleDelete} disabled={deleting} title="Delete draft">
              {deleting ? '🗑' : '🗑'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
