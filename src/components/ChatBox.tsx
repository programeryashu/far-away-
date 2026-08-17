import React, { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare, CheckCheck } from 'lucide-react';
import type { Connection } from '../lib/connection';
import { mergeMessages, serverMessagesToClient } from '../lib/reconcile';
import { haversineKm } from '../lib/geo';

// Module-level monotonic counter for message IDs (avoids Date.now() in render/event closures).
// The random suffix keeps IDs unique across two tabs on the same origin.
let messageIdCounter = 0;
const nextMessageId = () => `msg-${++messageIdCounter}-${Math.random().toString(36).slice(2, 6)}`;

interface ChatBoxProps {
  cityA: { name: string; lat: number; lng: number; timezone: string };
  cityB: { name: string; lat: number; lng: number; timezone: string };
  nameA: string;
  nameB: string;
  /** Active transport (BroadcastChannel locally, WebSocket in a session). */
  connection: Connection;
  /** True when a second peer is connected right now. */
  hasPeer: boolean;
  /**
   * This client's server peerId ('' in local mode). "Is me" is decided by
   * peerId, never by display name — two peers may share a name.
   */
  myPeerId: string;
}

interface Message {
  id: string;
  /** Server-assigned id, adopted when the ack for a locally-sent message arrives. */
  serverId?: string;
  /** Author's server peerId ('' when unknown, e.g. local-mode peers). */
  peerId?: string;
  /** True for messages this client sent — the alignment source of truth. */
  own?: boolean;
  /** True for local solo-mode preview replies — always labeled as such. */
  simulated?: boolean;
  sender: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'delivered';
}

export const ChatBox: React.FC<ChatBoxProps> = ({
  cityA,
  cityB,
  nameA,
  nameB,
  connection,
  hasPeer,
  myPeerId
}) => {
  // This tab is one of the two people; the connection knows which side is
  // mine (tab side locally, server role in a session). Messages from my own
  // side align right; the peer's align left.
  const ownIsA = connection.role === 'a';
  const ownName = ownIsA ? nameA || 'User A' : nameB || 'User B';
  const peerName = ownIsA ? nameB || 'User B' : nameA || 'User A';

  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: peerName,
      simulated: true,
      text: `Hey! Set up your location so we can calculate our orbital connection map.`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'delivered'
    }
  ]);
  const [inputText, setInputText] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom whenever messages list grows
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Inbound chat from a real peer — arrive as delivered, never auto-reply.
  // Dedupe by id so history and live broadcasts never duplicate; the ack
  // swaps our local id for the server id. "Own" is decided by peerId: an
  // echo of our own server id (a reconnect replay) still aligns right even
  // when both peers share a display name. Both transports deliver the same
  // typed envelopes, so this one handler covers local and remote.
  useEffect(() => {
    return connection.onEvent((env) => {
      if (env.event === 'chat') {
        const inbound: Message = {
          id: env.payload.id,
          peerId: env.payload.peerId,
          own: env.payload.peerId !== '' && env.payload.peerId === myPeerId,
          sender: env.payload.sender || 'Peer',
          text: env.payload.text,
          timestamp: new Date(env.payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'delivered'
        };
        setMessages((prev) => mergeMessages(prev, [inbound]));
      } else if (env.event === 'ack') {
        if (env.payload.refId && env.payload.id) {
          setMessages((prev) =>
            prev.map((m) => (m.id === env.payload.refId ? { ...m, serverId: env.payload.id } : m))
          );
        }
      } else if (env.event === 'state') {
        const history = serverMessagesToClient(env.payload.messages).map((m) => ({
          ...m,
          peerId: env.payload.messages.find((row) => row.id === m.id)?.sender_peer,
          own: env.payload.messages.some((row) => row.id === m.id && row.sender_peer !== '' && row.sender_peer === myPeerId),
        }));
        setMessages((prev) => mergeMessages(prev, history));
      }
    });
  }, [connection, myPeerId]);

  const distance = haversineKm(cityA.lat, cityA.lng, cityB.lat, cityB.lng);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const userMsgId = nextMessageId();
    const newMessage: Message = {
      id: userMsgId,
      sender: ownName,
      own: true,
      text: inputText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'sending'
    };

    setMessages(prev => [...prev, newMessage]);
    setInputText('');

    connection.send('chat', {
      id: userMsgId,
      sender: ownName,
      text: inputText
    });

    // Delivered once the transport has accepted it. In a session the server
    // ack swaps the local id for the server id; solo local mode falls back to
    // this timeout. The auto partner reply is the offline fallback for local
    // solo mode only — a real peer (any transport) answers for itself.
    setTimeout(() => {
      setMessages(prev =>
        prev.map(m => (m.id === userMsgId ? { ...m, status: 'delivered' } : m))
      );
      if (!hasPeer && connection.mode === 'local') simulatePartnerReply();
    }, 1500);
  };

  // Automatic contextual reply based on timezone status
  const simulatePartnerReply = () => {
    setTimeout(() => {
      // Determine partner local hour (defensive: an invalid zone must not break the reply)
      const partnerHour = (() => {
        try {
          return parseInt(
            new Intl.DateTimeFormat('en-US', { timeZone: cityB.timezone, hour: 'numeric', hour12: false }).format(new Date()),
            10
          );
        } catch {
          return -1;
        }
      })();

      let replyText = '';
      if (partnerHour === -1) {
        const replies = [
          `Hey! Got your message across the ${distance.toFixed(0)} km bridge. That traveled fast!`,
          `Connected across ${distance.toFixed(0)} km! Pretty cool interface, isn't it?`
        ];
        replyText = replies[Math.floor(Math.random() * replies.length)];
      } else if (partnerHour >= 23 || partnerHour < 7) {
        const replies = [
          `😴 Zzz... My phone is in Sleep Focus Mode in ${cityB.name}. Talk to you when it's morning!`,
          `Sleeping now! This was sent as an auto-queued message across the ${distance.toFixed(0)} km bridge.`
        ];
        replyText = replies[Math.floor(Math.random() * replies.length)];
      } else if (partnerHour >= 9 && partnerHour < 17) {
        const replies = [
          `💼 In a work meeting here in ${cityB.name}! Message delivered safely. I'll read this at lunch!`,
          `Got your ping! A bit busy at the moment, but sending you good vibes from afar!`
        ];
        replyText = replies[Math.floor(Math.random() * replies.length)];
      } else {
        const replies = [
          `Hey! Got your message instantly here in ${cityB.name}. That traveled fast!`,
          `What are we up to? Should we open up the SynchroCinema or Galactic Canvas?`,
          `Connected across ${distance.toFixed(0)} km! Pretty cool interface, isn't it?`
        ];
        replyText = replies[Math.floor(Math.random() * replies.length)];
      }

      setMessages(prev => [
        ...prev,
        {
          id: nextMessageId(),
          sender: peerName,
          simulated: true,
          text: replyText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'delivered'
        }
      ]);
    }, 1200);
  };

  return (
    <div id="chat-box" className="glass-panel" style={{ display: 'flex', flexDirection: 'column', height: '420px', maxHeight: '70vh' }}>
      {/* Header */}
      <div
        className="flex-between"
        style={{
          borderBottom: '1px solid var(--border-glass)',
          paddingBottom: 'var(--space-3)',
          marginBottom: 'var(--space-3)'
        }}
      >
        <div>
          <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
            <MessageSquare size={15} color="var(--text-secondary)" />
            Conversation
          </h3>
          <span style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
            {hasPeer
              ? 'live with your peer'
              : connection.mode === 'remote'
                ? 'messages deliver when they rejoin'
                : 'solo: open a second tab or share a connection'}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div
        className="chat-log"
        style={{
          flexGrow: 1,
          overflowY: 'auto',
          paddingRight: '6px',
          marginBottom: 'var(--space-4)'
        }}
        aria-live="polite"
        aria-label="Messages"
      >
        {messages.length === 0 && (
          <div className="chat-empty">
            No messages yet. Say hi when you're both around.
          </div>
        )}
        {messages.map((msg) => {
          // Alignment comes from ownership (peerId decided at receive/send
          // time), never from comparing display names.
          const isMe = msg.own === true;
          return (
            <div key={msg.id} className={`chat-message ${isMe ? 'own' : 'peer'}`}>
              <span className="chat-meta">
                {msg.simulated && <span className="chat-sim-tag">simulated</span>}
                {msg.sender} · {msg.timestamp}
              </span>
              <div className="chat-bubble">{msg.text}</div>
              {isMe && (
                <span style={{ display: 'inline-flex', alignItems: 'center', marginTop: '3px' }}>
                  {msg.status === 'delivered' ? (
                    <CheckCheck size={12} color="var(--accent)" />
                  ) : (
                    <span
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: 'var(--text-muted)',
                        display: 'inline-block'
                      }}
                    />
                  )}
                </span>
              )}
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={`Message ${peerName}…`}
          aria-label={`Message ${peerName}`}
          style={{ flexGrow: 1, minWidth: 0 }}
        />
        <button type="submit" className="btn btn-primary" style={{ padding: '0 16px' }} aria-label="Send message">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};
