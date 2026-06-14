import React from 'react';
import { Globe } from 'lucide-react';

interface DistanceVisualizerProps {
  cityA: { name: string; country: string; lat: number; lng: number };
  cityB: { name: string; country: string; lat: number; lng: number };
  nameA: string;
  nameB: string;
}

export const DistanceVisualizer: React.FC<DistanceVisualizerProps> = ({
  cityA,
  cityB,
  nameA,
  nameB
}) => {
  // Haversine formula
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Radius of the Earth in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const distance = calculateDistance(cityA.lat, cityA.lng, cityB.lat, cityB.lng);
  
  // Speed of light in fiber optic glass is approx 200,000 km/s (200 km per millisecond)
  const fiberLatency = distance / 200; 
  // Radio waves through Starlink/satellite vacuum is approx 300,000 km/s (300 km per millisecond)
  const starlinkLatency = (distance / 300) + 15; // 15ms overhead for uplink/downlink

  return (
    <div className="glass-panel full-width" style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Visual background grid */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundImage: 'radial-gradient(var(--border-glass) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
          opacity: 0.3,
          pointerEvents: 'none'
        }}
      ></div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', position: 'relative', zIndex: 1 }}>
        <div className="flex-between">
          <h2 style={{ fontSize: '22px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Globe size={24} className="animate-pulse-glow" color="var(--primary)" />
            Orbital Distance Matrix
          </h2>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
            GEO-CALC v1.0.4
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
            gap: '24px',
            textAlign: 'center'
          }}
        >
          {/* Node A */}
          <div
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(99, 102, 241, 0.05)',
              border: '1px solid rgba(99, 102, 241, 0.15)'
            }}
          >
            <h4 style={{ fontSize: '18px', color: 'var(--primary)' }}>{nameA || 'User A'}</h4>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '4px', fontWeight: 600 }}>
              {cityA.name}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{cityA.country}</p>
          </div>

          {/* Connection Stats */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                padding: '4px 16px',
                borderRadius: '9999px',
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase'
              }}
            >
              Physical Separation
            </div>
            <div style={{ fontSize: '36px', fontWeight: 800, color: 'white', letterSpacing: '-0.03em' }}>
              {distance.toLocaleString(undefined, { maximumFractionDigits: 1 })} <span style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-secondary)' }}>km</span>
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
              ({(distance * 0.621371).toLocaleString(undefined, { maximumFractionDigits: 1 })} miles)
            </div>
          </div>

          {/* Node B */}
          <div
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(236, 72, 153, 0.05)',
              border: '1px solid rgba(236, 72, 153, 0.15)'
            }}
          >
            <h4 style={{ fontSize: '18px', color: 'var(--secondary)' }}>{nameB || 'User B'}</h4>
            <p style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '4px', fontWeight: 600 }}>
              {cityB.name}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{cityB.country}</p>
          </div>
        </div>

        {/* SVG Curved Connection Map */}
        <div
          style={{
            width: '100%',
            height: '180px',
            background: 'rgba(7, 9, 19, 0.6)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-glass)',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 800 200" preserveAspectRatio="none" style={{ position: 'absolute', top: 0, left: 0 }}>
            <defs>
              <linearGradient id="gradient-line" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="var(--primary)" />
                <stop offset="50%" stopColor="#c084fc" />
                <stop offset="100%" stopColor="var(--secondary)" />
              </linearGradient>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            
            {/* Draw a grid-like curve mapping connection */}
            <path
              d="M 100 120 Q 400 20 700 120"
              fill="none"
              stroke="rgba(255,255,255,0.03)"
              strokeWidth="12"
              strokeLinecap="round"
            />
            
            {/* Base Connection Line */}
            <path
              d="M 100 120 Q 400 20 700 120"
              fill="none"
              stroke="url(#gradient-line)"
              strokeWidth="2.5"
              strokeLinecap="round"
              filter="url(#glow)"
              style={{ opacity: 0.8 }}
            />

            {/* Glowing signal particles flying from Left to Right */}
            <path
              d="M 100 120 Q 400 20 700 120"
              fill="none"
              stroke="#67e8f9"
              strokeWidth="3.5"
              strokeDasharray="10 110"
              strokeLinecap="round"
              style={{
                animation: 'dash 3s linear infinite'
              }}
            />

            {/* Glowing signal particles flying from Right to Left */}
            <path
              d="M 700 120 Q 400 20 100 120"
              fill="none"
              stroke="#f472b6"
              strokeWidth="3.5"
              strokeDasharray="15 150"
              strokeLinecap="round"
              style={{
                animation: 'dash 2.5s linear infinite'
              }}
            />

            {/* Node markers */}
            <circle cx="100" cy="120" r="8" fill="var(--primary)" filter="url(#glow)" />
            <circle cx="100" cy="120" r="3" fill="white" />
            
            <circle cx="700" cy="120" r="8" fill="var(--secondary)" filter="url(#glow)" />
            <circle cx="700" cy="120" r="3" fill="white" />
          </svg>
          
          <div style={{ position: 'absolute', bottom: '16px', display: 'flex', gap: '30px' }}>
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block' }}>
                Fiber Optic Latency
              </span>
              <span style={{ fontSize: '16px', color: 'var(--accent)', fontWeight: 600, fontFamily: 'monospace' }}>
                ~{fiberLatency.toFixed(1)} ms
              </span>
            </div>
            <div style={{ textAlign: 'center', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '30px' }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block' }}>
                Starlink Ping
              </span>
              <span style={{ fontSize: '16px', color: 'var(--secondary)', fontWeight: 600, fontFamily: 'monospace' }}>
                ~{starlinkLatency.toFixed(1)} ms
              </span>
            </div>
          </div>
        </div>
      </div>
      
      {/* Inline styles for connection dash animation */}
      <style>{`
        @keyframes dash {
          to {
            stroke-dashoffset: -360;
          }
        }
      `}</style>
    </div>
  );
};
