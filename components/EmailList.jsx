'use client';

import { formatDistanceToNow, parseISO, format } from 'date-fns';

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

/**
 * Renders the scrollable list of email items (left panel).
 */
function EmailList({ emails, selectedId, selectedThreadId, onSelect }) {
  if (!emails || emails.length === 0) {
    return (
      <div className="email-list">
        <div className="email-list__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <p style={{ fontWeight: 700, fontSize: '1.15rem', color: 'var(--color-text)' }}>All caught up!</p>
          <p style={{ marginTop: 4 }}>No unread emails to display.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="email-list">
      {emails.map(email => (
        <EmailItem
          key={`${email.threadId || email.id}-${email.account}`}
          email={email}
          isSelected={email.id === selectedId || (selectedThreadId && email.threadId === selectedThreadId)}
          onClick={() => onSelect(email)}
        />
      ))}
    </div>
  );
}

/**
 * Single row in the email list.
 */
function EmailItem({ email, isSelected, onClick }) {
  const formatDate = (isoDate) => {
    if (!isoDate) return '';
    try {
      const date = parseISO(isoDate);
      const now = new Date();
      const diffMs = now - date;
      const oneDayMs = 24 * 60 * 60 * 1000;

      if (diffMs < oneDayMs) {
        return formatDistanceToNow(date, { addSuffix: true });
      } else if (diffMs < 7 * oneDayMs) {
        return format(date, 'EEE, MMM d');
      }
      return format(date, 'MMM d, yyyy');
    } catch {
      return '';
    }
  };

  // Extract a friendly "from" name
  const fromDisplay = (() => {
    const raw = email.from || '';
    const match = raw.match(/^"?([^"<]+)"?\s*</);
    return match ? match[1].trim() : raw.split('@')[0] || 'Unknown';
  })();

  const classNames = [
    'email-item',
    isSelected && 'email-item--selected',
    email.is_unread && 'email-item--unread',
  ].filter(Boolean).join(' ');

  const avatarColor = getAvatarColor(fromDisplay);
  const initials = getInitials(fromDisplay);

  return (
    <div
      className={classNames}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Email from ${fromDisplay}: ${email.subject || '(no subject)'}`}
    >
      {/* Unread dot */}
      {email.is_unread && <span className="email-item__unread-dot" />}

      {/* Avatar */}
      <div
        className="email-item__avatar"
        style={{ backgroundColor: avatarColor }}
      >
        {initials}
      </div>

      {/* Content */}
      <div className="email-item__content">
        <div className="email-item__top">
          <span className="email-item__from">
            {fromDisplay}
            {email._unreadCount > 1 && (
              <span className="email-item__thread-count">{email._unreadCount}</span>
            )}
          </span>
          <span className="email-item__date">{formatDate(email.date)}</span>
        </div>
        <div className="email-item__subject">{email.subject || '(no subject)'}</div>
        <div className="email-item__snippet">{email.snippet || ''}</div>
        <span className="email-item__account">{email.account}</span>
      </div>
    </div>
  );
}

export default EmailList;
