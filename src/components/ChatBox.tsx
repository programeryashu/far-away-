import React, { useState, useEffect, useRef } from 'react';
import { Send, MessageSquare, CheckCheck } from 'lucide-react';
import type { Connection } from '../lib/connection';
import { mergeMessages, serverMessagesToClient } from '../lib/reconcile';

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
}

interface Message {
  id: string;
  /** Server-assigned id, adopted when the ack for a locally-sent message arrives. */
  serverId?: string;
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
  hasPeer
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
  // swaps our local id for the server id. Both transports deliver the same
  // typed envelopes, so this one handler covers local and remote.
  useEffect(() => {
    return connection.onEvent((env) => {
      if (env.event === 'chat') {
        const inbound: Message = {
          id: env.payload.id,
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
        setMessages((prev) => mergeMessages(prev, serverMessagesToClient(env.payload.messages)));
      }
    });
  }, [connection]);

  // Haversine distance
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const distance = calculateDistance(cityA.lat, cityA.lng, cityB.lat, cityB.lng);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const userMsgId = nextMessageId();
    const newMessage: Message = {
      id: userMsgId,
      sender: ownName,
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
          text: replyText,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'delivered'
        }
      ]);
    }, 1200);
  };

  return (
    <div id="chat-box" className="glass-panel" style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
      {/* Header */}
      <div
        className="flex-between"
        style={{
          borderBottom: '1px solid var(--border-glass)',
          paddingBottom: '12px',
          marginBottom: '12px'
        }}
      >
        <div>
          <h3 style={{ fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <MessageSquare size={16} color="var(--text-secondary)" />
            Chat
          </h3>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Messages sync over the {connection.mode === 'remote' ? 'session' : 'local'} channel
          </span>
        </div>
      </div>

      {/* Messages area */}
      <div
        style={{
          flexGrow: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          paddingRight: '6px',
          marginBottom: '16px'
        }}
      >
        {messages.map((msg) => {
          const isMe = msg.sender === ownName;
          return (
            <div
              key={msg.id}
              style={{
                alignSelf: isMe ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: isMe ? 'flex-end' : 'flex-start'
              }}
            >
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                {msg.sender}
              </span>
              <div
                style={{
                  background: isMe ? 'var(--primary)' : 'rgba(255, 255, 255, 0.04)',
                  border: isMe ? 'none' : '1px solid var(--border-glass)',
                  padding: '10px 14px',
                  borderRadius: isMe ? '14px 14px 2px 14px' : '14px 14px 14px 2px',
                  color: 'white',
                  fontSize: '14px',
                  lineHeight: '1.4'
                }}
              >
                {msg.text}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{msg.timestamp}</span>
                {isMe && (
                  <span style={{ display: 'flex', alignItems: 'center' }}>
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
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      {/* Input area */}
      <form onSubmit={handleSend} style={{ display: 'flex', gap: '10px' }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={`Message ${peerName}...`}
          aria-label={`Message ${peerName}`}
          style={{ flexGrow: 1 }}
        />
        <button type="submit" className="btn btn-primary" style={{ padding: '0 16px' }} aria-label="Send message">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};
