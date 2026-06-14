import React, { useState, useRef } from 'react';
import { Sparkles, Video, Paintbrush, Coffee, Play, Pause, RotateCcw, X, Users } from 'lucide-react';

interface ActivityFinderProps {
  nameA: string;
  nameB: string;
}

interface Activity {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  category: 'watch' | 'play' | 'talk';
  suitability: 'High' | 'Medium' | 'Low';
}

export const ActivityFinder: React.FC<ActivityFinderProps> = ({
  nameA,
  nameB
}) => {
  const [activeModal, setActiveModal] = useState<string | null>(null);

  // SynchroCinema State
  const [isPlaying, setIsPlaying] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Synced');
  const [cinemaLogs, setCinemaLogs] = useState<string[]>(['Session initialized']);
  
  // Canvas State
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [canvasLogs, setCanvasLogs] = useState<string[]>([]);
  const [partnerDrawing, setPartnerDrawing] = useState(false);

  // Activity list
  const activities: Activity[] = [
    {
      id: 'cinema',
      title: 'SynchroCinema',
      desc: 'Watch movies, shows, or trailers with perfectly synchronized playback and reaction logs.',
      icon: <Video size={20} color="var(--primary)" />,
      category: 'watch',
      suitability: 'High'
    },
    {
      id: 'canvas',
      title: 'Galactic Canvas',
      desc: 'A shared whiteboard space. Sketch together across orbits, featuring real-time response ticks.',
      icon: <Paintbrush size={20} color="var(--secondary)" />,
      category: 'play',
      suitability: 'High'
    },
    {
      id: 'cafe',
      title: 'Deep Space Coffee',
      desc: 'Ambient cafe noise generator mixed with shared timers for reading, coding, or studying.',
      icon: <Coffee size={20} color="var(--accent)" />,
      category: 'talk',
      suitability: 'Medium'
    }
  ];

  // ------------------------------------
  // Cinema Simulation logic
  // ------------------------------------
  const handleCinemaToggle = () => {
    const nextState = !isPlaying;
    setIsPlaying(nextState);
    setSyncStatus('Syncing...');
    
    // Add user action log
    const userLog = `${nameA || 'User A'} ${nextState ? 'pressed PLAY' : 'pressed PAUSE'}`;
    setCinemaLogs(prev => [userLog, ...prev]);

    setTimeout(() => {
      setSyncStatus('Synced');
      // Simulate remote sync acknowledgment
      const partnerName = nameB || 'User B';
      const partnerLog = `${partnerName} synced to playback at 02:45`;
      setCinemaLogs(prev => [partnerLog, ...prev]);
    }, 1000);
  };

  // ------------------------------------
  // Canvas Drawing logic
  // ------------------------------------
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.8)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    
    // Trigger simulated partner drawing after 1.5s
    if (canvasLogs.length === 0) {
      setPartnerDrawing(true);
      setCanvasLogs(prev => [`${nameB || 'User B'} is drawing back...`, ...prev]);
      
      setTimeout(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Auto draw a small glowing star or heart
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.8)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        
        // Draw a heart
        const startX = 250;
        const startY = 100;
        ctx.moveTo(startX, startY);
        // Left curve
        ctx.bezierCurveTo(startX - 20, startY - 20, startX - 40, startY + 10, startX, startY + 40);
        // Right curve
        ctx.moveTo(startX, startY);
        ctx.bezierCurveTo(startX + 20, startY - 20, startX + 40, startY + 10, startX, startY + 40);
        ctx.stroke();

        setPartnerDrawing(false);
        setCanvasLogs(prev => [`${nameB || 'User B'} drew a glowing heart! ❤️`, ...prev]);
      }, 1500);
    }
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setCanvasLogs([]);
  };

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Sparkles size={22} color="var(--secondary)" />
        Synchronized Shared Experiences
      </h2>
      <p style={{ fontSize: '14px' }}>
        Trigger direct connection points that bridge spatial boundaries using interactive simulation.
      </p>

      {/* Activities Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
        {activities.map((act) => (
          <div
            key={act.id}
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-glass)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'var(--transition-smooth)'
            }}
          >
            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {act.icon}
                <h4 style={{ fontSize: '16px', color: 'white' }}>{act.title}</h4>
              </div>
              <span className="badge badge-primary" style={{ fontSize: '10px' }}>
                Fit: {act.suitability}
              </span>
            </div>
            <p style={{ fontSize: '13px' }}>{act.desc}</p>
            <button
              onClick={() => setActiveModal(act.id)}
              className="btn btn-outline"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: '13px',
                marginTop: '4px'
              }}
            >
              Initialize Session
            </button>
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------- */}
      {/* SynchroCinema Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cinema' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px'
          }}
        >
          <div
            className="glass-panel"
            style={{
              maxWidth: '600px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: '0 25px 50px -12px rgba(99,102,241,0.5)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Video size={20} color="var(--primary)" />
                SynchroCinema Control Center
              </h3>
              <button
                onClick={() => {
                  setActiveModal(null);
                  setIsPlaying(false);
                }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Video Player Mockup */}
            <div
              style={{
                width: '100%',
                height: '240px',
                background: '#04060f',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-glass)',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden'
              }}
            >
              {/* Fake Video Content */}
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  backgroundImage: 'linear-gradient(to bottom, #111827, #030712)',
                  opacity: 0.8,
                  zIndex: 0
                }}
              ></div>

              {/* Glowing Nebula Visuals when playing */}
              {isPlaying && (
                <div
                  className="animate-pulse-glow"
                  style={{
                    position: 'absolute',
                    width: '180px',
                    height: '180px',
                    borderRadius: '50%',
                    background: 'radial-gradient(circle, rgba(99,102,241,0.4) 0%, transparent 70%)',
                    zIndex: 1
                  }}
                ></div>
              )}

              <div style={{ zIndex: 2, textAlign: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>
                  NOW STREAMING
                </span>
                <h4 style={{ fontSize: '18px', marginBottom: '16px' }}>Exploring the Far Reaches (Trailer)</h4>
                
                <button
                  onClick={handleCinemaToggle}
                  className="btn btn-primary"
                  style={{
                    borderRadius: '50%',
                    width: '60px',
                    height: '60px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0
                  }}
                >
                  {isPlaying ? <Pause size={24} /> : <Play size={24} style={{ marginLeft: '4px' }} />}
                </button>
              </div>

              {/* Player bar */}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  padding: '12px',
                  background: 'rgba(0,0,0,0.6)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  zIndex: 2
                }}
              >
                <span style={{ fontSize: '11px', fontFamily: 'monospace' }}>02:45 / 03:00</span>
                <span style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Users size={12} /> Sync Status: <span style={{ color: 'var(--accent)' }}>{syncStatus}</span>
                </span>
              </div>
            </div>

            {/* Sync logs */}
            <div>
              <label>Connection Activity Logs</label>
              <div
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-sm)',
                  height: '100px',
                  overflowY: 'auto',
                  padding: '10px',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
              >
                {cinemaLogs.map((log, idx) => (
                  <div key={idx} style={{ color: idx === 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                    &gt; {log}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Galactic Canvas Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'canvas' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px'
          }}
        >
          <div
            className="glass-panel"
            style={{
              maxWidth: '540px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: '0 25px 50px -12px rgba(236,72,153,0.5)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Paintbrush size={20} color="var(--secondary)" />
                Galactic Canvas Collaboration
              </h3>
              <button
                onClick={() => setActiveModal(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Drawing Board */}
            <div style={{ position: 'relative' }}>
              <canvas
                ref={canvasRef}
                width={500}
                height={260}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                style={{
                  background: '#04060f',
                  border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-md)',
                  width: '100%',
                  height: '260px',
                  cursor: 'crosshair',
                  display: 'block'
                }}
              />
              
              {partnerDrawing && (
                <div
                  style={{
                    position: 'absolute',
                    top: '12px',
                    left: '12px',
                    background: 'rgba(236,72,153,0.9)',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    animation: 'pulse-glow 1s infinite ease-in-out'
                  }}
                >
                  <Users size={10} /> {nameB || 'Partner'} is drawing...
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex-between">
              <button onClick={clearCanvas} className="btn btn-outline" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <RotateCcw size={14} /> Clear Canvas
              </button>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Draw with your mouse. Wait for response.
              </div>
            </div>

            {/* Action Log */}
            <div
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-glass)',
                borderRadius: 'var(--radius-sm)',
                height: '60px',
                overflowY: 'auto',
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: '12px'
              }}
            >
              {canvasLogs.length > 0 ? (
                canvasLogs.map((log, idx) => (
                  <div key={idx} style={{ color: 'var(--text-secondary)' }}>
                    &gt; {log}
                  </div>
                ))
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>&gt; Awaiting initial brush stroke...</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Deep Space Coffee Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cafe' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '20px'
          }}
        >
          <div
            className="glass-panel"
            style={{
              maxWidth: '440px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: '0 25px 50px -12px rgba(20,184,166,0.5)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Coffee size={20} color="var(--accent)" />
                Deep Space Cafe & Focus Timer
              </h3>
              <button
                onClick={() => setActiveModal(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '48px', fontWeight: 800, fontFamily: 'monospace', letterSpacing: '0.05em' }}>
                25:00
              </div>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginTop: '6px' }}>
                SHARED POMODORO SESSION
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label>Shared Ambient Soundscape</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <button className="btn btn-outline" style={{ justifyContent: 'start', fontSize: '12px' }}>
                  ☕ Cosmic Cafe: <span style={{ color: 'var(--accent)' }}>Active</span>
                </button>
                <button className="btn btn-outline" style={{ justifyContent: 'start', fontSize: '12px', opacity: 0.6 }}>
                  🌧️ Solar Rain: Off
                </button>
              </div>
            </div>

            <button
              onClick={() => alert("Simulation note: Timer started for both users! Stays in sync via local browser ticks.")}
              className="btn btn-primary"
              style={{ width: '100%' }}
            >
              Start Shared Timer
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
