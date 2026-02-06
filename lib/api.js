/**
 * API client for communicating with the Lambda backend.
 *
 * Requests go to /api/* on the same origin — Next.js rewrites proxy them
 * to the Lambda Function URL, so no CORS is needed.
 */
import axios from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 120000, // 2 minutes – fetching many emails can be slow
});

/**
 * Fetch all unread emails across all accounts.
 * @param {Object} opts
 * @param {string} [opts.account] - Filter by account email
 * @param {boolean} [opts.refresh=true] - Force re-fetch from Gmail
 */
export async function fetchUnreadEmails({ account, refresh = true } = {}) {
  const params = { refresh: refresh ? 'true' : 'false' };
  if (account) params.account = account;
  const { data } = await api.get('/emails/unread', { params });
  return data; // { count, emails }
}

/**
 * Get a single email's full details.
 */
export async function fetchEmailDetail(messageId, account) {
  const params = account ? { account } : {};
  const { data } = await api.get(`/emails/${messageId}`, { params });
  return data;
}

/**
 * Fetch all messages in a thread (oldest-first).
 */
export async function fetchThread(threadId, account) {
  const params = account ? { account } : {};
  const { data } = await api.get(`/threads/${threadId}`, { params });
  return data; // { threadId, messages }
}

/**
 * Mark an email as read.
 */
export async function markAsRead(messageId, account) {
  const { data } = await api.patch(`/emails/${messageId}/read`, { account });
  return data;
}

/**
 * Mark an email as unread.
 */
export async function markAsUnread(messageId, account) {
  const { data } = await api.patch(`/emails/${messageId}/unread`, { account });
  return data;
}

/**
 * Fetch all emails involving a domain within a specific account inbox.
 * @param {string} account - The inbox to search (e.g. "info@thenexan.com")
 * @param {string} domain  - The external domain (e.g. "hartenergyco.com")
 * @param {number} [limit=50] - Max results
 */
export async function fetchDomainHistory(account, domain, limit = 50) {
  const { data } = await api.get('/emails/domain-history', {
    params: { account, domain, limit },
  });
  return data; // { account, domain, count, emails }
}

/**
 * Force refresh of all emails from Gmail.
 */
export async function refreshEmails() {
  const { data } = await api.post('/emails/refresh');
  return data;
}

/**
 * Match email subject(s) to a government opportunity from the spreadsheet.
 * @param {string} subject - Single subject to match
 * @param {string[]} [subjects] - Array of subjects from thread messages (optional, higher priority)
 */
export async function fetchOpportunity(subject, subjects = []) {
  const params = {};
  if (subjects.length > 0) {
    params.subjects = subjects.join('|||');
  } else if (subject) {
    params.subject = subject;
  }
  const { data } = await api.get('/opportunity/match', { params });
  return data; // { matched, opportunity }
}

/**
 * Batch-match all email subjects to government opportunities in one call.
 * @param {Array<{id: string, subject: string}>} emails
 * @returns {Promise<Object<string, object|null>>} Map of emailId → opportunity or null
 */
export async function fetchOpportunitiesBatch(emails) {
  const { data } = await api.post('/opportunity/match-batch', { emails });
  return data.matches; // { [emailId]: opportunity | null }
}

/**
 * Get list of configured accounts and their auth status.
 */
export async function fetchAccounts() {
  const { data } = await api.get('/accounts');
  return data; // { accounts }
}

/**
 * Create a Gmail draft.
 *
 * @param {Object} opts
 * @param {string} opts.account   – Account to create draft in
 * @param {string} opts.to        – Recipient(s)
 * @param {string} opts.subject   – Subject line
 * @param {string} opts.htmlBody  – HTML body
 * @param {string} [opts.threadId]  – Thread to attach draft to (reply)
 * @param {string} [opts.messageId] – Message being replied to
 * @param {File[]} [opts.attachments] – File objects to attach
 */
export async function createDraft({ account, to, subject, htmlBody, threadId, messageId, attachments = [] }) {
  const formData = new FormData();
  formData.append('account', account);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html_body', htmlBody);
  if (threadId) formData.append('threadId', threadId);
  if (messageId) formData.append('messageId', messageId);
  attachments.forEach(file => formData.append('attachments', file));

  const { data } = await api.post('/drafts', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/**
 * Reply to a specific message in a thread (sends immediately).
 *
 * @param {Object} opts
 * @param {string} opts.account    – Account to send from
 * @param {string} opts.messageId  – Message being replied to
 * @param {string} opts.threadId   – Thread ID
 * @param {string} opts.to         – Recipient(s)
 * @param {string} opts.subject    – Subject (usually "Re: ...")
 * @param {string} opts.htmlBody   – HTML body
 * @param {File[]} [opts.attachments] – File objects to attach
 */
export async function sendReply({ account, messageId, threadId, to, subject, htmlBody, attachments = [] }) {
  const formData = new FormData();
  formData.append('account', account);
  formData.append('messageId', messageId);
  formData.append('threadId', threadId);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html_body', htmlBody);
  attachments.forEach(file => formData.append('attachments', file));

  const { data } = await api.post('/reply', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/**
 * Send a new email directly (not a reply).
 *
 * @param {Object} opts
 * @param {string} opts.account    – Account to send from
 * @param {string} opts.to         – Recipient(s)
 * @param {string} opts.subject    – Subject
 * @param {string} opts.htmlBody   – HTML body
 * @param {File[]} [opts.attachments] – File objects to attach
 */
export async function sendEmail({ account, to, subject, htmlBody, attachments = [] }) {
  const formData = new FormData();
  formData.append('account', account);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html_body', htmlBody);
  attachments.forEach(file => formData.append('attachments', file));

  const { data } = await api.post('/send', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export default api;
