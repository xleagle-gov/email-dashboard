'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchUnreadEmails, fetchAccounts, markAsRead, markAsUnread, fetchThread, createDraft, sendEmail } from '@/lib/api';
import EmailList from '@/components/EmailList';
import EmailDetail from '@/components/EmailDetail';
import ComposeEditor from '@/components/ComposeEditor';

export default function DashboardPage() {
  // ---- State ----
  const [emails, setEmails] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [activeAccount, setActiveAccount] = useState(null); // null = all
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Track if detail panel should be visible on mobile
  const [detailVisible, setDetailVisible] = useState(false);

  // Compose new email state
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSending, setComposeSending] = useState(false);

  // ---- Data fetching ----
  const loadEmails = useCallback(async (showLoader = true) => {
    try {
      if (showLoader) setLoading(true);
      setError(null);
      const data = await fetchUnreadEmails({ refresh: true });
      setEmails(data.emails || []);
    } catch (err) {
      console.error('Failed to load emails:', err);
      setError('Failed to load emails. Check the Lambda function.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      setAccounts(data.accounts || []);
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }, []);

  useEffect(() => {
    loadEmails();
    loadAccounts();
  }, [loadEmails, loadAccounts]);

  // ---- Actions ----
  const handleRefresh = async () => {
    setRefreshing(true);
    await loadEmails(false);
  };

  const handleSelectEmail = async (email) => {
    setSelectedEmail(email);
    setDetailVisible(true);
    // Fetch the full thread for this email
    setThreadLoading(true);
    try {
      const data = await fetchThread(email.threadId, email.account);
      setThreadMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load thread:', err);
      // Fallback: just show the single email
      setThreadMessages([email]);
    } finally {
      setThreadLoading(false);
    }
  };

  const handleBack = () => {
    setDetailVisible(false);
  };

  const handleMarkRead = (email) => {
    // Optimistic UI update — fire-and-forget the API call
    setEmails(prev =>
      prev.map(e =>
        e.id === email.id ? { ...e, is_unread: false, labels: e.labels.filter(l => l !== 'UNREAD') } : e
      )
    );
    if (selectedEmail?.id === email.id) {
      setSelectedEmail(prev => ({ ...prev, is_unread: false }));
    }
    // Fire API call in background — don't await
    markAsRead(email.id, email.account).catch(err =>
      console.error('Failed to mark as read:', err)
    );
  };

  const handleMarkUnread = (email) => {
    // Optimistic UI update — fire-and-forget the API call
    setEmails(prev =>
      prev.map(e =>
        e.id === email.id ? { ...e, is_unread: true, labels: [...e.labels, 'UNREAD'] } : e
      )
    );
    if (selectedEmail?.id === email.id) {
      setSelectedEmail(prev => ({ ...prev, is_unread: true }));
    }
    // Fire API call in background — don't await
    markAsUnread(email.id, email.account).catch(err =>
      console.error('Failed to mark as unread:', err)
    );
  };

  // ---- Compose handlers ----
  const handleComposeSend = async (payload) => {
    setComposeSending(true);
    try {
      await sendEmail({
        account: payload.account,
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.htmlBody,
        attachments: payload.attachments,
      });
      setComposeOpen(false);
      alert('Email sent successfully!');
    } catch (err) {
      console.error('Failed to send email:', err);
      alert('Failed to send email. Please try again.');
    } finally {
      setComposeSending(false);
    }
  };

  const handleComposeSaveDraft = async (payload) => {
    setComposeSending(true);
    try {
      await createDraft({
        account: payload.account,
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.htmlBody,
        attachments: payload.attachments,
      });
      setComposeOpen(false);
      alert('Draft saved!');
    } catch (err) {
      console.error('Failed to save draft:', err);
      alert('Failed to save draft. Please try again.');
    } finally {
      setComposeSending(false);
    }
  };

  // ---- Thread refresh (after reply sent) ----
  const handleThreadRefresh = useCallback(async () => {
    if (!selectedEmail) return;
    try {
      const data = await fetchThread(selectedEmail.threadId, selectedEmail.account);
      setThreadMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to refresh thread:', err);
    }
  }, [selectedEmail]);

  // ---- Filtered emails ----
  const filteredEmails = activeAccount
    ? emails.filter(e => e.account === activeAccount)
    : emails;

  // Only show unread in the list
  const unreadEmails = filteredEmails.filter(e => e.is_unread);

  // ---- Render ----
  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p className="loading__text">Loading unread emails…</p>
        <p className="loading__subtext">Fetching from Gmail — this may take a moment.</p>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header__left">
          <div className="header__logo">
            <span className="header__logo-icon">✉</span>
            Email Dashboard
          </div>
          <span className="header__count">{unreadEmails.length} unread</span>
        </div>
        <div className="header__right">
          <button
            className="btn btn--primary"
            onClick={() => setComposeOpen(true)}
          >
            ✏️ Compose
          </button>
          <button
            className={`btn ${refreshing ? 'btn--refreshing' : ''}`}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <span className="btn--refresh-icon">⟳</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Error banner */}
      {error && <div className="error-banner">⚠ {error}</div>}

      {/* Account filter bar */}
      <div className="filter-bar">
        <button
          className={`filter-chip ${!activeAccount ? 'filter-chip--active' : ''}`}
          onClick={() => setActiveAccount(null)}
        >
          All Accounts
        </button>
        {accounts.map(acct => (
          <button
            key={acct.email || acct.name}
            className={`filter-chip ${activeAccount === (acct.email || acct.name) ? 'filter-chip--active' : ''}`}
            onClick={() => setActiveAccount(acct.email || acct.name)}
            title={acct.authenticated ? 'Authenticated' : 'Not authenticated'}
          >
            {acct.authenticated ? '🟢' : '🔴'} {acct.email || acct.name}
          </button>
        ))}
      </div>

      {/* Main split view */}
      <div className="main">
        <EmailList
          emails={unreadEmails}
          selectedId={selectedEmail?.id}
          onSelect={handleSelectEmail}
        />
        <EmailDetail
          email={selectedEmail}
          threadMessages={threadMessages}
          threadLoading={threadLoading}
          visible={detailVisible}
          onBack={handleBack}
          onMarkRead={handleMarkRead}
          onMarkUnread={handleMarkUnread}
          opportunity={selectedEmail?.opportunity || null}
          accounts={accounts}
          onThreadRefresh={handleThreadRefresh}
        />
      </div>

      {/* Compose overlay */}
      {composeOpen && (
        <div className="compose-overlay">
          <div className="compose-overlay__backdrop" onClick={() => setComposeOpen(false)} />
          <div className="compose-overlay__panel">
            <ComposeEditor
              mode="compose"
              accounts={accounts}
              defaultAccount={accounts.find(a => a.authenticated)?.email || ''}
              onSend={handleComposeSend}
              onSaveDraft={handleComposeSaveDraft}
              onCancel={() => setComposeOpen(false)}
              sending={composeSending}
            />
          </div>
        </div>
      )}
    </div>
  );
}
