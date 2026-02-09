'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { fetchDriveFiles } from '@/lib/api';

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
 *   driveAttachments – [{id, name, mimeType}] from AI recommendations (auto-attached from Drive)
 *   driveLink     – Google Drive folder URL (enables "Attach from Drive" picker)
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
  driveAttachments: initialDriveAttachments = [],
  driveLink = null,
}) {
  const [account, setAccount] = useState(defaultAccount);
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [attachments, setAttachments] = useState([]); // File[]
  const [driveAttachments, setDriveAttachments] = useState(initialDriveAttachments); // [{id, name, mimeType}]
  const fileInputRef = useRef(null);

  // Drive file picker state
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [driveFileList, setDriveFileList] = useState([]); // all files in Drive folder
  const [driveFileListLoading, setDriveFileListLoading] = useState(false);
  const [driveFileListError, setDriveFileListError] = useState(null);
  const [driveFileListLoaded, setDriveFileListLoaded] = useState(false);
  const drivePickerRef = useRef(null);

  // Determine if driveLink is valid
  const hasDriveLink = driveLink && driveLink.startsWith('http');

  // Close picker when clicking outside
  useEffect(() => {
    if (!drivePickerOpen) return;
    const handleClickOutside = (e) => {
      if (drivePickerRef.current && !drivePickerRef.current.contains(e.target)) {
        setDrivePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [drivePickerOpen]);

  // Load Drive files when picker is first opened
  const handleOpenDrivePicker = useCallback(async () => {
    if (drivePickerOpen) {
      setDrivePickerOpen(false);
      return;
    }
    setDrivePickerOpen(true);

    if (driveFileListLoaded || driveFileListLoading) return;

    setDriveFileListLoading(true);
    setDriveFileListError(null);
    try {
      const result = await fetchDriveFiles(driveLink);
      setDriveFileList(result.files || []);
      setDriveFileListLoaded(true);
      if ((result.files || []).length === 0) {
        setDriveFileListError('No files found in the Drive folder.');
      }
    } catch (err) {
      console.error('Failed to load Drive files:', err);
      setDriveFileListError('Failed to load Drive files.');
    } finally {
      setDriveFileListLoading(false);
    }
  }, [driveLink, drivePickerOpen, driveFileListLoaded, driveFileListLoading]);

  // Check if a Drive file is already attached
  const isDriveFileAttached = useCallback((fileId) => {
    return driveAttachments.some((da) => da.id === fileId);
  }, [driveAttachments]);

  // Toggle a Drive file on/off
  const toggleDriveFile = useCallback((file) => {
    setDriveAttachments((prev) => {
      const exists = prev.some((da) => da.id === file.id);
      if (exists) {
        return prev.filter((da) => da.id !== file.id);
      }
      return [...prev, { id: file.id, name: file.name, mimeType: file.mimeType || '' }];
    });
  }, []);

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

  const handleRemoveDriveFile = useCallback((idx) => {
    setDriveAttachments(prev => prev.filter((_, i) => i !== idx));
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
      driveFileIds: driveAttachments,
    };
  }, [account, to, subject, editor, threadId, messageId, attachments, driveAttachments]);

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

      {/* Attachments (local + Drive) */}
      {(attachments.length > 0 || driveAttachments.length > 0) && (
        <div className="compose-editor__attachments">
          {/* Drive files — will be fetched server-side from Google Drive */}
          {driveAttachments.map((df, idx) => (
            <div key={`drive-${df.id}-${idx}`} className="compose-attachment compose-attachment--drive">
              <span className="compose-attachment__icon">☁️</span>
              <span className="compose-attachment__name">{df.name}</span>
              <span className="compose-attachment__badge">Drive</span>
              <button
                className="compose-attachment__remove"
                onClick={() => handleRemoveDriveFile(idx)}
                title="Remove Drive attachment"
              >
                ✕
              </button>
            </div>
          ))}
          {/* Local file uploads */}
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
            title="Attach local files"
          >
            📎 Attach
          </button>

          {/* Attach from Drive — only shown when there's a linked solicitation with Drive folder */}
          {hasDriveLink && (
            <div className="compose-drive-picker" ref={drivePickerRef}>
              <button
                className={`btn btn--small ${drivePickerOpen ? 'btn--tonal' : ''}`}
                onClick={handleOpenDrivePicker}
                title="Attach files from Google Drive solicitation folder"
              >
                ☁️ Drive Files
              </button>

              {drivePickerOpen && (
                <div className="compose-drive-picker__dropdown">
                  <div className="compose-drive-picker__header">
                    📁 Solicitation Files
                  </div>

                  {driveFileListLoading && (
                    <div className="compose-drive-picker__loading">
                      <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
                      Loading files…
                    </div>
                  )}

                  {driveFileListError && (
                    <div className="compose-drive-picker__error">{driveFileListError}</div>
                  )}

                  {driveFileListLoaded && driveFileList.length > 0 && (
                    <div className="compose-drive-picker__list">
                      {driveFileList.map((file) => {
                        const attached = isDriveFileAttached(file.id);
                        return (
                          <button
                            key={file.id}
                            className={`compose-drive-picker__item ${attached ? 'compose-drive-picker__item--selected' : ''}`}
                            onClick={() => toggleDriveFile(file)}
                            title={attached ? 'Click to remove' : 'Click to attach'}
                          >
                            <span className="compose-drive-picker__check">
                              {attached ? '✅' : '⬜'}
                            </span>
                            <span className="compose-drive-picker__filename">{file.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {driveAttachments.length > 0 && (
                    <div className="compose-drive-picker__footer">
                      {driveAttachments.length} file{driveAttachments.length !== 1 ? 's' : ''} selected
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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
