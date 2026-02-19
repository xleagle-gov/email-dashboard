'use client';

import { formatDistanceToNow, parseISO, format } from 'date-fns';

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
 * Renders the scrollable list of draft email items (left panel in Drafts tab).
 */
function DraftList({ drafts, selectedDraftId, onSelect, loading }) {
  if (loading) {
    return (
      <div className="email-list">
        <div className="email-list__empty">
          <div className="spinner" />
          <p style={{ marginTop: 16, fontWeight: 500, color: 'var(--color-text-secondary)' }}>
            Loading drafts…
          </p>
        </div>
      </div>
    );
  }

  if (!drafts || drafts.length === 0) {
    return (
      <div className="email-list">
        <div className="email-list__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <p style={{ fontWeight: 700, fontSize: '1.15rem', color: 'var(--color-text)' }}>No drafts</p>
          <p style={{ marginTop: 4 }}>No draft emails found across your accounts.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="email-list">
      {drafts.map(draft => (
        <DraftItem
          key={draft.draftId}
          draft={draft}
          isSelected={draft.draftId === selectedDraftId}
          onClick={() => onSelect(draft)}
        />
      ))}
    </div>
  );
}

function DraftItem({ draft, isSelected, onClick }) {
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

  const toDisplay = (() => {
    const raw = draft.to || '';
    if (!raw) return '(no recipient)';
    const match = raw.match(/^"?([^"<]+)"?\s*</);
    return match ? match[1].trim() : raw.split(',')[0].trim();
  })();

  const classNames = [
    'email-item',
    isSelected && 'email-item--selected',
    'draft-item',
  ].filter(Boolean).join(' ');

  const avatarColor = getAvatarColor(toDisplay);
  const initials = getInitials(toDisplay);

  const snippet = draft.snippet || draft.body_plain_stripped || '';

  return (
    <div
      className={classNames}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Draft to ${toDisplay}: ${draft.subject || '(no subject)'}`}
    >
      {/* Draft badge */}
      <span className="draft-item__badge">Draft</span>

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
            To: {toDisplay}
          </span>
          <span className="email-item__date">{formatDate(draft.date)}</span>
        </div>
        <div className="email-item__subject">{draft.subject || '(no subject)'}</div>
        <div className="email-item__snippet">{snippet.slice(0, 200)}</div>
        <span className="email-item__account">{draft.account}</span>
      </div>
    </div>
  );
}

export default DraftList;
