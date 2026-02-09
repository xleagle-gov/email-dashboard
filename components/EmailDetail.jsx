'use client';

import { useRef, useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { fetchDomainHistory, sendReply, createDraft, getAttachmentUrl, fetchOpportunity } from '@/lib/api';
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
}) {
  const detailRef = useRef(null);
  const replyComposeRef = useRef(null);
  const chatPanelRef = useRef(null);

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

  // AI Chat panel state — stores email context object, not a pre-built prompt
  const [chatContext, setChatContext] = useState(null);
  const [chatContextMsgId, setChatContextMsgId] = useState(null);

  // AI-recommended Drive file attachments (passed to ComposeEditor when replying)
  const [aiRecommendedFiles, setAiRecommendedFiles] = useState([]);

  // Linked opportunity from domain history (overrides the prop-level `opportunity`)
  const [linkedOpportunity, setLinkedOpportunity] = useState(null);
  // Map of domain-history email index → matched opportunity
  const [domainMatches, setDomainMatches] = useState({});
  const [domainMatchLoading, setDomainMatchLoading] = useState(false);

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
    setChatContext(null);
    setChatContextMsgId(null);
    setLinkedOpportunity(null);
    setDomainMatches({});
    setAiRecommendedFiles([]);
  }, [email?.id]);

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
  const messages = threadMessages && threadMessages.length > 0 ? threadMessages : [email];

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
    const body = msg.body_plain_stripped || msg.body_plain
      || (msg.body_html_stripped || msg.body_html || '').replace(/<[^>]+>/g, '');
    setChatContext({
      from: msg.from || 'Unknown',
      to: msg.to || '',
      subject: msg.subject || email.subject || '(no subject)',
      date: formatFullDate(msg.date),
      body,
    });
    setChatContextMsgId(msg.id);
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
            />

            {/* Inline compose editor – appears right below the message being replied to */}
            {replyToMsg && replyToMsg.id === msg.id && (
              <div className="thread-reply-compose" ref={replyComposeRef}>
                <ComposeEditor
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
                  driveAttachments={aiRecommendedFiles}
                  driveLink={effectiveOpportunity?.drive_link || null}
                />
              </div>
            )}

            {/* AI Chat Panel – inline below the message that triggered it */}
            {chatContext && chatContextMsgId === msg.id && (
              <div ref={chatPanelRef}>
                <ChatPanel
                  emailContext={chatContext}
                  opportunity={effectiveOpportunity}
                  onClose={() => { setChatContext(null); setChatContextMsgId(null); }}
                  onRecommendAttachments={setAiRecommendedFiles}
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
 * A single message within the thread conversation.
 */
function ThreadMessage({ message, formatDate, isLast, isOurs, hasResponse, onReplyClick, onAskAI }) {
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

  // Determine the response status class
  const statusClass = isOurs
    ? 'thread-msg--sent'
    : hasResponse
      ? 'thread-msg--replied'
      : 'thread-msg--awaiting';

  return (
    <div className={`thread-msg ${isLast ? 'thread-msg--last' : ''} ${statusClass}`}>
      <div className="thread-msg__header">
        <div className="thread-msg__sender-info">
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
          title="Ask AI to help draft a reply"
        >
          🤖 Ask AI
        </button>
      </div>
    </div>
  );
}

export default EmailDetail;
