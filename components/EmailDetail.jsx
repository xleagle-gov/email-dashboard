'use client';

import { useRef, useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { fetchDomainHistory, sendReply, createDraft, getAttachmentUrl, fetchOpportunity, fetchOpportunitiesBatch, uploadToDrive, createDriveFolder } from '@/lib/api';
import ComposeEditor from './ComposeEditor';
import ChatPanel from './ChatPanel';

/* ---- Deterministic avatar color from sender name ---- */
const AVATAR_COLORS = [
  '#1967d2', '#188038', '#e37400', '#c5221f',
  '#8430ce', '#007b83', '#d01884', '#4285f4',
  '#0d652d', '#b06000',
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h);
}

function getAvatarColor(name) {
  return AVATAR_COLORS[hashName(name || '') % AVATAR_COLORS.length];
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Format byte count to human-readable size */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get a file-type icon based on file extension */
function getFileIcon(filename) {
  if (!filename) return '📄';
  const ext = filename.split('.').pop().toLowerCase();
  const icons = {
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
    ppt: '📙', pptx: '📙', zip: '🗜️', rar: '🗜️', '7z': '🗜️',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mp3: '🎵', wav: '🎵',
    txt: '📄', csv: '📊', json: '📄', xml: '📄', html: '🌐',
  };
  return icons[ext] || '📄';
}

/** Senders to filter out of thread views (bounce notifications, system messages) */
const IGNORED_SENDERS = ['mailer-daemon', 'mail delivery subsystem', 'postmaster'];

function isSystemMessage(msg) {
  const from = (msg.from || '').toLowerCase();
  return IGNORED_SENDERS.some(s => from.includes(s));
}

/** Extract domain from an email address string like "John <john@example.com>" */
function extractDomain(fromStr) {
  if (!fromStr) return null;
  const match = fromStr.match(/@([a-zA-Z0-9.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Right panel – shows the full conversation thread for a selected email.
 */
function EmailDetail({
  email,
  threadMessages,
  threadLoading,
  visible,
  onBack,
  onMarkRead,
  onMarkUnread,
  opportunity,
  accounts = [],
  onThreadRefresh,
  chatManager,
  signatures = {},
}) {
  const detailRef = useRef(null);
  const replyComposeRef = useRef(null);
  const chatPanelRef = useRef(null);
  const composeEditorRef = useRef(null);

  // Domain history state
  const [domainEmails, setDomainEmails] = useState([]);
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainError, setDomainError] = useState(null);
  const [lastFetchedKey, setLastFetchedKey] = useState(null);
  const [domainSearchAccount, setDomainSearchAccount] = useState(null); // which inbox to search

  // Reply state – which message is being replied to
  const [replyToMsg, setReplyToMsg] = useState(null);
  const [replySending, setReplySending] = useState(false);
  const [replySuccess, setReplySuccess] = useState(null);
  const [draftOnlyMode, setDraftOnlyMode] = useState(false);

  // Linked opportunity from domain history (overrides the prop-level `opportunity`)
  const [linkedOpportunity, setLinkedOpportunity] = useState(null);
  // Map of domain-history email index → matched opportunity
  const [domainMatches, setDomainMatches] = useState({});
  const [domainMatchLoading, setDomainMatchLoading] = useState(false);

  // Drive upload state
  const [driveUploading, setDriveUploading] = useState(false);
  const [driveUploadResult, setDriveUploadResult] = useState(null);
  const [driveCreating, setDriveCreating] = useState(false);
  const driveUploadRef = useRef(null);

  // Manual link solicitation state
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSubject, setLinkSubject] = useState('');
  const [linkSearching, setLinkSearching] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const linkInputRef = useRef(null);

  // Scroll to top whenever a new email/thread is selected
  useEffect(() => {
    if (detailRef.current) {
      detailRef.current.scrollTop = 0;
    }
    // Reset domain history and reply state when switching emails
    setDomainOpen(false);
    setDomainEmails([]);
    setDomainError(null);
    setLastFetchedKey(null);
    setDomainSearchAccount(null);
    setReplyToMsg(null);
    setReplySuccess(null);
    setLinkedOpportunity(null);
    setDomainMatches({});
    setDriveUploadResult(null);
    setLinkOpen(false);
    setLinkSubject('');
    setLinkError(null);
  }, [email?.id]);

  // Auto-fetch domain history + auto-link most recent solicitation in background.
  // Runs in parallel with thread loading — doesn't block the UI at all.
  useEffect(() => {
    if (!email?.id || !email?.account || !email?.from) return;
    const domain = extractDomain(email.from);
    if (!domain) return;

    let cancelled = false;
    setDomainLoading(true);

    (async () => {
      try {
        // Step 1: Fetch domain history (background, doesn't block UI)
        const data = await fetchDomainHistory(email.account, domain);
        if (cancelled) return;

        const domEmails = data.emails || [];
        setDomainEmails(domEmails);
        setDomainSearchAccount(email.account);
        setLastFetchedKey(`${email.account}:${domain}`);

        if (domEmails.length === 0) return;

        // Step 2: Batch-match all subjects in ONE request
        const batchInput = domEmails
          .filter(de => de.subject)
          .map(de => ({ id: de.id, subject: de.subject }));

        if (batchInput.length === 0) return;

        const matchMap = await fetchOpportunitiesBatch(batchInput);
        if (cancelled) return;

        // Step 3: Convert batch results to idx-based map for the panel UI
        const matches = {};
        domEmails.forEach((de, idx) => {
          if (de.id && matchMap[de.id]) {
            matches[idx] = matchMap[de.id];
          }
        });
        setDomainMatches(matches);

        // Step 4: Auto-link the most recent solicitation (idx 0 = newest)
        const sortedIdxs = Object.keys(matches).map(Number).sort((a, b) => a - b);
        if (sortedIdxs.length > 0) {
          setLinkedOpportunity(matches[sortedIdxs[0]]);
        }
      } catch (err) {
        console.error('Background domain fetch failed:', err);
        // Silently fail — user can still click the button manually
      } finally {
        if (!cancelled) setDomainLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [email?.id, email?.account, email?.from]);

  if (!email) {
    return (
      <div className={`email-detail ${visible ? 'email-detail--visible' : ''}`}>
        <div className="email-detail__empty">
          <svg
            width="88"
            height="88"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.8"
            style={{ opacity: 0.25 }}
          >
            <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <p style={{ fontWeight: 700, fontSize: '1.25rem', marginTop: 16, color: 'var(--color-text)' }}>
            Select an email to read
          </p>
          <p style={{ color: 'var(--color-text-tertiary)', marginTop: 6, fontSize: '0.9rem' }}>
            Click on an email from the list
          </p>
        </div>
      </div>
    );
  }

  const formatFullDate = (isoDate) => {
    if (!isoDate) return '';
    try {
      return format(parseISO(isoDate), "EEE, MMM d, yyyy 'at' h:mm a");
    } catch {
      return isoDate;
    }
  };

  const formatShortDate = (isoDate) => {
    if (!isoDate) return '';
    try {
      return format(parseISO(isoDate), 'MMM d, yyyy');
    } catch {
      return isoDate;
    }
  };

  const senderDomain = extractDomain(email.from);
  const allMessages = threadMessages && threadMessages.length > 0 ? threadMessages : [email];
  const messages = allMessages.filter(msg => !isSystemMessage(msg));

  // Determine which messages are from our own account (outgoing)
  // and which incoming messages have been directly responded to.
  // Uses the In-Reply-To header so each message is tracked individually —
  // important when multiple people reply in the same thread.
  const accountEmail = (email.account || '').toLowerCase();

  // Build a set of Message-IDs that our outgoing messages directly reply to
  const repliedToIds = new Set();
  messages.forEach(msg => {
    const fromLower = (msg.from || '').toLowerCase();
    if (fromLower.includes(accountEmail) && msg.in_reply_to) {
      repliedToIds.add(msg.in_reply_to);
    }
  });

  const messageStatuses = messages.map((msg) => {
    const fromLower = (msg.from || '').toLowerCase();
    const isOurs = fromLower.includes(accountEmail);
    // An incoming message is "responded to" only if one of our outgoing
    // messages has an In-Reply-To that matches this message's Message-ID
    const hasResponse = !isOurs && msg.message_id_header
      ? repliedToIds.has(msg.message_id_header)
      : false;
    return { isOurs, hasResponse };
  });

  const handleReplyClick = (msg) => {
    setReplyToMsg(msg);
    setReplySuccess(null);
    // Scroll the inline compose editor into view after it renders
    setTimeout(() => {
      if (replyComposeRef.current) {
        replyComposeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  };

  const handleReplySend = async (payload) => {
    setReplySending(true);
    try {
      await sendReply({
        account: payload.account,
        messageId: replyToMsg.id,
        threadId: email.threadId,
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.htmlBody,
        attachments: payload.attachments,
        driveFileIds: payload.driveFileIds || [],
      });
      setReplySuccess('Reply sent successfully!');
      setReplyToMsg(null);
      // Refresh thread to show the new message
      if (onThreadRefresh) onThreadRefresh();
    } catch (err) {
      console.error('Failed to send reply:', err);
      setReplySuccess(null);
      alert('Failed to send reply. Please try again.');
    } finally {
      setReplySending(false);
    }
  };

  const handleReplySaveDraft = async (payload) => {
    setReplySending(true);
    try {
      await createDraft({
        account: payload.account,
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.htmlBody,
        threadId: email.threadId,
        messageId: replyToMsg?.id,
        attachments: payload.attachments,
        driveFileIds: payload.driveFileIds || [],
      });
      setReplySuccess('Draft saved!');
      setReplyToMsg(null);
    } catch (err) {
      console.error('Failed to save draft:', err);
      alert('Failed to save draft. Please try again.');
    } finally {
      setReplySending(false);
    }
  };

  const handleDomainSearch = async (accountOverride) => {
    const searchAcct = accountOverride || domainSearchAccount || email.account;
    if (!senderDomain || !searchAcct) return;

    // Initialize the account selector on first open
    if (!domainSearchAccount) setDomainSearchAccount(searchAcct);

    const fetchKey = `${searchAcct}:${senderDomain}`;

    // If already open and we already fetched for this combo, just toggle
    if (domainOpen && lastFetchedKey === fetchKey && !accountOverride) {
      setDomainOpen(false);
      return;
    }

    // If we already have results for this key, just open
    if (lastFetchedKey === fetchKey && domainEmails.length > 0 && !accountOverride) {
      setDomainOpen(true);
      return;
    }

    setDomainOpen(true);
    setDomainLoading(true);
    setDomainError(null);
    try {
      const data = await fetchDomainHistory(searchAcct, senderDomain);
      const domEmails = data.emails || [];
      setDomainEmails(domEmails);
      setLastFetchedKey(fetchKey);

      // Batch-match domain email subjects against the solicitation spreadsheet
      if (domEmails.length > 0) {
        setDomainMatchLoading(true);
        const matches = {};
        await Promise.all(
          domEmails.map(async (de, idx) => {
            if (!de.subject) return;
            try {
              const result = await fetchOpportunity(de.subject);
              if (result.matched && result.opportunity) {
                matches[idx] = result.opportunity;
              }
            } catch { /* ignore individual match failures */ }
          })
        );
        setDomainMatches(matches);
        setDomainMatchLoading(false);
      }
    } catch (err) {
      console.error('Failed to fetch domain history:', err);
      setDomainError('Failed to load email history for this domain.');
    } finally {
      setDomainLoading(false);
    }
  };

  const handleAskAI = (msg) => {
    // Create a new chat session if one doesn't exist for this message
    if (!chatManager.sessions[msg.id]) {
      const body = msg.body_plain_stripped || msg.body_plain
        || (msg.body_html_stripped || msg.body_html || '').replace(/<[^>]+>/g, '');
      chatManager.createSession(msg.id, {
        from: msg.from || 'Unknown',
        to: msg.to || '',
        subject: msg.subject || email.subject || '(no subject)',
        date: formatFullDate(msg.date),
        body,
      }, effectiveOpportunity, {
        id: email.id,
        threadId: email.threadId,
        account: email.account,
        subject: email.subject,
      });
    }
    chatManager.setActiveMsgId(msg.id);
    // Scroll the chat panel into view after it renders
    setTimeout(() => {
      if (chatPanelRef.current) {
        chatPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  };

  const handleDomainAccountChange = (newAccount) => {
    setDomainSearchAccount(newAccount);
    handleDomainSearch(newAccount);
  };

  // Drive upload handler
  const handleDriveUpload = async (files) => {
    if (!files || files.length === 0) return;
    const opp = effectiveOpportunity;
    const driveLink = opp?.drive_link && opp.drive_link.startsWith('http') ? opp.drive_link : null;
    const subject = opp?.subject || email?.subject || '';

    setDriveUploading(true);
    setDriveUploadResult(null);
    try {
      const result = await uploadToDrive({
        folderUrl: driveLink || '',
        folderName: driveLink ? '' : `Solicitation_${(opp?.title || subject || 'Unknown').slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        subject: driveLink ? '' : subject, // only write-back if creating new folder
        files: Array.from(files),
      });

      setDriveUploadResult({
        success: true,
        uploaded: result.uploaded?.length || 0,
        errors: result.errors?.length || 0,
        folderUrl: result.folder_url,
      });

      // If a new folder was created, update the effective opportunity
      if (!driveLink && result.folder_url) {
        setLinkedOpportunity(prev => ({
          ...(prev || opp || {}),
          drive_link: result.folder_url,
        }));
      }
    } catch (err) {
      console.error('Drive upload failed:', err);
      setDriveUploadResult({ success: false, error: err?.response?.data?.error || 'Upload failed' });
    } finally {
      setDriveUploading(false);
    }
  };

  const handleCreateDriveFolder = async () => {
    const opp = effectiveOpportunity;
    const subject = opp?.subject || email?.subject || '';
    const folderName = `Solicitation_${(opp?.title || subject || 'Unknown').slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    setDriveCreating(true);
    try {
      const result = await createDriveFolder(folderName, subject);
      // Update the effective opportunity with the new drive link
      setLinkedOpportunity(prev => ({
        ...(prev || opp || {}),
        drive_link: result.folder_url,
      }));
      setDriveUploadResult({
        success: true,
        uploaded: 0,
        errors: 0,
        folderUrl: result.folder_url,
        message: 'Folder created! You can now upload files.',
      });
    } catch (err) {
      console.error('Create folder failed:', err);
      setDriveUploadResult({ success: false, error: err?.response?.data?.error || 'Failed to create folder' });
    } finally {
      setDriveCreating(false);
    }
  };

  const handleLinkSolicitation = async () => {
    const subject = linkSubject.trim();
    if (!subject) return;

    setLinkSearching(true);
    setLinkError(null);
    try {
      const result = await fetchOpportunity(subject);
      if (result.matched && result.opportunity) {
        setLinkedOpportunity(result.opportunity);
        setLinkOpen(false);
        setLinkSubject('');
      } else {
        setLinkError('No matching solicitation found for that subject.');
      }
    } catch (err) {
      console.error('Link solicitation failed:', err);
      setLinkError('Search failed. Please try again.');
    } finally {
      setLinkSearching(false);
    }
  };

  // The effective opportunity — linked from domain history overrides the prop
  const effectiveOpportunity = linkedOpportunity || opportunity;

  return (
    <div ref={detailRef} className={`email-detail ${visible ? 'email-detail--visible' : ''}`}>
      {/* Thread header */}
      <div className="email-detail__header">
        <h1 className="email-detail__subject">{email.subject || '(no subject)'}</h1>
        <div className="email-detail__meta">
          <span><strong>Inbox</strong> {email.account}</span>
          <span><strong>Messages</strong> {messages.length} in thread</span>
        </div>
        <div className="email-detail__actions">
          {email.is_unread ? (
            <button className="btn btn--tonal btn--small" onClick={() => onMarkRead(email)}>
              ✓ Mark as Read
            </button>
          ) : (
            <button className="btn btn--tonal btn--small" onClick={() => onMarkUnread(email)}>
              ✉ Mark as Unread
            </button>
          )}
          {senderDomain && (
            <button
              className={`btn btn--small ${domainOpen ? 'btn--tonal' : ''}`}
              onClick={() => handleDomainSearch()}
              disabled={domainLoading}
            >
              {domainLoading ? (
                <>
                  <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  Searching…
                </>
              ) : (
                <>🔍 Emails with {senderDomain}</>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Link solicitation button – shown when no opportunity is matched */}
      {!effectiveOpportunity && !domainLoading && (
        <div className="opp-card" style={{ borderLeft: '4px solid var(--color-border)' }}>
          <div className="opp-card__body" style={{ padding: '12px 16px' }}>
            {!linkOpen ? (
              <button
                className="btn btn--small btn--tonal"
                onClick={() => {
                  setLinkOpen(true);
                  setTimeout(() => linkInputRef.current?.focus(), 100);
                }}
              >
                🔗 Link Solicitation
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  Enter the solicitation subject to link:
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    ref={linkInputRef}
                    type="text"
                    value={linkSubject}
                    onChange={(e) => setLinkSubject(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleLinkSolicitation(); if (e.key === 'Escape') { setLinkOpen(false); setLinkError(null); } }}
                    placeholder="Paste or type the solicitation subject…"
                    disabled={linkSearching}
                    style={{
                      flex: 1,
                      padding: '7px 12px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                      fontSize: '0.85rem',
                      outline: 'none',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                    }}
                  />
                  <button
                    className="btn btn--small btn--tonal"
                    onClick={handleLinkSolicitation}
                    disabled={linkSearching || !linkSubject.trim()}
                  >
                    {linkSearching ? (
                      <>
                        <span className="spinner spinner--small" style={{ width: 12, height: 12, borderWidth: 2 }} />
                        Searching…
                      </>
                    ) : (
                      'Search'
                    )}
                  </button>
                  <button
                    className="btn btn--small"
                    onClick={() => { setLinkOpen(false); setLinkError(null); setLinkSubject(''); }}
                  >
                    ✕
                  </button>
                </div>
                {linkError && (
                  <div style={{ fontSize: '0.8rem', color: '#c5221f', marginTop: 2 }}>
                    {linkError}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Background loading indicator for domain history + solicitation matching */}
      {domainLoading && !effectiveOpportunity && (
        <div className="opp-card" style={{ opacity: 0.7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
            <span className="spinner spinner--small" style={{ width: 16, height: 16, borderWidth: 2 }} />
            <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
              Finding solicitation from domain history…
            </span>
          </div>
        </div>
      )}

      {/* Government Opportunity Card (from direct match or linked via domain history) */}
      {effectiveOpportunity && (
        <div className="opp-card">
          <div className="opp-card__badge">
            {linkedOpportunity && !opportunity ? '🔗 Linked from Domain History' : (effectiveOpportunity.source === 'SAM.GOV' ? '🏛️ SAM.GOV' : '📍 Local Contract')}
          </div>
          <div className="opp-card__body">
            <div className="opp-card__title">
              {effectiveOpportunity.title || effectiveOpportunity.subject || 'Government Opportunity'}
            </div>
            <div className="opp-card__details">
              {effectiveOpportunity.due_date && (
                <span className="opp-card__detail">
                  <strong>Due</strong> {effectiveOpportunity.due_date}
                </span>
              )}
              {effectiveOpportunity.status && (
                <span className="opp-card__detail">
                  <strong>Status</strong> {effectiveOpportunity.status}
                </span>
              )}
              {effectiveOpportunity.reasoning && (
                <span className="opp-card__detail">
                  <strong>Source</strong> {effectiveOpportunity.reasoning}
                </span>
              )}
            </div>
            <div className="opp-card__links">
              {effectiveOpportunity.link && (
                <a
                  href={effectiveOpportunity.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--tonal btn--small"
                >
                  🔗 View Solicitation
                </a>
              )}
              {effectiveOpportunity.drive_link && effectiveOpportunity.drive_link.startsWith('http') && (
                <a
                  href={effectiveOpportunity.drive_link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--small"
                >
                  📁 Google Drive
                </a>
              )}
              {/* Upload files to Drive */}
              {effectiveOpportunity.drive_link && effectiveOpportunity.drive_link.startsWith('http') ? (
                <>
                  <input
                    ref={driveUploadRef}
                    type="file"
                    multiple
                    onChange={(e) => handleDriveUpload(e.target.files)}
                    style={{ display: 'none' }}
                  />
                  <button
                    className="btn btn--small"
                    onClick={() => driveUploadRef.current?.click()}
                    disabled={driveUploading}
                    title="Upload files to this solicitation's Drive folder"
                  >
                    {driveUploading ? (
                      <>
                        <span className="spinner spinner--small" style={{ width: 12, height: 12, borderWidth: 2 }} />
                        Uploading…
                      </>
                    ) : (
                      <>📤 Upload to Drive</>
                    )}
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--small btn--tonal"
                  onClick={handleCreateDriveFolder}
                  disabled={driveCreating}
                  title="Create a Google Drive folder for this solicitation"
                >
                  {driveCreating ? (
                    <>
                      <span className="spinner spinner--small" style={{ width: 12, height: 12, borderWidth: 2 }} />
                      Creating…
                    </>
                  ) : (
                    <>📂 Create Drive Folder</>
                  )}
                </button>
              )}
              <button
                className="btn btn--small"
                onClick={() => {
                  setLinkOpen(!linkOpen);
                  setLinkError(null);
                  if (!linkOpen) setTimeout(() => linkInputRef.current?.focus(), 100);
                }}
                title="Link a different solicitation by subject"
              >
                🔗 Link
              </button>
              {linkedOpportunity && (
                <button
                  className="btn btn--small"
                  onClick={() => setLinkedOpportunity(null)}
                  title="Remove the linked solicitation"
                >
                  ✕ Unlink
                </button>
              )}
            </div>

            {/* Inline link-by-subject form inside the opportunity card */}
            {linkOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0 4px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    ref={linkInputRef}
                    type="text"
                    value={linkSubject}
                    onChange={(e) => setLinkSubject(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleLinkSolicitation(); if (e.key === 'Escape') { setLinkOpen(false); setLinkError(null); } }}
                    placeholder="Paste or type the solicitation subject…"
                    disabled={linkSearching}
                    style={{
                      flex: 1,
                      padding: '7px 12px',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                      fontSize: '0.85rem',
                      outline: 'none',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                    }}
                  />
                  <button
                    className="btn btn--small btn--tonal"
                    onClick={handleLinkSolicitation}
                    disabled={linkSearching || !linkSubject.trim()}
                  >
                    {linkSearching ? (
                      <>
                        <span className="spinner spinner--small" style={{ width: 12, height: 12, borderWidth: 2 }} />
                        Searching…
                      </>
                    ) : (
                      'Search'
                    )}
                  </button>
                  <button
                    className="btn btn--small"
                    onClick={() => { setLinkOpen(false); setLinkError(null); setLinkSubject(''); }}
                  >
                    ✕
                  </button>
                </div>
                {linkError && (
                  <div style={{ fontSize: '0.8rem', color: '#c5221f' }}>
                    {linkError}
                  </div>
                )}
              </div>
            )}

            {/* Upload result banner */}
            {driveUploadResult && (
              <div className={`opp-card__upload-result ${driveUploadResult.success ? 'opp-card__upload-result--success' : 'opp-card__upload-result--error'}`}>
                {driveUploadResult.success ? (
                  <span>
                    {driveUploadResult.message || `✅ ${driveUploadResult.uploaded} file${driveUploadResult.uploaded !== 1 ? 's' : ''} uploaded`}
                    {driveUploadResult.errors > 0 && ` (${driveUploadResult.errors} failed)`}
                    {driveUploadResult.folderUrl && (
                      <>
                        {' — '}
                        <a href={driveUploadResult.folderUrl} target="_blank" rel="noopener noreferrer">
                          Open Folder
                        </a>
                      </>
                    )}
                  </span>
                ) : (
                  <span>❌ {driveUploadResult.error}</span>
                )}
                <button
                  className="opp-card__upload-dismiss"
                  onClick={() => setDriveUploadResult(null)}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Domain history panel */}
      {domainOpen && (
        <div className="domain-history">
          <div className="domain-history__header">
            <span className="domain-history__title">
              📋 Email history with <strong>{senderDomain}</strong>
            </span>
            <button
              className="btn btn--icon"
              onClick={() => setDomainOpen(false)}
              title="Close"
            >
              ✕
            </button>
          </div>

          {/* Inbox selector */}
          <div className="domain-history__account-toggle">
            {accounts.filter(a => a.authenticated).map(acct => {
              const acctEmail = acct.email || acct.name;
              const isActive = (domainSearchAccount || email.account) === acctEmail;
              return (
                <button
                  key={acctEmail}
                  className={`domain-history__account-chip ${isActive ? 'domain-history__account-chip--active' : ''}`}
                  onClick={() => handleDomainAccountChange(acctEmail)}
                  disabled={domainLoading}
                >
                  {acctEmail}
                </button>
              );
            })}
          </div>

          {domainLoading && (
            <div className="domain-history__loading">
              <div className="spinner spinner--small" />
              <span>Searching Gmail…</span>
            </div>
          )}

          {domainError && (
            <div className="domain-history__error">{domainError}</div>
          )}

          {!domainLoading && !domainError && domainEmails.length === 0 && (
            <div className="domain-history__empty">
              No emails found with {senderDomain} in {domainSearchAccount || email.account}.
            </div>
          )}

          {!domainLoading && domainEmails.length > 0 && (
            <>
              <div className="domain-history__count">
                {domainEmails.length} email{domainEmails.length !== 1 ? 's' : ''} found
              </div>
              <div className="domain-history__list">
                {domainEmails.map((e, idx) => {
                  const searchAcct = domainSearchAccount || email.account;
                  const isSent = e.from && e.from.toLowerCase().includes(searchAcct.toLowerCase());
                  const matchedOpp = domainMatches[idx];
                  const isLinked = linkedOpportunity && matchedOpp &&
                    linkedOpportunity.subject === matchedOpp.subject;
                  return (
                    <div key={e.id || idx} className={`domain-history__item ${matchedOpp ? 'domain-history__item--has-opp' : ''}`}>
                      <div className="domain-history__item-top">
                        <span className={`domain-history__direction ${isSent ? 'domain-history__direction--sent' : 'domain-history__direction--received'}`}>
                          {isSent ? '↗ SENT' : '↙ RECEIVED'}
                        </span>
                        <span className="domain-history__item-date">
                          {formatShortDate(e.date)}
                        </span>
                      </div>
                      <div className="domain-history__item-subject">
                        {e.subject || '(no subject)'}
                      </div>
                      <div className="domain-history__item-people">
                        {isSent ? `To: ${e.to || ''}` : `From: ${e.from || ''}`}
                      </div>
                      {e.snippet && (
                        <div className="domain-history__item-snippet">
                          {e.snippet}
                        </div>
                      )}
                      {matchedOpp && (
                        <div className="domain-history__item-opp">
                          <span className="domain-history__opp-badge">
                            📋 {matchedOpp.source === 'SAM.GOV' ? 'SAM.GOV' : 'Local'} Solicitation
                          </span>
                          {isLinked ? (
                            <span className="domain-history__opp-linked">✅ Linked</span>
                          ) : (
                            <button
                              className="btn btn--small btn--tonal domain-history__link-btn"
                              onClick={() => setLinkedOpportunity(matchedOpp)}
                              title="Use this email's solicitation for the current email"
                            >
                              🔗 Link Solicitation
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Thread loading */}
      {threadLoading && (
        <div style={{ padding: '20px 36px', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="spinner spinner--small" />
          <span style={{ fontSize: '0.85rem' }}>Loading thread…</span>
        </div>
      )}

      {/* Reply success banner */}
      {replySuccess && (
        <div className="reply-success-banner">
          ✅ {replySuccess}
        </div>
      )}

      {/* Thread messages – compose editor renders inline below the message being replied to */}
      <div className="thread-messages">
        {messages.map((msg, idx) => (
          <div key={msg.id || idx}>
            <ThreadMessage
              message={msg}
              formatDate={formatFullDate}
              isLast={idx === messages.length - 1}
              isOurs={messageStatuses[idx].isOurs}
              hasResponse={messageStatuses[idx].hasResponse}
              defaultExpanded={idx === messages.length - 1}
              aiSession={chatManager.sessions[msg.id] || null}
              isReplyOpen={replyToMsg && replyToMsg.id === msg.id}
              onReplyClick={(msg, draftOnly) => {
                if (draftOnly) {
                  handleReplyClick(msg);
                  setDraftOnlyMode(true);
                } else {
                  handleReplyClick(msg);
                  setDraftOnlyMode(false);
                }
              }}
              onAskAI={handleAskAI}
              onAddSignature={() => {
                // If reply editor is already open for this message, append signature
                if (replyToMsg && replyToMsg.id === msg.id && composeEditorRef.current) {
                  composeEditorRef.current.appendSignature();
                } else {
                  // Open the reply editor first, then append signature after it mounts
                  handleReplyClick(msg);
                  setDraftOnlyMode(false);
                  setTimeout(() => {
                    if (composeEditorRef.current) {
                      composeEditorRef.current.appendSignature();
                    }
                  }, 300);
                }
              }}
              hasSignature={!!signatures[email.account]}
            />

            {/* Inline compose editor – appears right below the message being replied to */}
            {replyToMsg && replyToMsg.id === msg.id && (
              <div className="thread-reply-compose" ref={replyComposeRef}>
                <ComposeEditor
                  ref={composeEditorRef}
                  mode="reply"
                  accounts={accounts}
                  defaultAccount={email.account}
                  defaultTo={
                    // If the message was sent by our own account, reply to the
                    // recipient instead of replying to ourselves
                    (replyToMsg.from || '').toLowerCase().includes(email.account.toLowerCase())
                      ? (replyToMsg.to || '')
                      : (replyToMsg.from || '')
                  }
                  defaultSubject={
                    (email.subject || '').startsWith('Re:')
                      ? email.subject
                      : `Re: ${email.subject || ''}`
                  }
                  threadId={email.threadId}
                  messageId={replyToMsg.id}
                  onSend={handleReplySend}
                  onSaveDraft={handleReplySaveDraft}
                  onCancel={() => {
                    setReplyToMsg(null);
                    setDraftOnlyMode(false);
                  }}
                  sending={replySending}
                  driveAttachments={chatManager.sessions[chatManager.activeMsgId]?.recommendedFiles || []}
                  driveLink={effectiveOpportunity?.drive_link || null}
                  signatures={signatures}
                />
              </div>
            )}

            {/* AI Chat Panel – inline below the message that triggered it */}
            {chatManager.activeMsgId === msg.id && chatManager.sessions[msg.id] && (
              <div ref={chatPanelRef}>
                <ChatPanel
                  session={chatManager.sessions[msg.id]}
                  onUpdateSession={chatManager.updateSession}
                  onSendMessage={chatManager.sendMessage}
                  onClose={() => chatManager.setActiveMsgId(null)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Extract a plain-text snippet from a message for collapsed preview.
 */
function getSnippet(message, maxLen = 120) {
  const plain = message.body_plain_stripped || message.body_plain || '';
  if (plain.trim()) {
    return plain.trim().slice(0, maxLen) + (plain.trim().length > maxLen ? '…' : '');
  }
  const html = message.body_html_stripped || message.body_html || '';
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, maxLen) + (text.length > maxLen ? '…' : '');
}

/**
 * A single message within the thread conversation.
 * Supports collapsing — only the last message is expanded by default.
 * Collapsed messages that need a reply show a snippet preview.
 */
function ThreadMessage({ message, formatDate, isLast, isOurs, hasResponse, defaultExpanded, aiSession, isReplyOpen, onReplyClick, onAskAI, onAddSignature, hasSignature }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Extract friendly sender name
  const fromDisplay = (() => {
    const raw = message.from || '';
    const match = raw.match(/^"?([^"<]+)"?\s*</);
    return match ? match[1].trim() : raw;
  })();

  const avatarColor = getAvatarColor(fromDisplay);
  const initials = getInitials(fromDisplay);

  // Use stripped body (only what the sender actually wrote)
  const htmlBody = message.body_html_stripped || message.body_html || '';
  const plainBody = message.body_plain_stripped || message.body_plain || '';
  const hasHtml = htmlBody.trim().length > 0;
  const hasPlain = plainBody.trim().length > 0;

  const needsReply = !isOurs && !hasResponse;

  // Determine the response status class
  const statusClass = isOurs
    ? 'thread-msg--sent'
    : hasResponse
      ? 'thread-msg--replied'
      : 'thread-msg--awaiting';

  const collapsedClass = expanded ? '' : 'thread-msg--collapsed';

  return (
    <div className={`thread-msg ${isLast ? 'thread-msg--last' : ''} ${statusClass} ${collapsedClass}`}>
      <div
        className="thread-msg__header"
        onClick={() => setExpanded(prev => !prev)}
        style={{ cursor: 'pointer' }}
        title={expanded ? 'Click to collapse' : 'Click to expand'}
      >
        <div className="thread-msg__sender-info">
          <span className={`thread-msg__collapse-icon ${expanded ? 'thread-msg__collapse-icon--open' : ''}`}>
            ▸
          </span>
          <div
            className="thread-msg__avatar"
            style={{ backgroundColor: avatarColor }}
          >
            {initials}
          </div>
          <div className="thread-msg__from">{fromDisplay}</div>
          {/* Response status badge */}
          {isOurs ? (
            <span className="thread-msg__status-badge thread-msg__status-badge--sent">You replied</span>
          ) : hasResponse ? (
            <span className="thread-msg__status-badge thread-msg__status-badge--replied">Replied</span>
          ) : (
            <span className="thread-msg__status-badge thread-msg__status-badge--awaiting">Needs reply</span>
          )}
        </div>
        <div className="thread-msg__date">{formatDate(message.date)}</div>
      </div>

      {/* Collapsed: show snippet preview for messages that need reply */}
      {!expanded && needsReply && (
        <div className="thread-msg__snippet" onClick={() => setExpanded(true)}>
          {getSnippet(message)}
        </div>
      )}

      {/* Expanded: full message content */}
      {expanded && (
        <>
          {message.to && (
            <div className="thread-msg__to">To: {message.to}</div>
          )}
          <div className="thread-msg__body">
            {hasHtml ? (
              <div
                className="thread-msg__html-content"
                dangerouslySetInnerHTML={{ __html: htmlBody }}
              />
            ) : hasPlain ? (
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>
                {plainBody}
              </pre>
            ) : (
              <p style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic', margin: 0 }}>No content</p>
            )}
          </div>
          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="thread-msg__attachments">
              <div className="thread-msg__attachments-label">
                📎 {message.attachments.length} attachment{message.attachments.length !== 1 ? 's' : ''}
              </div>
              <div className="thread-msg__attachments-list">
                {message.attachments.map((att, i) => (
                  <a
                    key={att.attachmentId || i}
                    className="thread-msg__attachment"
                    href={getAttachmentUrl(message.id, att.attachmentId, message.account, att.filename)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Download ${att.filename}`}
                  >
                    <span className="thread-msg__attachment-icon">
                      {getFileIcon(att.filename)}
                    </span>
                    <span className="thread-msg__attachment-info">
                      <span className="thread-msg__attachment-name">{att.filename}</span>
                      <span className="thread-msg__attachment-size">{formatBytes(att.size)}</span>
                    </span>
                    <span className="thread-msg__attachment-download">⬇</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="thread-msg__actions">
            <button
              className="btn btn--small btn--tonal"
              onClick={() => onReplyClick && onReplyClick(message)}
              title="Reply to this message"
            >
              ↩ Reply
            </button>
            <button
              className="btn btn--small"
              onClick={() => onReplyClick && onReplyClick(message, true)}
              title="Save a reply draft for this message"
            >
              📝 Draft Reply
            </button>
            <button
              className="btn btn--small"
              onClick={() => onAskAI && onAskAI(message)}
              title={aiSession ? 'View AI conversation' : 'Ask AI to help draft a reply'}
            >
              {aiSession?.loading ? '🤖⏳ AI thinking…' : aiSession?.phase === 'chat' ? '🤖✅ View AI' : '🤖 Ask AI'}
            </button>
            <button
              className="btn btn--small"
              onClick={() => onAddSignature && onAddSignature()}
              title="Add your signature to the reply"
            >
              ✍ Add Signature
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default EmailDetail;
