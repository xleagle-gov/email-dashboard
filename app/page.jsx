'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchUnreadEmails, fetchAccounts, fetchEmailDetail, markAsRead, markAsUnread, fetchThread, createDraft, sendEmail, chatWithAI } from '@/lib/api';
import { parseRecommendedAttachments, matchFilesToDrive } from '@/components/ChatPanel';
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeAccount, setActiveAccount] = useState(null); // null = all
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Track if detail panel should be visible on mobile
  const [detailVisible, setDetailVisible] = useState(false);

  // Compose new email state
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeSending, setComposeSending] = useState(false);

  // ---- AI Chat session management ----
  // Sessions persist across email navigation so AI calls keep running in background
  const [chatSessions, setChatSessions] = useState({});
  const [activeChatMsgId, setActiveChatMsgId] = useState(null);

  const updateChatSession = useCallback((sessionId, updates) => {
    setChatSessions(prev => {
      const session = prev[sessionId];
      if (!session) return prev;
      return { ...prev, [sessionId]: { ...session, ...updates } };
    });
  }, []);

  const createChatSession = useCallback((msgId, emailContext, opportunity, emailRef) => {
    setChatSessions(prev => ({
      ...prev,
      [msgId]: {
        msgId,
        emailContext,
        opportunity,
        emailRef,
        phase: 'pick',
        messages: [],
        loading: false,
        selectedProvider: 'gemini',
        selectedModel: 'gemini-3-flash-preview',
        selectedPreset: null,
        systemPrompt: '',
        driveFiles: [],
        driveFilesContent: [],
        driveLoading: false,
        driveError: null,
        driveLoaded: false,
        attachedFiles: [],
        recommendedFiles: [],
      }
    }));
  }, []);

  // Send AI message — runs at the page level so the API call persists
  // even when ChatPanel unmounts during email navigation.
  const sendAiMessage = useCallback(async (sessionId, text, prevMessages, provider, model, driveFileIds, uploadedFiles) => {
    const userMsg = { role: 'user', content: text };
    const updated = [...prevMessages, userMsg];

    // Optimistically add user message and set loading
    setChatSessions(prev => {
      const session = prev[sessionId];
      if (!session) return prev;
      return { ...prev, [sessionId]: { ...session, messages: updated, loading: true } };
    });

    try {
      const { reply } = await chatWithAI(updated, provider, model, driveFileIds, uploadedFiles);

      setChatSessions(prev => {
        const session = prev[sessionId];
        if (!session) return prev;

        const newMessages = [...session.messages, { role: 'assistant', content: reply }];

        // Auto-extract recommended Drive attachments from the AI response
        let recommendedFiles = session.recommendedFiles || [];
        if (session.driveFiles && session.driveFiles.length > 0) {
          const recs = parseRecommendedAttachments(reply);
          if (recs.length > 0) {
            const matched = matchFilesToDrive(recs, session.driveFiles);
            const driveFilesMeta = matched
              .filter(m => m.driveFile)
              .map(m => ({ id: m.driveFile.id, name: m.driveFile.name, mimeType: m.driveFile.mimeType || '' }));
            if (driveFilesMeta.length > 0) {
              recommendedFiles = driveFilesMeta;
            }
          }
        }

        return {
          ...prev,
          [sessionId]: { ...session, messages: newMessages, loading: false, recommendedFiles }
        };
      });
    } catch (err) {
      console.error('AI chat error:', err);
      const detail = err?.response?.data?.details || err?.response?.data?.error || '';
      const isRateLimit = detail.toLowerCase().includes('rate-limit') || detail.includes('429');
      const errorMsg = isRateLimit
        ? '⚠️ All API keys are currently rate-limited. Please wait about a minute and try again.'
        : `⚠️ Failed to get a response. ${detail || 'Please try again.'}`;

      setChatSessions(prev => {
        const session = prev[sessionId];
        if (!session) return prev;
        return {
          ...prev,
          [sessionId]: {
            ...session,
            messages: [...session.messages, { role: 'assistant', content: errorMsg }],
            loading: false,
          }
        };
      });
    }
  }, []);

  // Remove a completed/errored session from the list
  const dismissChatSession = useCallback((sessionId) => {
    setChatSessions(prev => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    if (activeChatMsgId === sessionId) setActiveChatMsgId(null);
  }, [activeChatMsgId]);

  const chatManager = {
    sessions: chatSessions,
    activeMsgId: activeChatMsgId,
    setActiveMsgId: setActiveChatMsgId,
    createSession: createChatSession,
    updateSession: updateChatSession,
    sendMessage: sendAiMessage,
  };

  // AI Sessions panel
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const sessionList = useMemo(() => {
    return Object.values(chatSessions)
      .filter(s => s.phase === 'chat') // only show sessions that have started
      .map(s => {
        const assistantMsgs = s.messages.filter(m => m.role === 'assistant');
        const hasError = assistantMsgs.length > 0 && assistantMsgs[assistantMsgs.length - 1].content.startsWith('⚠️');
        let status = 'pending';
        if (s.loading) status = 'thinking';
        else if (hasError) status = 'error';
        else if (assistantMsgs.length > 0) status = 'done';
        return { ...s, status, assistantCount: assistantMsgs.length };
      });
  }, [chatSessions]);

  const aiSessionCount = sessionList.length;

  // ---- Signature management ----
  const [signatures, setSignatures] = useState({});
  const [signatureEditorOpen, setSignatureEditorOpen] = useState(false);
  const [editingSigAccount, setEditingSigAccount] = useState('');
  const [editingSigText, setEditingSigText] = useState('');

  // Load signatures from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('emailDashboard_signatures');
      if (saved) setSignatures(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // Save signatures to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('emailDashboard_signatures', JSON.stringify(signatures));
    } catch { /* ignore */ }
  }, [signatures]);

  const handleOpenSignatureEditor = (accountEmail) => {
    setEditingSigAccount(accountEmail || accounts.find(a => a.authenticated)?.email || '');
    setEditingSigText(signatures[accountEmail || accounts.find(a => a.authenticated)?.email || ''] || '');
    setSignatureEditorOpen(true);
  };

  const handleSaveSignature = () => {
    if (!editingSigAccount) return;
    setSignatures(prev => ({ ...prev, [editingSigAccount]: editingSigText }));
    setSignatureEditorOpen(false);
  };

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
    setDetailLoading(true);
    setThreadLoading(true);
    try {
      const [fullEmail, threadData] = await Promise.all([
        fetchEmailDetail(email.id, email.account),
        fetchThread(email.threadId, email.account),
      ]);
      setSelectedEmail(fullEmail);
      setThreadMessages(threadData.messages || []);
    } catch (err) {
      console.error('Failed to load email/thread:', err);
      setThreadMessages([email]);
    } finally {
      setDetailLoading(false);
      setThreadLoading(false);
    }
  };

  const handleBack = () => {
    setDetailVisible(false);
  };

  const handleMarkRead = (email) => {
    // Optimistic UI update — mark ALL emails in the same thread as read
    const threadKey = email.threadId || email.id;
    setEmails(prev =>
      prev.map(e =>
        (e.threadId === threadKey || e.id === email.id)
          ? { ...e, is_unread: false, labels: (e.labels || []).filter(l => l !== 'UNREAD') }
          : e
      )
    );
    if (selectedEmail?.id === email.id) {
      setSelectedEmail(prev => ({ ...prev, is_unread: false }));
    }
    // Fire API call in background — pass threadId to mark entire thread
    markAsRead(email.id, email.account, email.threadId).catch(err =>
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

  // Group unread emails by threadId so each thread appears as one row.
  // Uses the newest message as the representative, and attaches unreadCount.
  const groupedEmails = (() => {
    const threadMap = new Map();
    for (const email of unreadEmails) {
      const key = email.threadId || email.id; // fallback if no threadId
      if (!threadMap.has(key)) {
        threadMap.set(key, { representative: email, count: 1 });
      } else {
        const entry = threadMap.get(key);
        entry.count += 1;
        // Keep the newest message as the representative
        if ((email.date || '') > (entry.representative.date || '')) {
          entry.representative = email;
        }
      }
    }
    return Array.from(threadMap.values()).map(({ representative, count }) => ({
      ...representative,
      _unreadCount: count,
    }));
  })();

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
          {aiSessionCount > 0 && (
            <button
              className={`btn ${aiPanelOpen ? 'btn--tonal' : ''}`}
              onClick={() => setAiPanelOpen(prev => !prev)}
              title="View AI sessions"
            >
              🤖 AI ({aiSessionCount})
            </button>
          )}
          <button
            className="btn"
            onClick={() => handleOpenSignatureEditor()}
            title="Edit email signatures"
          >
            ✍ Signature
          </button>
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
          emails={groupedEmails}
          selectedId={selectedEmail?.id}
          selectedThreadId={selectedEmail?.threadId}
          onSelect={(email) => {
            setActiveChatMsgId(null);
            handleSelectEmail(email);
          }}
        />
        <EmailDetail
          email={selectedEmail}
          threadMessages={threadMessages}
          threadLoading={threadLoading || detailLoading}
          visible={detailVisible}
          onBack={handleBack}
          onMarkRead={handleMarkRead}
          onMarkUnread={handleMarkUnread}
          opportunity={selectedEmail?.opportunity || null}
          accounts={accounts}
          onThreadRefresh={handleThreadRefresh}
          chatManager={chatManager}
          signatures={signatures}
        />
      </div>

      {/* AI Sessions Panel */}
      {aiPanelOpen && (
        <div className="ai-sessions-panel">
          <div className="ai-sessions-panel__header">
            <span className="ai-sessions-panel__title">🤖 AI Sessions</span>
            <button className="btn btn--icon" onClick={() => setAiPanelOpen(false)} title="Close">✕</button>
          </div>
          {sessionList.length === 0 ? (
            <div className="ai-sessions-panel__empty">No AI sessions yet.</div>
          ) : (
            <div className="ai-sessions-panel__list">
              {sessionList.map(s => (
                <div
                  key={s.msgId}
                  className={`ai-session-card ai-session-card--${s.status}`}
                  onClick={() => {
                    setActiveChatMsgId(s.msgId);
                    const targetEmail = emails.find(e =>
                      e.id === s.emailRef?.id || e.threadId === s.emailRef?.threadId
                    );
                    if (targetEmail) {
                      handleSelectEmail(targetEmail);
                    }
                    setAiPanelOpen(false);
                  }}
                >
                  <div className="ai-session-card__status">
                    {s.status === 'thinking' && <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />}
                    {s.status === 'done' && <span className="ai-session-card__icon ai-session-card__icon--done">✅</span>}
                    {s.status === 'error' && <span className="ai-session-card__icon ai-session-card__icon--error">⚠️</span>}
                    {s.status === 'pending' && <span className="ai-session-card__icon">⏳</span>}
                  </div>
                  <div className="ai-session-card__info">
                    <div className="ai-session-card__subject">
                      {(s.emailContext?.subject || '(no subject)').slice(0, 60)}
                    </div>
                    <div className="ai-session-card__meta">
                      {s.emailContext?.from && <span>{s.emailContext.from.split('<')[0].trim()}</span>}
                      {s.emailRef?.account && <span className="ai-session-card__account">{s.emailRef.account}</span>}
                    </div>
                  </div>
                  <button
                    className="ai-session-card__dismiss"
                    onClick={(e) => { e.stopPropagation(); dismissChatSession(s.msgId); }}
                    title="Dismiss session"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Floating AI indicator – shows when AI is thinking in the background */}
      {Object.values(chatSessions).some(s => s.loading) && !aiPanelOpen && (
        <div className="ai-toast">
          {Object.values(chatSessions).filter(s => s.loading).map(s => (
            <button
              key={s.msgId}
              className="ai-toast__item"
              onClick={() => {
                setAiPanelOpen(true);
              }}
              title="Click to view AI sessions"
            >
              <span className="spinner spinner--small" style={{ width: 14, height: 14, borderWidth: 2 }} />
              <span className="ai-toast__text">
                AI thinking… <strong>{(s.emailContext?.subject || '').slice(0, 50)}</strong>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Signature Editor Modal */}
      {signatureEditorOpen && (
        <div className="compose-overlay">
          <div className="compose-overlay__backdrop" onClick={() => setSignatureEditorOpen(false)} />
          <div className="signature-editor">
            <div className="signature-editor__header">
              <span className="signature-editor__title">✍ Edit Email Signature</span>
              <button className="btn btn--icon" onClick={() => setSignatureEditorOpen(false)} title="Close">✕</button>
            </div>
            <div className="signature-editor__body">
              <div className="signature-editor__field">
                <label>Account</label>
                <select
                  value={editingSigAccount}
                  onChange={(e) => {
                    setEditingSigAccount(e.target.value);
                    setEditingSigText(signatures[e.target.value] || '');
                  }}
                >
                  {accounts.filter(a => a.authenticated).map(a => (
                    <option key={a.email || a.name} value={a.email || a.name}>
                      {a.email || a.name}
                      {signatures[a.email || a.name] ? ' ✓' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="signature-editor__field">
                <label>Signature (HTML supported)</label>
                <textarea
                  className="signature-editor__textarea"
                  value={editingSigText}
                  onChange={(e) => setEditingSigText(e.target.value)}
                  rows={8}
                  placeholder={'Best regards,\nJohn Doe\nCompany Name\n(555) 123-4567'}
                />
              </div>
              {editingSigText && (
                <div className="signature-editor__preview">
                  <label>Preview</label>
                  <div
                    className="signature-editor__preview-content"
                    dangerouslySetInnerHTML={{ __html: editingSigText.replace(/\n/g, '<br/>') }}
                  />
                </div>
              )}
            </div>
            <div className="signature-editor__footer">
              <button className="btn btn--primary" onClick={handleSaveSignature}>
                💾 Save Signature
              </button>
              {signatures[editingSigAccount] && (
                <button
                  className="btn"
                  onClick={() => {
                    setSignatures(prev => {
                      const next = { ...prev };
                      delete next[editingSigAccount];
                      return next;
                    });
                    setEditingSigText('');
                  }}
                >
                  🗑 Remove
                </button>
              )}
              <button className="btn" onClick={() => setSignatureEditorOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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
              signatures={signatures}
            />
          </div>
        </div>
      )}
    </div>
  );
}
