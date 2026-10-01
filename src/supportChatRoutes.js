import { botReply, greetingFor } from './supportBot.js';

const ROLES = new Set(['customer', 'merchant', 'courier']);
const MAX_BODY = 2000;

function cleanRole(value) {
  const role = String(value || 'customer').toLowerCase();
  return ROLES.has(role) ? role : null;
}

function cleanBody(value) {
  const body = String(value || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return body.slice(0, MAX_BODY);
}

function agentLabel(role) {
  if (role === 'sales_marketing') return 'Marketing';
  if (role === 'accountant') return 'Accounts';
  return 'Admin';
}

async function loadProfile(supabase, userId) {
  const { data } = await supabase
    .from('user_profiles')
    .select('id, full_name, phone, email')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

async function recentOrders(supabase, userId, role) {
  let query = supabase
    .from('orders')
    .select('id, order_number, status, payment_status, payment_method, total_amount, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (role === 'courier') {
    query = query.eq('courier_id', userId);
  } else if (role === 'merchant') {
    const { data: stores } = await supabase.from('stores').select('id').eq('merchant_id', userId);
    const ids = (stores || []).map((store) => store.id);
    if (!ids.length) return [];
    query = query.in('store_id', ids);
  } else {
    query = query.eq('customer_id', userId);
  }

  const { data, error } = await query;
  if (error) {
    console.warn('support chat order lookup:', error.message);
    return [];
  }
  return data || [];
}

async function messagesFor(supabase, conversationId) {
  const { data, error } = await supabase
    .from('support_messages')
    .select('id, sender_type, sender_role, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message || 'Failed to load messages');
  return data || [];
}

async function openConversation(supabase, userId, role) {
  const { data, error } = await supabase
    .from('support_conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('user_role', role)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Failed to load chat');
  return data || null;
}

async function createConversation(supabase, userId, role) {
  const greeting = greetingFor(role);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('support_conversations')
    .insert({
      user_id: userId,
      user_role: role,
      status: 'bot',
      last_message_at: now,
      last_message_preview: greeting.slice(0, 140),
      unread_for_user: 0,
      unread_for_staff: 0,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message || 'Failed to start chat');

  const { error: messageError } = await supabase.from('support_messages').insert({
    conversation_id: data.id,
    sender_type: 'bot',
    sender_role: 'bot',
    body: greeting,
  });
  if (messageError) throw new Error(messageError.message || 'Failed to start chat');
  return data;
}

function publicConversation(row, profile) {
  return {
    id: row.id,
    userId: row.user_id,
    userRole: row.user_role,
    status: row.status,
    assignedRole: row.assigned_role,
    unreadForStaff: row.unread_for_staff || 0,
    unreadForUser: row.unread_for_user || 0,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    escalatedAt: row.escalated_at,
    createdAt: row.created_at,
    userName: profile?.full_name || 'User',
    userPhone: profile?.phone || null,
    userEmail: profile?.email || null,
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    senderType: row.sender_type,
    senderRole: row.sender_role,
    senderLabel:
      row.sender_type === 'bot'
        ? 'DOT Assistant'
        : row.sender_type === 'agent'
          ? agentLabel(row.sender_role)
          : 'You',
    body: row.body,
    createdAt: row.created_at,
  };
}

export function registerSupportChatRoutes(app, { requireAuth, requireAdmin, supabase }) {
  app.get('/support/chat', requireAuth, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const role = cleanRole(req.query.role);
      if (!role) return res.status(400).json({ error: 'role must be customer, merchant, or courier' });

      let conversation = await openConversation(supabase, req.userId, role);
      if (!conversation) conversation = await createConversation(supabase, req.userId, role);
      if (conversation.unread_for_user) {
        await supabase
          .from('support_conversations')
          .update({ unread_for_user: 0, updated_at: new Date().toISOString() })
          .eq('id', conversation.id);
        conversation.unread_for_user = 0;
      }
      const messages = await messagesFor(supabase, conversation.id);
      const profile = await loadProfile(supabase, req.userId);
      return res.json({
        conversation: publicConversation(conversation, profile),
        messages: messages.map(publicMessage),
      });
    } catch (error) {
      console.error('GET /support/chat error:', error);
      return res.status(500).json({ error: 'Failed to load support chat', details: error.message });
    }
  });

  app.post('/support/chat/messages', requireAuth, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const role = cleanRole(req.body?.role);
      const body = cleanBody(req.body?.message);
      if (!role) return res.status(400).json({ error: 'role must be customer, merchant, or courier' });
      if (!body) return res.status(400).json({ error: 'Message is required' });

      let conversation = await openConversation(supabase, req.userId, role);
      if (!conversation) conversation = await createConversation(supabase, req.userId, role);

      const now = new Date().toISOString();
      const { error: userError } = await supabase.from('support_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'user',
        sender_role: role,
        body,
      });
      if (userError) throw new Error(userError.message || 'Failed to send message');

      const withAgent = conversation.status === 'waiting_agent' || conversation.status === 'with_agent';
      let botText = null;

      if (!withAgent) {
        const history = await messagesFor(supabase, conversation.id);
        const prior = history.slice(0, -1);
        const lastBot = [...prior].reverse().find((row) => row.sender_type === 'bot');
        const offered = Boolean(
          lastBot?.body &&
            /pass this chat to the team|handing the chat|talk to an agent|connect you/i.test(lastBot.body),
        );
        const orders = await recentOrders(supabase, req.userId, role);
        const reply = await botReply({
          text: body,
          role,
          orders,
          history: prior,
          lastBotOfferedAgent: offered,
        });
        botText = reply.text;
        const { error: botError } = await supabase.from('support_messages').insert({
          conversation_id: conversation.id,
          sender_type: 'bot',
          sender_role: 'bot',
          body: reply.text,
        });
        if (botError) throw new Error(botError.message || 'Failed to reply');

        const patch = {
          last_message_at: now,
          last_message_preview: reply.text.slice(0, 140),
          updated_at: now,
          unread_for_user: 0,
        };
        if (reply.escalate) {
          patch.status = 'waiting_agent';
          patch.escalated_at = now;
          patch.unread_for_staff = (conversation.unread_for_staff || 0) + 1;
        }
        await supabase.from('support_conversations').update(patch).eq('id', conversation.id);
        conversation = { ...conversation, ...patch };
      } else {
        const patch = {
          last_message_at: now,
          last_message_preview: body.slice(0, 140),
          updated_at: now,
          unread_for_staff: (conversation.unread_for_staff || 0) + 1,
          unread_for_user: 0,
        };
        await supabase.from('support_conversations').update(patch).eq('id', conversation.id);
        conversation = { ...conversation, ...patch };
      }

      const messages = await messagesFor(supabase, conversation.id);
      const profile = await loadProfile(supabase, req.userId);
      return res.json({
        conversation: publicConversation(conversation, profile),
        messages: messages.map(publicMessage),
        botReply: botText,
      });
    } catch (error) {
      console.error('POST /support/chat/messages error:', error);
      return res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
  });

  app.get('/admin/support/conversations', requireAdmin, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const { data, error } = await supabase
        .from('support_conversations')
        .select('*')
        .neq('status', 'closed')
        .order('last_message_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message || 'Failed to load chats');

      const rows = data || [];
      const userIds = [...new Set(rows.map((row) => row.user_id))];
      let profiles = [];
      if (userIds.length) {
        const { data: people } = await supabase
          .from('user_profiles')
          .select('id, full_name, phone, email')
          .in('id', userIds);
        profiles = people || [];
      }
      const byId = new Map(profiles.map((person) => [person.id, person]));
      const conversations = rows
        .map((row) => publicConversation(row, byId.get(row.user_id)))
        .sort((a, b) => {
          const rank = (item) => (item.status === 'waiting_agent' || item.unreadForStaff > 0 ? 0 : 1);
          return rank(a) - rank(b) || String(b.lastMessageAt).localeCompare(String(a.lastMessageAt));
        });
      const waitingCount = conversations.filter(
        (item) => item.status === 'waiting_agent' || item.unreadForStaff > 0,
      ).length;
      return res.json({ conversations, waitingCount });
    } catch (error) {
      console.error('GET /admin/support/conversations error:', error);
      return res.status(500).json({ error: 'Failed to load support chats', details: error.message });
    }
  });

  app.get('/admin/support/conversations/:id', requireAdmin, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const { data, error } = await supabase
        .from('support_conversations')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message || 'Failed to load chat');
      if (!data) return res.status(404).json({ error: 'Chat not found' });

      if (data.unread_for_staff) {
        await supabase
          .from('support_conversations')
          .update({ unread_for_staff: 0, updated_at: new Date().toISOString() })
          .eq('id', data.id);
        data.unread_for_staff = 0;
      }
      const [messages, profile] = await Promise.all([
        messagesFor(supabase, data.id),
        loadProfile(supabase, data.user_id),
      ]);
      return res.json({
        conversation: publicConversation(data, profile),
        messages: messages.map((row) => ({
          ...publicMessage(row),
          senderLabel:
            row.sender_type === 'user'
              ? profile?.full_name || 'User'
              : publicMessage(row).senderLabel,
        })),
      });
    } catch (error) {
      console.error('GET /admin/support/conversations/:id error:', error);
      return res.status(500).json({ error: 'Failed to load chat', details: error.message });
    }
  });

  app.post('/admin/support/conversations/:id/messages', requireAdmin, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const body = cleanBody(req.body?.message);
      if (!body) return res.status(400).json({ error: 'Message is required' });

      const { data, error } = await supabase
        .from('support_conversations')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message || 'Failed to load chat');
      if (!data) return res.status(404).json({ error: 'Chat not found' });

      const now = new Date().toISOString();
      const { error: insertError } = await supabase.from('support_messages').insert({
        conversation_id: data.id,
        sender_type: 'agent',
        sender_role: req.dashboardRole || 'admin',
        body,
      });
      if (insertError) throw new Error(insertError.message || 'Failed to send reply');

      await supabase
        .from('support_conversations')
        .update({
          status: 'with_agent',
          assigned_role: req.dashboardRole || 'admin',
          last_message_at: now,
          last_message_preview: body.slice(0, 140),
          unread_for_user: (data.unread_for_user || 0) + 1,
          unread_for_staff: 0,
          updated_at: now,
        })
        .eq('id', data.id);

      const [messages, profile, fresh] = await Promise.all([
        messagesFor(supabase, data.id),
        loadProfile(supabase, data.user_id),
        supabase.from('support_conversations').select('*').eq('id', data.id).single(),
      ]);
      return res.json({
        conversation: publicConversation(fresh.data || data, profile),
        messages: messages.map((row) => ({
          ...publicMessage(row),
          senderLabel: row.sender_type === 'user' ? profile?.full_name || 'User' : publicMessage(row).senderLabel,
        })),
      });
    } catch (error) {
      console.error('POST /admin/support/conversations/:id/messages error:', error);
      return res.status(500).json({ error: 'Failed to send reply', details: error.message });
    }
  });

  app.post('/support/chat/end', requireAuth, async (req, res) => {
    try {
      if (!supabase) throw new Error('Server not configured');
      const role = cleanRole(req.body?.role);
      if (!role) return res.status(400).json({ error: 'role must be customer, merchant, or courier' });

      const conversation = await openConversation(supabase, req.userId, role);
      if (!conversation) return res.json({ ended: true });

      const now = new Date().toISOString();
      const closing = 'This chat has ended. Open the chat again whenever you need help.';
      await supabase.from('support_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        sender_role: 'bot',
        body: closing,
      });
      await supabase
        .from('support_conversations')
        .update({
          status: 'closed',
          last_message_at: now,
          last_message_preview: 'Chat ended',
          unread_for_staff: 0,
          unread_for_user: 0,
          updated_at: now,
        })
        .eq('id', conversation.id);

      return res.json({ ended: true });
    } catch (error) {
      console.error('POST /support/chat/end error:', error);
      return res.status(500).json({ error: 'Failed to end chat', details: error.message });
    }
  });
}
