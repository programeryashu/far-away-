import React, { useState, useEffect, useRef } from 'react';
import { Send, Cpu, Globe, CheckCheck } from 'lucide-react';
import type { OrbitSync } from '../lib/broadcast';

// Module-level monotonic counter for message IDs (avoids Date.now() in render/event closures).
// The random suffix keeps IDs unique across two tabs on the same origin.
let messageIdCounter = 0;
const nextMessageId = () => `msg-${++messageIdCounter}-${Math.random().toString(36).slice(2, 6)}`;

interface ChatBoxProps {
  cityA: { name: string; lat: number; lng: number; timezone: string };
  cityB: { name: string; lat: number; lng: number; timezone: string };
  nameA: string;
  nameB: string;
  /** Live-tab sync channel; null when BroadcastChannel is unavailable. */
  sync: OrbitSync | null;
  /** True when a second tab is connected right now. */
  hasPeer: boolean;
}

interface Message {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'routing' | 'delivered';
  route?: string;
}

export const ChatBox: React.FC<ChatBoxProps> = ({
  cityA,
  cityB,
  nameA,
  nameB,
  sync,
  hasPeer
}) => {
  // This tab is one of the two people: the host tab is User A, the remote tab
  // is User B. Messages from my own side align right; the peer's align left.
  const ownSide = sync?.side ?? 'host';
  const ownName = ownSide === 'host' ? nameA || 'User A' : nameB || 'User B';
  const peerName = ownSide === 'host' ? nameB || 'User B' : nameA || 'User A';

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
  const [routingStatus, setRoutingStatus] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom whenever messages list grows
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Inbound chat from a real second tab — arrive as delivered, never auto-reply.
  useEffect(() => {
    if (!sync) return;
    return sync.onMessage((msg) => {
      if (msg.type !== 'chat') return;
      setMessages((prev) => [
        ...prev,
        {
          id: msg.payload.id,
          sender: msg.payload.sender,
          text: msg.payload.text,
          timestamp: msg.payload.timestamp,
          status: 'delivered'
        }
      ]);
    });
  }, [sync]);

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
  
  // Calculate simulated route path
  const getSimulatedRoute = (dist: number) => {
    if (dist < 500) return 'Direct terrestrial fiber';
    if (dist < 3000) return 'Undersea fiber segment -> Regional datacenter';
    if (dist < 8000) return 'Undersea transatlantic fiber -> Edge node gateway';
    return 'Trans-Pacific fiber backbone -> Starlink constellation hop';
  };

  const routeDescription = getSimulatedRoute(distance);

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

    // Send to the real second tab when one is connected.
    sync?.sendChat({
      id: userMsgId,
      sender: ownName,
      text: inputText,
      timestamp: newMessage.timestamp
    });

    // Trigger Transit routing animation simulation
    setRoutingStatus('Routing...');

    // Step 1: Simulated ocean crossing
    setTimeout(() => {
      setMessages(prev =>
        prev.map(m => (m.id === userMsgId ? { ...m, status: 'routing', route: routeDescription } : m))
      );
      setRoutingStatus(`Traversing: ${routeDescription}`);
    }, 600);

    // Step 2: Delivered
    setTimeout(() => {
      setMessages(prev =>
        prev.map(m => (m.id === userMsgId ? { ...m, status: 'delivered' } : m))
      );
      setRoutingStatus(null);

      // Step 3: Auto partner reply is only the offline fallback — a real
      // second tab answers for itself over the channel.
      if (!hasPeer) simulatePartnerReply();
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
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', height: '400px' }}>
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
          <h3 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe size={18} color="var(--primary)" />
            Sub-orbital Chat
          </h3>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Routing Path: <strong style={{ color: 'var(--text-secondary)' }}>{routeDescription}</strong>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Cpu size={14} color="var(--accent)" />
          <span style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>Active Route</span>
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
                  background: isMe
                    ? 'linear-gradient(135deg, var(--primary), #4f46e5)'
                    : 'rgba(255, 255, 255, 0.04)',
                  border: isMe ? 'none' : '1px solid var(--border-glass)',
                  padding: '10px 14px',
                  borderRadius: isMe ? '16px 16px 2px 16px' : '16px 16px 16px 2px',
                  color: 'white',
                  fontSize: '14px',
                  lineHeight: '1.4',
                  boxShadow: isMe ? '0 4px 10px rgba(99, 102, 241, 0.2)' : 'none'
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
                          background: msg.status === 'sending' ? 'var(--primary)' : 'var(--secondary)',
                          display: 'inline-block',
                          animation: 'pulse-glow 0.8s infinite ease-in-out'
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
      <form onSubmit={handleSend} style={{ display: 'flex', gap: '10px', position: 'relative' }}>
        {routingStatus && (
          <div
            style={{
              position: 'absolute',
              top: '-32px',
              left: 0,
              right: 0,
              background: 'rgba(7, 9, 19, 0.9)',
              border: '1px solid var(--border-glow)',
              borderRadius: '4px',
              padding: '4px 10px',
              fontSize: '11px',
              color: 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              animation: 'pulse-glow 1s infinite'
            }}
          >
            {routingStatus}
          </div>
        )}
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
