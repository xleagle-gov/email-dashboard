'use client';

import { useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

/**
 * Rich-text compose / reply editor.
 *
 * Props:
 *   mode          – 'compose' | 'reply' | 'draft'
 *   accounts      – list of { email, name, authenticated }
 *   defaultAccount – pre-selected account email (for replies)
 *   defaultTo     – pre-filled To address (for replies)
 *   defaultSubject – pre-filled Subject (for replies, e.g. "Re: …")
 *   threadId      – thread ID (for replies / draft-in-thread)
 *   messageId     – message being replied to
 *   onSend        – async (payload) => void   – called when user clicks Send
 *   onSaveDraft   – async (payload) => void   – called when user clicks Save Draft
 *   onCancel      – () => void
 *   sending       – boolean
 */
export default function ComposeEditor({
  mode = 'compose',
  accounts = [],
  defaultAccount = '',
  defaultTo = '',
  defaultSubject = '',
  threadId = null,
  messageId = null,
  onSend,
  onSaveDraft,
  onCancel,
  sending = false,
}) {
  const [account, setAccount] = useState(defaultAccount);
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [attachments, setAttachments] = useState([]); // File[]
  const fileInputRef = useRef(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({
        placeholder: mode === 'reply' ? 'Write your reply…' : 'Compose your email…',
      }),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'compose-editor__tiptap',
      },
    },
  });

  const handleAddFiles = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...files]);
    // Reset so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleRemoveFile = useCallback((idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const buildPayload = useCallback(() => {
    return {
      account,
      to,
      subject,
      htmlBody: editor?.getHTML() || '',
      threadId,
      messageId,
      attachments,
    };
  }, [account, to, subject, editor, threadId, messageId, attachments]);

  const handleSend = async () => {
    if (!to.trim()) return;
    if (onSend) await onSend(buildPayload());
  };

  const handleDraft = async () => {
    if (onSaveDraft) await onSaveDraft(buildPayload());
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (!editor) return null;

  const isReply = mode === 'reply';
  const title = isReply ? 'Reply' : 'New Email';

  return (
    <div className="compose-editor">
      {/* Title bar */}
      <div className="compose-editor__titlebar">
        <span className="compose-editor__title">{title}</span>
        <button className="btn btn--icon compose-editor__close" onClick={onCancel} title="Discard">
          ✕
        </button>
      </div>

      {/* Meta fields */}
      <div className="compose-editor__fields">
        {/* Account selector */}
        <div className="compose-editor__field">
          <label>From</label>
          <select value={account} onChange={e => setAccount(e.target.value)}>
            <option value="">Select account…</option>
            {accounts.filter(a => a.authenticated).map(a => (
              <option key={a.email || a.name} value={a.email || a.name}>
                {a.email || a.name}
              </option>
            ))}
          </select>
        </div>

        <div className="compose-editor__field">
          <label>To</label>
          <input
            type="text"
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="recipient@example.com"
          />
        </div>

        <div className="compose-editor__field">
          <label>Subject</label>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Email subject"
          />
        </div>
      </div>

      {/* Formatting toolbar */}
      <div className="compose-editor__toolbar">
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('underline') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="Underline"
        >
          <u>U</u>
        </button>
        <span className="compose-toolbar-sep" />
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('strike') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('code') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          {'</>'}
        </button>
        <span className="compose-toolbar-sep" />
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          •≡
        </button>
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          1.
        </button>
        <span className="compose-toolbar-sep" />
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote"
        >
          ❝
        </button>
        <button
          type="button"
          className="compose-toolbar-btn"
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Horizontal rule"
        >
          ─
        </button>
        <span className="compose-toolbar-sep" />
        <button
          type="button"
          className={`compose-toolbar-btn ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading"
        >
          H
        </button>
        <button
          type="button"
          className="compose-toolbar-btn"
          onClick={() => {
            const url = window.prompt('Enter URL');
            if (url) {
              editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
            }
          }}
          title="Insert link"
        >
          🔗
        </button>
      </div>

      {/* Editor body */}
      <div className="compose-editor__body">
        <EditorContent editor={editor} />
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="compose-editor__attachments">
          {attachments.map((file, idx) => (
            <div key={`${file.name}-${idx}`} className="compose-attachment">
              <span className="compose-attachment__icon">📎</span>
              <span className="compose-attachment__name">{file.name}</span>
              <span className="compose-attachment__size">{formatFileSize(file.size)}</span>
              <button
                className="compose-attachment__remove"
                onClick={() => handleRemoveFile(idx)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Footer actions */}
      <div className="compose-editor__footer">
        <div className="compose-editor__footer-left">
          <button
            className="btn btn--primary"
            onClick={handleSend}
            disabled={sending || !to.trim() || !account}
          >
            {sending ? (
              <>
                <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
                Sending…
              </>
            ) : (
              <>✈ Send</>
            )}
          </button>
          <button
            className="btn btn--tonal"
            onClick={handleDraft}
            disabled={sending || !account}
          >
            💾 Save Draft
          </button>
        </div>
        <div className="compose-editor__footer-right">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleAddFiles}
            style={{ display: 'none' }}
            id="compose-file-input"
          />
          <button
            className="btn btn--small"
            onClick={() => fileInputRef.current?.click()}
            title="Attach files"
          >
            📎 Attach
          </button>
          <button
            className="btn btn--small"
            onClick={onCancel}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
